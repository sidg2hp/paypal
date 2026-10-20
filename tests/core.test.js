'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/server');
const { InvoiceStore, MockPayPalAdapter, PayPalSandboxAdapter, ValidationError, calculateTotals, parseInvoiceText, parseInvoiceTextAsync } = require('../src/core');

function createTestStore() {
  return new InvoiceStore({ adapter: new MockPayPalAdapter(), clock: () => '2026-10-20T12:00:00.000Z' });
}

function request(server, method, pathname, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: pathname, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}), ...extraHeaders } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        let parsed;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('parser extracts customer, line items, tax and deterministic totals offline', () => {
  const parsed = parseInvoiceText('Invoice for Acme Corp <billing@acme.example>\n2 hours consulting at $150/hour\n1 report at $25\ntax 8%\ndue 2026-12-01');
  assert.equal(parsed.customer.name, 'Acme Corp');
  assert.equal(parsed.customer.email, 'billing@acme.example');
  assert.equal(parsed.subtotal, 325);
  assert.equal(parsed.tax, 26);
  assert.equal(parsed.total, 351);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.dueDate, '2026-12-01');
  assert.equal(parseInvoiceText('Invoice for Relative Buyer <relative@example.com>\n1 audit at $100\ndue in 15 days', { now: new Date('2026-10-20T00:00:00.000Z') }).dueDate, '2026-11-04');
});

test('totals use rounded cents and reject invalid items', () => {
  assert.deepEqual(calculateTotals([{ description: 'Fractional', quantity: 3, unitPrice: 0.1 }], 7.5), { items: [{ description: 'Fractional', quantity: 3, unitPrice: 0.1, amount: 0.3 }], subtotal: 0.3, taxRate: 7.5, tax: 0.02, total: 0.32 });
  assert.throws(() => calculateTotals([], 0), ValidationError);
  assert.throws(() => calculateTotals([{ description: 'Bad', quantity: 1, unitPrice: -1 }], 0), ValidationError);
});

test('store creates and sends an invoice through mock PayPal', async () => {
  const store = createTestStore();
  const created = store.createInvoice({ customer: { name: 'Demo Buyer', email: 'buyer@example.com' }, items: [{ description: 'Analysis', quantity: 2, unitPrice: 80 }], taxRate: 5 });
  assert.equal(created.status, 'DRAFT');
  assert.equal(created.total, 168);
  const sent = await store.sendInvoice(created.id);
  assert.equal(sent.status, 'SENT');
  assert.equal(sent.paypalInvoiceId, 'MOCK-INV-0001');
  assert.equal(sent.events.at(-1).type, 'INVOICING.INVOICE.SENT');
  await assert.rejects(() => store.sendInvoice(created.id), /already been sent/);
});

test('webhook simulation resolves ids and ignores stale lifecycle events', () => {
  const store = createTestStore();
  const result = store.simulateWebhook({ eventType: 'INVOICING.INVOICE.PAID', invoiceId: 'MOCK-INV-SEED-001' });
  assert.equal(result.accepted, true);
  assert.equal(result.invoice.id, 'inv_seed_001');
  assert.equal(result.invoice.status, 'PAID');
  const stale = store.simulateWebhook({ id: 'stale-sent-1', eventType: 'INVOICING.INVOICE.SENT', invoiceId: 'inv_seed_001' });
  assert.equal(stale.accepted, true);
  assert.equal(stale.stale, true);
  assert.equal(stale.invoice.status, 'PAID');
  assert.throws(() => store.simulateWebhook({ eventType: 'PAYMENT.SALE.COMPLETED', invoiceId: 'inv_seed_001' }), ValidationError);

  for (const [eventType, status] of [['INVOICING.INVOICE.CANCELLED', 'CANCELLED'], ['INVOICING.INVOICE.VOIDED', 'VOID']]) {
    const terminalStore = createTestStore();
    const closed = terminalStore.simulateWebhook({ eventType, invoiceId: 'inv_seed_001' });
    assert.equal(closed.invoice.status, status);
    for (const staleEventType of ['INVOICING.INVOICE.SENT', 'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.VOIDED']) {
      if (staleEventType === eventType) continue;
      const outOfOrder = terminalStore.simulateWebhook({ id: `stale-${status}-${staleEventType}`, eventType: staleEventType, invoiceId: 'inv_seed_001' });
      assert.equal(outOfOrder.stale, true);
      assert.equal(outOfOrder.invoice.status, status);
    }
  }
});

