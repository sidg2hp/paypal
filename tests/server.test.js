'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, buildConfig } = require('../src/server');
const { InvoiceStore, MockPayPalAdapter } = require('../src/core');
const { mergePolicy } = require('../src/policy');

const NOW = '2026-10-20T12:00:00.000Z';

function createTestStore() {
  return new InvoiceStore({ adapter: new MockPayPalAdapter(), clock: () => NOW, policy: mergePolicy({}) });
}

function request(server, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: address.port,
      path: pathname,
      method,
      headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...extraHeaders }
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function start(t, options = {}) {
  const server = createApp({
    store: options.store || createTestStore(),
    publicDir: options.publicDir || 'public',
    env: { AI_PROVIDER: 'deterministic' },
    config: buildConfig({}),
    ...options
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return server;
}

test('state, health, insights, policy and audit are secret-free and consistent', async (t) => {
  const server = await start(t);
  const state = await request(server, 'GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.invoices.length, 4);
  assert.equal(state.body.adapter, 'mock');
  assert.equal(state.body.meta.mode, 'mock');
  assert.equal(state.body.meta.sponsors.agGrid, true);
  assert.equal(state.body.meta.checkout.enabled, true);
  assert.equal(Object.prototype.hasOwnProperty.call(state.body, 'PAYPAL_CLIENT_SECRET'), false);

  const health = await request(server, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.status, 'ok');
  assert.equal(health.body.version, '1.0.0');
  assert.equal(health.body.mode, 'mock');
  assert.equal(typeof health.body.uptime, 'number');
  assert.equal(health.body.capabilities.agentPlanner, true);
  assert.equal(health.body.capabilities.checkout, true);
  assert.equal(health.body.capabilities.auditChain, true);
  assert.equal(health.body.paypal.configured, false);
  assert.equal(health.body.paypal.environment, 'mock');
  assert.equal(JSON.stringify(health.body).includes('secret'), false);

  const insights = await request(server, 'GET', '/api/insights');
  assert.equal(insights.status, 200);
  assert.ok(insights.body.recommendations.length >= 1);
  assert.ok(insights.body.summary.healthScore > 0);
  assert.ok(insights.body.policyDecisions.length >= 1);

  const policy = await request(server, 'GET', '/api/policy');
  assert.equal(policy.status, 200);
  assert.equal(policy.body.policy.version, 1);
  assert.ok(policy.body.decisions.length >= 1);

  const audit = await request(server, 'GET', '/api/audit');
  assert.equal(audit.status, 200);
  assert.equal(audit.body.valid, true);
  assert.ok(audit.body.checkedEvents >= 4);
});

test('full invoice lifecycle: parse, create, send, remind, cancel, payment link, pay, capture', async (t) => {
  const server = await start(t);
  const parsed = await request(server, 'POST', '/api/parse-invoice', { text: 'Invoice Acme Design Co <accounts@acme.example> for 2 brand review sessions at $125 each, tax 8%, due in 15 days' });
  assert.equal(parsed.status, 200);
  assert.equal(parsed.body.invoice.customer.name, 'Acme Design Co');
  assert.equal(parsed.body.invoice.total, 270);

  const created = await request(server, 'POST', '/api/invoices', { ...parsed.body.invoice });
  assert.equal(created.status, 201);
  const id = created.body.invoice.id;
  assert.equal(created.body.invoice.currency, 'USD');
  assert.ok(created.body.invoice.payToken);

  const sent = await request(server, 'POST', `/api/invoices/${id}/send`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.invoice.status, 'SENT');
  assert.ok(sent.body.invoice.paypalInvoiceId);

  const reminder = await request(server, 'POST', `/api/invoices/${id}/remind`, {});
  assert.equal(reminder.status, 200);
  assert.equal(reminder.body.invoice.reminderCount, 1);

  const link = await request(server, 'POST', `/api/invoices/${id}/payment-link`, {});
  assert.equal(link.status, 200);
  assert.match(link.body.payUrl, /^\/pay\//);
  const token = link.body.payUrl.split('/').pop();

  const publicView = await request(server, 'GET', `/api/pay/${token}`);
  assert.equal(publicView.status, 200);
  assert.equal(publicView.body.invoice.total, 270);
  assert.equal(publicView.body.checkout.mock, true);
  assert.equal(Object.prototype.hasOwnProperty.call(publicView.body.invoice, 'paypalInvoiceId'), false);

  const order = await request(server, 'POST', `/api/pay/${token}/order`, {});
  assert.equal(order.status, 200);
  assert.equal(order.body.order.mock, true);

  const capture = await request(server, 'POST', `/api/pay/${token}/capture`, { orderId: order.body.order.id });
  assert.equal(capture.status, 200);
  assert.equal(capture.body.invoice.status, 'PAID');
  assert.equal(capture.body.duplicate, false);

  const duplicate = await request(server, 'POST', `/api/pay/${token}/capture`, { orderId: order.body.order.id });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);

  const audit = await request(server, 'GET', '/api/audit');
  assert.equal(audit.body.valid, true);
});

test('cancel works for drafts and sent invoices', async (t) => {
  const server = await start(t);
  const draftCancel = await request(server, 'POST', '/api/invoices/inv_seed_004/cancel', { reason: 'duplicate' });
  assert.equal(draftCancel.status, 200);
  assert.equal(draftCancel.body.invoice.status, 'CANCELLED');
  const sentCancel = await request(server, 'POST', '/api/invoices/inv_seed_002/cancel', {});
  assert.equal(sentCancel.status, 200);
  assert.equal(sentCancel.body.invoice.status, 'CANCELLED');
  const paidCancel = await request(server, 'POST', '/api/invoices/inv_seed_003/cancel', {});
  assert.equal(paidCancel.status, 400);
});

test('copilot plan and execute respect approval and return results', async (t) => {
  const server = await start(t);
  const planResponse = await request(server, 'POST', '/api/copilot/plan', { message: 'who should I chase today?' });
  assert.equal(planResponse.status, 200);
  assert.equal(planResponse.body.intent, 'collections_review');
  assert.ok(planResponse.body.steps.length >= 1);
  const plan = planResponse.body;

  const execute = await request(server, 'POST', '/api/copilot/execute', { planId: plan.id, stepIds: [plan.steps[0].id] });
  assert.equal(execute.status, 200);
  assert.equal(execute.body.executed, 1);
  assert.equal(execute.body.results[0].status, 'executed');

  const missing = await request(server, 'POST', '/api/copilot/execute', { planId: plan.id, stepIds: [] });
  assert.equal(missing.status, 400);
});

test('webhook simulation updates state and is idempotent', async (t) => {
  const server = await start(t);
  const first = await request(server, 'POST', '/api/webhooks/simulate', { eventType: 'INVOICING.INVOICE.PAID', invoiceId: 'inv_seed_001' });
  assert.equal(first.status, 200);
  assert.equal(first.body.invoice.status, 'PAID');
  const duplicate = await request(server, 'POST', '/api/webhooks/simulate', { eventType: 'INVOICING.INVOICE.PAID', invoiceId: 'inv_seed_001' });
  assert.equal(duplicate.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  const unsupported = await request(server, 'POST', '/api/webhooks/simulate', { eventType: 'PAYMENT.SALE.COMPLETED', invoiceId: 'inv_seed_001' });
  assert.equal(unsupported.status, 400);
});

test('verified PayPal webhook path gates state changes on signature verification', async (t) => {
  const store = createTestStore();
  let verificationInput;
  store.adapter = {
    name: 'paypal-sandbox',
    verifyWebhookSignature: async (input) => { verificationInput = input; return true; }
  };
  const server = await start(t, {
    store,
    env: { AI_PROVIDER: 'deterministic', PAYPAL_WEBHOOK_ID: 'WH-DEMO-1' }
  });

  const event = { id: 'evt_verified_1', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice_id: 'inv_seed_001' } };
  const result = await request(server, 'POST', '/api/webhooks/paypal', event, {
    'paypal-transmission-id': 'transmission-1',
    'paypal-transmission-time': '2026-10-20T12:00:00Z',
    'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'signature-1'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.event.verified, true);
  assert.equal(result.body.invoice.status, 'PAID');
  assert.equal(verificationInput.webhookId, 'WH-DEMO-1');
  assert.equal(verificationInput.webhookEvent.id, 'evt_verified_1');

  const rejected = await request(server, 'POST', '/api/webhooks/paypal', event, {
    'paypal-transmission-id': 'transmission-1',
    'paypal-transmission-time': '2026-10-20T12:00:00Z',
    'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert',
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-transmission-sig': 'signature-1'
  });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.duplicate, true);
});

test('missing webhook signature headers are rejected without changing state', async (t) => {
  const store = createTestStore();
  store.adapter = { name: 'paypal-sandbox', verifyWebhookSignature: async () => true };
  const server = await start(t, { store, env: { AI_PROVIDER: 'deterministic', PAYPAL_WEBHOOK_ID: 'WH-1' } });
  const result = await request(server, 'POST', '/api/webhooks/paypal', { id: 'evt', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice_id: 'inv_seed_001' } });
  assert.equal(result.status, 401);
  assert.equal(store.getInvoice('inv_seed_001').status, 'SENT');
});

test('verified capture webhooks record payment without calling capture', async (t) => {
  const store = createTestStore();
  store.adapter = { name: 'paypal-sandbox', verifyWebhookSignature: async () => true };
  const server = await start(t, { store, env: { AI_PROVIDER: 'deterministic', PAYPAL_WEBHOOK_ID: 'WH-1' } });
  const result = await request(server, 'POST', '/api/webhooks/paypal', {
    id: 'CAP-WEBHOOK-1',
    event_type: 'PAYMENT.CAPTURE.COMPLETED',
    resource: { id: 'CAP-9', custom_id: 'inv_seed_001', amount: { value: '487.13', currency_code: 'USD' } }
  }, {
    'paypal-transmission-id': 't', 'paypal-transmission-time': 'now', 'paypal-cert-url': 'https://api.paypal.com/cert', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-transmission-sig': 's'
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.invoice.status, 'PAID');
  assert.equal(result.body.invoice.paymentReference, 'CAP-9');
});

test('security headers, same-origin enforcement, 404 and 405 behavior', async (t) => {
  const server = await start(t);
  const state = await request(server, 'GET', '/api/state');
  assert.equal(state.headers['x-frame-options'], 'DENY');
  assert.equal(state.headers['x-content-type-options'], 'nosniff');
  assert.match(state.headers['content-security-policy'], /default-src 'self'/);
  assert.match(state.headers['content-security-policy'], /script-src 'self'/);
  assert.match(state.headers['content-security-policy'], /style-src 'self' 'unsafe-inline'/);

  const crossOrigin = await request(server, 'POST', '/api/invoices', { customer: { name: 'X' } }, { Origin: 'https://evil.example' });
  assert.equal(crossOrigin.status, 401);

  const missing = await request(server, 'GET', '/api/nope');
  assert.equal(missing.status, 404);
  const wrongMethod = await request(server, 'GET', '/api/invoices');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');
  const badJson = await request(server, 'POST', '/api/invoices', undefined, { 'Content-Type': 'application/json' });
  assert.equal(badJson.status, 400);
});

test('rate limiting rejects bursts', async (t) => {
  const config = { ...buildConfig({}), rateLimitMax: 2, rateLimitWriteMax: 2, rateLimitDisabled: false };
  const server = await start(t, { config });
  const first = await request(server, 'GET', '/api/health');
  const second = await request(server, 'GET', '/api/health');
  const third = await request(server, 'GET', '/api/health');
  assert.notEqual(first.status, 429);
  assert.equal(second.status, 200);
  assert.equal(third.status, 429);
  assert.equal(third.body.error.code, 'RATE_LIMITED');
});

test('demo reset reseeds the ledger and the pay page is served', async (t) => {
  const server = await start(t);
  await request(server, 'POST', '/api/invoices', { customer: { name: 'Temp', email: 'temp@example.com' }, items: [{ description: 'X', quantity: 1, unitPrice: 1 }] });
  const reset = await request(server, 'POST', '/api/demo/reset', {});
  assert.equal(reset.status, 200);
  assert.equal(reset.body.invoices.length, 4);

  const page = await request(server, 'GET', '/pay/inv_seed_001');
  assert.equal(page.status, 200);
  assert.match(page.text, /Secure PayPal checkout/);
  assert.match(page.headers['content-type'], /text\/html/);
});

test('demo reset secret is enforced when configured', async (t) => {
  const config = { ...buildConfig({}), demoResetSecret: 'top-secret' };
  const server = await start(t, { config });
  const denied = await request(server, 'POST', '/api/demo/reset', {});
  assert.equal(denied.status, 401);
  const allowed = await request(server, 'POST', '/api/demo/reset', {}, { Authorization: 'Bearer top-secret' });
  assert.equal(allowed.status, 200);
});
