'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { CopilotAgent } = require('./agent');
const {
  AuthorizationError,
  InvoiceStore,
  NotFoundError,
  PayPalError,
  ValidationError,
  createPayPalAdapter,
  getAIProviderStatus,
  parseInvoiceTextWithMetadataAsync,
  publicInvoiceView
} = require('./core');
const { persistenceFromEnvironment } = require('./persistence');
const { loadPolicy } = require('./policy');

const VERSION = require('../package.json').version;
const MAX_BODY_BYTES = 1024 * 1024;
const INVOICE_WEBHOOK_EVENTS = new Set([
  'INVOICING.INVOICE.SENT',
  'INVOICING.INVOICE.PAID',
  'INVOICING.INVOICE.CANCELLED',
  'INVOICING.INVOICE.VOIDED',
  'INVOICING.INVOICE.REFUNDED'
]);

function buildConfig(env = process.env) {
  return {
    version: VERSION,
    port: Number(env.PORT || 3000),
    publicBaseUrl: String(env.PUBLIC_BASE_URL || '').replace(/\/$/, ''),
    demoResetSecret: String(env.DEMO_RESET_SECRET || ''),
    allowCrossOrigin: env.ALLOW_CROSS_ORIGIN === '1',
    allowWebhookSimulation: env.ALLOW_WEBHOOK_SIMULATION !== 'false',
    trustProxy: env.TRUST_PROXY === '1',
    rateLimitDisabled: env.RATE_LIMIT_DISABLED === '1',
    rateLimitWindowMs: Math.max(1000, Number(env.RATE_LIMIT_WINDOW_MS) || 60000),
    rateLimitMax: Math.max(10, Number(env.RATE_LIMIT_MAX) || 240),
    rateLimitWriteMax: Math.max(2, Number(env.RATE_LIMIT_WRITE_MAX) || 60)
  };
}

function securityHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Origin-Agent-Cluster', '?1');
  // 'unsafe-inline' is limited to styles because AG Grid's theming API injects
  // style rules at runtime. Scripts remain restricted to same-origin files.
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store' });
  response.end(body);
}

function errorPayload(error) {
  const payload = { error: { code: error.code || 'INTERNAL_ERROR', message: error.message || 'Request failed' } };
  if (error.details) payload.error.details = error.details;
  return payload;
}

