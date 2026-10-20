'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp } = require('../src/server');
const { InvoiceStore, MockPayPalAdapter, ValidationError, calculateTotals, parseInvoiceText } = require('../src/core');

function createTestStore() {
  return new InvoiceStore({ adapter: new MockPayPalAdapter(), clock: () => '2026-10-20T12:00:00.000Z' });
}

function request(server, method, pathname, body) {
  return new Promise((resolve, reject) => {
    const address = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({ hostname: '127.0.0.1', port: address.port, path: pathname, method, headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {} }, (res) => {
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
});

test('webhook simulation resolves local and PayPal invoice ids', () => {
  const store = createTestStore();
  const result = store.simulateWebhook({ eventType: 'INVOICING.INVOICE.PAID', invoiceId: 'MOCK-INV-SEED-001' });
  assert.equal(result.accepted, true);
  assert.equal(result.invoice.id, 'inv_seed_001');
  assert.equal(result.invoice.status, 'PAID');
  assert.throws(() => store.simulateWebhook({ eventType: 'PAYMENT.SALE.COMPLETED', invoiceId: 'inv_seed_001' }), ValidationError);
});

test('HTTP routes expose state, parse/create/send/webhook flows and strict errors', async (t) => {
  const server = createApp({ store: createTestStore(), publicDir: 'missing-public' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const state = await request(server, 'GET', '/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.body.invoices.length, 2);
  assert.equal(state.body.adapter, 'mock');

  const parsed = await request(server, 'POST', '/api/parse-invoice', { text: 'Invoice for Route Buyer <route@example.com>\n1 design at $100' });
  assert.equal(parsed.status, 200);
  const created = await request(server, 'POST', '/api/invoices', { ...parsed.body.invoice });
  assert.equal(created.status, 201);
  const id = created.body.invoice.id;
  const sent = await request(server, 'POST', `/api/invoices/${id}/send`, {});
  assert.equal(sent.status, 200);
  assert.equal(sent.body.invoice.status, 'SENT');

  const webhook = await request(server, 'POST', '/api/webhooks/simulate', { eventType: 'INVOICING.INVOICE.PAID', invoiceId: id });
  assert.equal(webhook.status, 200);
  assert.equal(webhook.body.invoice.status, 'PAID');
  const bad = await request(server, 'POST', '/api/invoices', { customer: { name: 'Missing Email' }, items: [] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error.code, 'VALIDATION_ERROR');
  const missing = await request(server, 'GET', '/api/nope');
  assert.equal(missing.status, 404);
});