test('insights explain invoice risk and project due cash across horizons', () => {
  const store = createTestStore();
  const insights = store.insights();
  const overdue = insights.invoices.find((item) => item.invoiceId === 'inv_seed_002');
  assert.equal(overdue.status, 'SENT');
  assert.equal(overdue.risk, 'HIGH');
  assert.equal(overdue.urgency, 'HIGH');
  assert.equal(overdue.nextAction.type, 'REMIND_INVOICE');
  assert.ok(overdue.reasonCodes.includes('OVERDUE'));
  assert.equal(insights.projectedCashPosition['7'].USD, 250);
  assert.equal(insights.projectedCashPosition['14'].USD, 250);
  assert.equal(insights.projectedCashPosition['30'].USD, 737.13);
  assert.equal(insights.nextAction.invoiceId, 'inv_seed_002');
});

test('mock reminder sends through adapter and records a timeline event', async () => {
  const adapter = new MockPayPalAdapter();
  const store = new InvoiceStore({ adapter, clock: () => '2026-10-20T12:00:00.000Z' });
  const invoice = await store.remindInvoice('inv_seed_002');
  assert.equal(invoice.reminderCount, 1);
  assert.deepEqual(adapter.reminders, ['MOCK-INV-SEED-002']);
  assert.equal(invoice.events.at(-1).type, 'INVOICING.INVOICE.REMINDER_SENT');
  const draft = store.createInvoice({ customer: { name: 'Draft Buyer', email: 'draft@example.com' }, items: [{ description: 'Draft work', quantity: 1, unitPrice: 10 }] });
  await assert.rejects(() => store.remindInvoice(draft.id), ValidationError);
});

test('sandbox reminder and webhook verification use the documented PayPal endpoints', async () => {
  const calls = [];
  const adapter = new PayPalSandboxAdapter({ clientId: 'client', clientSecret: 'secret', baseUrl: 'https://sandbox.test', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => (url.endsWith('/token') ? { access_token: 'token', expires_in: 300 } : url.endsWith('/verify-webhook-signature') ? { verification_status: 'SUCCESS' } : {}) };
  } });
  const result = await adapter.remindInvoice('remote-1');
  assert.equal(result.reminded, true);
  assert.equal(calls.at(-1).url, 'https://sandbox.test/v2/invoicing/invoices/remote-1/remind');
  assert.equal(calls.at(-1).options.method, 'POST');
  assert.equal(await adapter.verifyWebhookSignature({ transmissionId: 't1', transmissionTime: 'now', certUrl: 'https://cert', authAlgo: 'SHA256withRSA', transmissionSig: 'sig', webhookId: 'wh_1', webhookEvent: { id: 'evt_1' } }), true);
  assert.equal(calls.at(-1).url, 'https://sandbox.test/v1/notifications/verify-webhook-signature');
});

test('webhook simulation is idempotent for repeated event ids', () => {
  const store = createTestStore();
  const first = store.simulateWebhook({ id: 'evt_paid_1', eventType: 'INVOICING.INVOICE.PAID', invoiceId: 'inv_seed_001' });
  const second = store.simulateWebhook({ id: 'evt_paid_1', eventType: 'INVOICING.INVOICE.PAID', invoiceId: 'inv_seed_001' });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.invoice.events.filter((event) => event.type === 'INVOICING.INVOICE.PAID').length, 1);
});

test('configured AI extraction falls back deterministically when the provider fails', async () => {
  let requested = false;
  const parsed = await parseInvoiceTextAsync('Invoice for Fallback Buyer <fallback@example.com>\n1 audit at $100', {
    apiKey: 'test-key',
    fetchImpl: async () => { requested = true; throw new Error('offline'); }
  });
  assert.equal(requested, true);
  assert.equal(parsed.customer.email, 'fallback@example.com');
  assert.equal(parsed.total, 100);
});

test('configured AI extraction aborts a hung provider within its timeout', async () => {
  let signal;
  const parsed = await parseInvoiceTextAsync('Invoice for Timeout Buyer <timeout@example.com>\n1 audit at $100', {
    apiKey: 'test-key',
    timeoutMs: 20,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return resolve();
    }
  });
  assert.equal(signal.aborted, true);
  assert.equal(parsed.total, 100);
});

