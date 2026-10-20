'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { InvoiceStore, AuthorizationError, ValidationError, NotFoundError, PayPalError, createPayPalAdapter, parseInvoiceTextAsync } = require('./core');

const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 1024 * 1024;

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

function healthPayload(store) {
  const adapter = store.adapter?.name || 'unknown';
  return {
    status: 'ok',
    adapter,
    mode: adapter === 'paypal-sandbox' ? 'sandbox' : adapter === 'mock' ? 'mock' : 'custom',
    uptime: process.uptime(),
    capabilities: {
      parseInvoice: true,
      invoiceCreation: true,
      invoiceSending: true,
      reminders: true,
      webhookSimulation: true,
      paypalWebhooks: adapter === 'paypal-sandbox' && typeof store.adapter.verifyWebhookSignature === 'function',
      aiParsing: Boolean(process.env.OPENAI_API_KEY)
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
      if (!chunks.length) return reject(new ValidationError('JSON request body is required'));
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed);
      } catch {
        reject(new ValidationError('request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}

function mimeType(filePath) {
  return { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' }[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
}

async function serveStatic(response, publicDir, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const root = path.resolve(publicDir);
  const filePath = path.resolve(root, relative);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return false;
  try {
    const stat = await fs.promises.stat(filePath);
    if (!stat.isFile()) return false;
    const data = await fs.promises.readFile(filePath);
    response.writeHead(200, { 'Content-Type': mimeType(filePath), 'Content-Length': data.length, 'Cache-Control': 'no-cache' });
    response.end(data);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function createApp({ store = new InvoiceStore({ adapter: createPayPalAdapter() }), publicDir = path.join(process.cwd(), 'public'), parseInvoice = parseInvoiceTextAsync } = {}) {
  return http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    const url = new URL(request.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if (pathname.startsWith('/api/')) {
        const sendMatch = pathname.match(/^\/api\/invoices\/([A-Za-z0-9_-]{1,80})\/send$/);
        const remindMatch = pathname.match(/^\/api\/invoices\/([A-Za-z0-9_-]{1,80})\/remind$/);
        const knownRoute = pathname === '/api/health' || pathname === '/api/state' || pathname === '/api/insights' || pathname === '/api/parse-invoice' || pathname === '/api/invoices' || pathname === '/api/webhooks/simulate' || pathname === '/api/webhooks/paypal' || Boolean(sendMatch) || Boolean(remindMatch);
        if (!knownRoute) return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
        if (request.method === 'GET' && pathname === '/api/health') return sendJson(response, 200, healthPayload(store));
        if (request.method === 'GET' && pathname === '/api/state') return sendJson(response, 200, store.state());
        if (request.method === 'GET' && pathname === '/api/insights') return sendJson(response, 200, store.insights());
        if (pathname === '/api/health' || pathname === '/api/state' || pathname === '/api/insights') {
          response.setHeader('Allow', 'GET');
          return sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } });
        }
        if (request.method !== 'POST') {
          response.setHeader('Allow', pathname === '/api/state' ? 'GET' : 'POST');
          return sendJson(response, 405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'method not allowed' } });
        }
        const contentType = request.headers['content-type'];
        if (contentType && !contentType.toLowerCase().startsWith('application/json')) throw new ValidationError('Content-Type must be application/json');
        const body = await readJson(request);
        if (pathname === '/api/parse-invoice') {
          if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.text !== 'string') throw new ValidationError('text is required');
          return sendJson(response, 200, { invoice: await parseInvoice(body.text) });
        }
        if (pathname === '/api/invoices') return sendJson(response, 201, { invoice: store.createInvoice(body) });
        if (sendMatch) return sendJson(response, 200, { invoice: await store.sendInvoice(sendMatch[1]) });
        if (remindMatch) return sendJson(response, 200, { invoice: await store.remindInvoice(remindMatch[1]) });
        if (pathname === '/api/webhooks/simulate') return sendJson(response, 200, store.simulateWebhook(body));
        if (pathname === '/api/webhooks/paypal') {
          if (store.adapter.name !== 'paypal-sandbox' || typeof store.adapter.verifyWebhookSignature !== 'function') throw new ValidationError('verified PayPal webhooks require the PayPal sandbox adapter');
          const webhookId = process.env.PAYPAL_WEBHOOK_ID;
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
          const verified = await store.adapter.verifyWebhookSignature(signature);
          if (!verified) throw new AuthorizationError('PayPal webhook signature verification failed');
          return sendJson(response, 200, store.simulateWebhook({ id: body.id, eventType: body.event_type, resource: body.resource }, { source: 'paypal', verified: true }));
        }
        return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
      }
      if (request.method === 'GET' && await serveStatic(response, publicDir, pathname)) return;
      return sendJson(response, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
    } catch (error) {
      const known = error instanceof AuthorizationError || error instanceof ValidationError || error instanceof NotFoundError || error instanceof PayPalError;
      if (!known) console.error('request failed:', error.code || error.name || 'error');
      return sendJson(response, known ? error.statusCode : 500, errorPayload(error));
    }
  });
}

if (require.main === module) {
  const server = createApp();
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Cashflow Copilot listening on port ${PORT}`);
  });
}

module.exports = { createApp, readJson, serveStatic };