function rateLimiter(config) {
  if (config.rateLimitDisabled) return { allow: () => true, remaining: () => Infinity };
  const buckets = new Map();
  let lastSweep = Date.now();
  function sweep(now) {
    if (now - lastSweep < config.rateLimitWindowMs) return;
    lastSweep = now;
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }
  }
  return {
    allow(key, { write = false } = {}) {
      const now = Date.now();
      sweep(now);
      const max = write ? config.rateLimitWriteMax : config.rateLimitMax;
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + config.rateLimitWindowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count <= max;
    },
    remaining(key) {
      const bucket = buckets.get(key);
      if (!bucket) return null;
      return Math.max(0, (bucket.resetAt - Date.now()) / 1000);
    }
  };
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    let tooLarge = false;
    const chunks = [];
    request.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (tooLarge) return reject(new ValidationError('request body is too large'));
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ValidationError('request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function mimeType(filePath) {
  return { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function serveStatic(response, publicDir, pathname, { status = 200 } = {}) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = path.resolve(publicDir);
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return false;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return false;
    const data = await fs.promises.readFile(filePath);
    response.writeHead(status, { 'Content-Type': mimeType(filePath), 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    response.end(data);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function clientIp(request, config) {
  if (config.trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) return forwarded.split(',')[0].trim();
  }
  return request.socket?.remoteAddress || 'unknown';
}

function requestBaseUrl(request, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl;
  const host = (config.trustProxy && request.headers['x-forwarded-host']) || request.headers.host;
  if (!host) return '';
  const proto = (config.trustProxy && request.headers['x-forwarded-proto']) || (request.socket?.encrypted ? 'https' : 'http');
  return `${String(proto).split(',')[0].trim()}://${host}`;
}

function sameOrigin(request, config) {
  if (config.allowCrossOrigin) return true;
  if (request.method === 'GET' || request.method === 'HEAD') return true;
  const site = request.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  const host = (config.trustProxy && request.headers['x-forwarded-host']) || request.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function aiStatus(env = process.env) {
  const ai = getAIProviderStatus({ env });
  return {
    configuredProvider: ai.configuredProvider,
    selectedProvider: ai.selectedProvider,
    mode: ai.mode,
    model: ai.model,
    fallback: ai.fallback,
    reason: ai.reason,
    configured: ai.configured
  };
}

function healthPayload(store, config, env = process.env) {
  const adapter = store.adapter?.name || 'unknown';
  const ai = aiStatus(env);
  return {
    status: 'ok',
    version: config.version,
    adapter,
    mode: adapter === 'paypal-sandbox' ? 'sandbox' : adapter === 'mock' ? 'mock' : 'custom',
    uptime: Math.round(process.uptime() * 1000) / 1000,
    serverTime: new Date().toISOString(),
    persisted: Boolean(store.persistence),
    capabilities: {
      parseInvoice: true,
      invoiceCreation: true,
      invoiceSending: true,
      reminders: true,
      cancellation: true,
      webhookSimulation: config.allowWebhookSimulation,
      paypalWebhooks: adapter === 'paypal-sandbox' && typeof store.adapter.verifyWebhookSignature === 'function',
      checkout: typeof store.adapter.createOrder === 'function' && typeof store.adapter.captureOrder === 'function',
      agentPlanner: true,
      auditChain: true,
      policyAsData: true,
      aiParsing: ai.selectedProvider !== 'deterministic'
    },
    ai
  };
}

function stateMeta(store, config, env = process.env) {
  const adapter = store.adapter.name;
  return {
    version: config.version,
    mode: adapter === 'paypal-sandbox' ? 'sandbox' : 'mock',
    adapter,
    serverTime: new Date().toISOString(),
    checkout: {
      enabled: typeof store.adapter.createOrder === 'function',
      mock: adapter === 'mock'
    },
    agent: { enabled: true, planTtlMinutes: 15 },
    audit: { chain: 'sha256' },
    policy: { version: store.policy?.version || 1, source: env.POLICY_FILE ? 'file' : 'default' },
    features: {
      webhookSimulation: config.allowWebhookSimulation,
      demoReset: true,
      persistence: Boolean(store.persistence)
    },
    sponsors: {
      agGrid: true,
      apimatic: true,
      render: true,
      postman: true
    },
    ai: aiStatus(env)
  };
}

function createApp({
  store,
  agent,
  publicDir = path.join(process.cwd(), 'public'),
  parseInvoice = parseInvoiceTextWithMetadataAsync,
  env = process.env,
  config = buildConfig(env),
  limiter = null
} = {}) {
  const invoiceStore = store || new InvoiceStore({
    adapter: createPayPalAdapter(env),
    persistence: persistenceFromEnvironment(env),
    policy: loadPolicy({ env })
  });
  const copilot = agent || new CopilotAgent({ store: invoiceStore, env });
  const throttle = limiter || rateLimiter(config);

  const server = http.createServer(async (request, response) => {
    securityHeaders(response);
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    const write = request.method !== 'GET' && request.method !== 'HEAD';

    try {
      if (!sameOrigin(request, config)) throw new AuthorizationError('cross-origin request rejected');
      if (!throttle.allow(`${clientIp(request, config)}:${pathname.startsWith('/api/pay') ? 'pay' : pathname.includes('webhook') ? 'webhook' : 'api'}`, { write })) {
        response.setHeader('Retry-After', '60');
        return sendJson(response, 429, { error: { code: 'RATE_LIMITED', message: 'too many requests; try again shortly' } });
      }

      if (pathname.startsWith('/api/')) {
        const sendMatch = pathname.match(/^\/api\/invoices\/([A-Za-z0-9_-]{1,80})\/send$/);
        const remindMatch = pathname.match(/^\/api\/invoices\/([A-Za-z0-9_-]{1,80})\/remind$/);
        const cancelMatch = pathname.match(/^\/api\/invoices\/([A-Za-z0-9_-]{1,80})\/cancel$/);
        const paymentLinkMatch = pathname.match(/^\/api\/invoices\/([A-Za-z0-9_-]{1,80})\/payment-link$/);
        const payMatch = pathname.match(/^\/api\/pay\/([A-Za-z0-9_-]{10,128})$/);
        const payOrderMatch = pathname.match(/^\/api\/pay\/([A-Za-z0-9_-]{10,128})\/order$/);
        const payCaptureMatch = pathname.match(/^\/api\/pay\/([A-Za-z0-9_-]{10,128})\/capture$/);

        if (request.method === 'GET' && pathname === '/api/health') return sendJson(response, 200, healthPayload(invoiceStore, config, env));
        if (request.method === 'GET' && pathname === '/api/state') {
          return sendJson(response, 200, { ...invoiceStore.state(), meta: stateMeta(invoiceStore, config, env) });
        }
        if (request.method === 'GET' && pathname === '/api/insights') return sendJson(response, 200, invoiceStore.insights());
        if (request.method === 'GET' && pathname === '/api/policy') {
          const insights = invoiceStore.insights();
          return sendJson(response, 200, { policy: insights.policy, decisions: insights.policyDecisions });
        }
        if (request.method === 'GET' && pathname === '/api/audit') return sendJson(response, 200, invoiceStore.verifyAudit());
        if (request.method === 'GET' && payMatch) {
          const invoice = invoiceStore.findByPayToken(payMatch[1]);
          return sendJson(response, 200, {
            invoice: publicInvoiceView(invoice),
            merchant: { name: env.MERCHANT_NAME || 'Cashflow Copilot' },
            checkout: { enabled: true, mock: invoiceStore.adapter.name === 'mock' }
          });
        }

        if (write && pathname === '/api/parse-invoice') {
          const body = await readJson(request);
          if (typeof body.text !== 'string') throw new ValidationError('text is required');
          const parsed = await parseInvoice(body.text);
          if (parsed && parsed.invoice && parsed.ai) return sendJson(response, 200, parsed);
          return sendJson(response, 200, { invoice: parsed, ai: { provider: 'deterministic', mode: 'deterministic', model: null, fallback: false, reason: 'Custom parser' } });
        }
        if (write && pathname === '/api/invoices') {
          const body = await readJson(request);
          return sendJson(response, 201, { invoice: invoiceStore.createInvoice(body) });
        }
        if (write && sendMatch) return sendJson(response, 200, { invoice: await invoiceStore.sendInvoice(sendMatch[1]) });
        if (write && remindMatch) {
          const body = await readJson(request);
          return sendJson(response, 200, { invoice: await invoiceStore.remindInvoice(remindMatch[1], { force: body.force === true }) });
        }
        if (write && cancelMatch) {
          const body = await readJson(request);
          return sendJson(response, 200, { invoice: await invoiceStore.cancelInvoice(cancelMatch[1], { reason: typeof body.reason === 'string' ? body.reason.slice(0, 300) : undefined }) });
        }
        if (write && paymentLinkMatch) {
          const { order, invoice } = await invoiceStore.ensurePaymentOrder(paymentLinkMatch[1], { baseUrl: requestBaseUrl(request, config) });
          return sendJson(response, 200, { order, payUrl: `/pay/${invoice.payToken}`, invoice });
        }
        if (write && pathname === '/api/copilot/plan') {
          const body = await readJson(request);
          return sendJson(response, 200, await copilot.plan(body.message, body.ai || {}));
        }
        if (write && pathname === '/api/copilot/execute') {
          const body = await readJson(request);
          const result = await copilot.execute(body.planId, body.stepIds, { baseUrl: requestBaseUrl(request, config) });
          return sendJson(response, 200, result);
        }
        if (write && pathname === '/api/demo/reset') {
          if (config.demoResetSecret) {
            const header = request.headers.authorization || '';
            if (header !== `Bearer ${config.demoResetSecret}`) throw new AuthorizationError('demo reset token is required');
          }
          const reset = invoiceStore.reset();
          return sendJson(response, 200, { reset: true, ...reset, meta: stateMeta(invoiceStore, config, env) });
        }
        if (write && payOrderMatch) {
          const invoice = invoiceStore.findByPayToken(payOrderMatch[1]);
          const { order, invoice: updated } = await invoiceStore.ensurePaymentOrder(invoice.id, { baseUrl: requestBaseUrl(request, config) });
          return sendJson(response, 200, { order, invoice: publicInvoiceView(updated) });
        }
        if (write && payCaptureMatch) {
          const body = await readJson(request);
          const invoice = invoiceStore.findByPayToken(payCaptureMatch[1]);
          if (body.orderId && invoice.paypalOrderId && body.orderId !== invoice.paypalOrderId) throw new ValidationError('order does not match this invoice');
          const result = await invoiceStore.capturePayment(invoice.id, { orderId: body.orderId || invoice.paypalOrderId, source: 'paypal-checkout', actor: 'customer' });
          return sendJson(response, 200, { invoice: publicInvoiceView(result.invoice), duplicate: result.duplicate, capture: result.capture });
        }
        if (write && pathname === '/api/webhooks/simulate') {
          if (!config.allowWebhookSimulation) throw new ValidationError('webhook simulation is disabled');
          const body = await readJson(request);
          return sendJson(response, 200, invoiceStore.simulateWebhook(body));
        }
        if (write && pathname === '/api/webhooks/paypal') {
          if (invoiceStore.adapter.name !== 'paypal-sandbox' || typeof invoiceStore.adapter.verifyWebhookSignature !== 'function') throw new ValidationError('verified PayPal webhooks require the PayPal sandbox adapter');
          const webhookId = env.PAYPAL_WEBHOOK_ID;
          const body = await readJson(request);
          const signature = {
            transmissionId: request.headers['paypal-transmission-id'],
            transmissionTime: request.headers['paypal-transmission-time'],
            certUrl: request.headers['paypal-cert-url'],
            authAlgo: request.headers['paypal-auth-algo'],
            transmissionSig: request.headers['paypal-transmission-sig'],
            webhookId,
            webhookEvent: body
          };
          if (Object.values(signature).some((value) => !value)) throw new AuthorizationError('PayPal webhook signature headers and PAYPAL_WEBHOOK_ID are required');
          const verified = await invoiceStore.adapter.verifyWebhookSignature(signature);
          if (!verified) throw new AuthorizationError('PayPal webhook signature verification failed');

          const eventType = body.event_type;
          if (eventType === 'PAYMENT.CAPTURE.COMPLETED' || eventType === 'CHECKOUT.ORDER.COMPLETED') {
            const resource = body.resource || {};
            const internalId = resource.custom_id || resource.invoice_id || resource.purchase_units?.[0]?.custom_id || null;
            if (!internalId) return sendJson(response, 200, { accepted: true, ignored: true, reason: 'no internal invoice reference' });
            const recorded = invoiceStore.recordPayment(internalId, {
              source: 'paypal',
              verified: true,
              eventId: body.id,
              detail: { orderId: resource.id || resource.supplementary_data?.related_ids?.order_id || null, captureId: resource.id || null, amount: resource.amount?.value ? Number(resource.amount.value) : null, currency: resource.amount?.currency_code || null }
            });
            return sendJson(response, 200, { accepted: true, duplicate: recorded.duplicate, invoice: recorded.invoice, event: { type: eventType, verified: true } });
          }
          if (!INVOICE_WEBHOOK_EVENTS.has(eventType)) {
            return sendJson(response, 200, { accepted: true, ignored: true, reason: `unsupported event ${eventType}` });
          }
          return sendJson(response, 200, invoiceStore.simulateWebhook({ id: body.id, eventType, resource: body.resource }, { source: 'paypal', verified: true }));
        }

        const known = pathname === '/api/health' || pathname === '/api/state' || pathname === '/api/insights' || pathname === '/api/policy' || pathname === '/api/audit' || pathname === '/api/parse-invoice' || pathname === '/api/invoices' || pathname === '/api/copilot/plan' || pathname === '/api/copilot/execute' || pathname === '/api/demo/reset' || pathname === '/api/webhooks/simulate' || pathname === '/api/webhooks/paypal' || sendMatch || remindMatch || cancelMatch || paymentLinkMatch || payMatch || payOrderMatch || payCaptureMatch;
        if (!known) return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
        const allowedMethods = (pathname === '/api/health' || pathname === '/api/state' || pathname === '/api/insights' || pathname === '/api/policy' || pathname === '/api/audit' || payMatch) ? 'GET' : 'POST';
        response.setHeader('Allow', allowedMethods);
        return sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } });
      }

      if (request.method === 'GET' && (pathname === '/pay' || /^\/pay\/[A-Za-z0-9_-]{10,128}$/.test(pathname))) {
        if (await serveStatic(response, publicDir, '/pay.html')) return;
      }
      if (request.method === 'GET' && await serveStatic(response, publicDir, pathname)) return;
      return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
    } catch (error) {
      const known = error instanceof AuthorizationError || error instanceof ValidationError || error instanceof NotFoundError || error instanceof PayPalError;
      if (!known) console.error('request failed:', error.code || error.name || 'error');
      if (response.headersSent) return response.end();
      return sendJson(response, known ? error.statusCode : 500, errorPayload(error));
    }
  });

  server.store = invoiceStore;
  server.agent = copilot;
  server.config = config;
  return server;
}

if (require.main === module) {
  const config = buildConfig(process.env);
  const server = createApp({ config });
  server.listen(config.port, '0.0.0.0', () => {
    const mode = server.store.adapter.name === 'paypal-sandbox' ? 'paypal-sandbox' : 'mock';
    console.log(`Cashflow Copilot v${VERSION} listening on port ${config.port} (${mode} adapter)`);
  });
  const shutdown = (signal) => {
    console.log(`${signal} received; flushing state and shutting down`);
    const done = () => process.exit(0);
    server.close(done);
    const flush = server.store.persistence?.flush?.();
    if (flush && typeof flush.then === 'function') flush.finally(done); else done();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { buildConfig, createApp, healthPayload, rateLimiter, readJson, sameOrigin, serveStatic };