test('configured AI extraction validates a structured OpenAI-compatible response', async () => {
  const parsed = await parseInvoiceTextAsync('anything', {
    apiKey: 'test-key',
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://provider.test/v1/chat/completions');
      assert.match(options.headers.Authorization, /^Bearer test-key$/);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ customer: { name: 'AI Buyer', email: 'ai@example.com' }, items: [{ description: 'Review', quantity: 2, unitPrice: 50 }], currency: 'USD', taxRate: 0, dueDate: null }) } }] }) };
    },
    baseUrl: 'https://provider.test/v1'
  });
  assert.equal(parsed.customer.name, 'AI Buyer');
  assert.equal(parsed.total, 100);
});

test('PayPal sandbox requests abort when the provider exceeds its timeout', async () => {
  let signal;
  const adapter = new PayPalSandboxAdapter({
    clientId: 'client',
    clientSecret: 'secret',
    timeoutMs: 20,
    fetchImpl: async (_url, options) => {
      signal = options.signal;
      await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return resolve();
    }
  });
  await assert.rejects(() => adapter.accessToken(), (error) => error.code === 'PAYPAL_ERROR' && /timed out/.test(error.message));
  assert.equal(signal.aborted, true);
});

test('HTTP routes expose state, parse/create/send/webhook flows and strict errors', async (t) => {
  const server = createApp({ store: createTestStore(), publicDir: 'missing-public', parseInvoice: parseInvoiceText });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const state = await request(server, 'GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.invoices.length, 2);
  assert.equal(state.body.adapter, 'mock');

  const health = await request(server, 'GET', '/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.adapter, 'mock');
  assert.equal(health.body.mode, 'mock');
  assert.equal(typeof health.body.uptime, 'number');
  assert.equal(health.body.capabilities.paypalWebhooks, false);
  assert.equal(Object.prototype.hasOwnProperty.call(health.body, 'PAYPAL_CLIENT_SECRET'), false);

  const parsed = await request(server, 'POST', '/api/parse-invoice', { text: 'Invoice for Route Buyer <route@example.com>\n1 design at $100' });
  assert.equal(parsed.status, 200);
  const created = await request(server, 'POST', '/api/invoices', { ...parsed.body.invoice });
  assert.equal(created.status, 201);
  const id = created.body.invoice.id;
  const sent = await request(server, 'POST', `/api/invoices/${id}/send`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.invoice.status, 'SENT');

  const insights = await request(server, 'GET', '/api/insights');
  assert.equal(insights.status, 200);
  assert.ok(insights.body.invoices.some((item) => item.invoiceId === id));

  const reminder = await request(server, 'POST', `/api/invoices/${id}/remind`, {});
  assert.equal(reminder.status, 200);
  assert.equal(reminder.body.invoice.reminderCount, 1);

  const webhook = await request(server, 'POST', '/api/webhooks/simulate', { eventType: 'INVOICING.INVOICE.PAID', invoiceId: id });
  assert.equal(webhook.status, 200);
  assert.equal(webhook.body.invoice.status, 'PAID');
  const bad = await request(server, 'POST', '/api/invoices', { customer: { name: 'Missing Email' }, items: [] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  const missing = await request(server, 'GET', '/api/nope');
  assert.equal(missing.status, 404);
  const unverified = await request(server, 'POST', '/api/webhooks/paypal', { id: 'evt_1', event_type: 'INVOICING.INVOICE.PAID', resource: { invoice_id: id } });
  assert.equal(unverified.status, 400);
  assert.match(unverified.body.error.message, /sandbox adapter/);
});

test('verified PayPal webhook route gates state changes on signature verification', async (t) => {
  const store = createTestStore();
  let verificationInput;
  store.adapter = {
    name: 'paypal-sandbox',
    verifyWebhookSignature: async (input) => { verificationInput = input; return true; }
  };
  const previousWebhookId = process.env.PAYPAL_WEBHOOK_ID;
  process.env.PAYPAL_WEBHOOK_ID = 'WH-DEMO-1';
  const server = createApp({ store, publicDir: 'missing-public', parseInvoice: parseInvoiceText });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.close(); if (previousWebhookId === undefined) delete process.env.PAYPAL_WEBHOOK_ID; else process.env.PAYPAL_WEBHOOK_ID = previousWebhookId; });

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
});
