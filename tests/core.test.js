'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  InvoiceStore,
  MockPayPalAdapter,
  PayPalSandboxAdapter,
  ValidationError,
  allocateTax,
  buildInsights,
  buildPayPalInvoicePayload,
  buildSeedInvoices,
  calculateTotals,
  parseInvoiceText,
  parseInvoiceTextAsync,
  parseInvoiceTextWithMetadataAsync,
  publicInvoiceView,
  resolveAIProvider,
  verifyChain
} = require('../src/core');
const { FilePersistence } = require('../src/persistence');
const { mergePolicy } = require('../src/policy');
const { appendEvent } = require('../src/audit');

const FIXED_NOW = '2026-10-20T12:00:00.000Z';

function createTestStore(options = {}) {
  return new InvoiceStore({
    adapter: new MockPayPalAdapter(),
    clock: () => FIXED_NOW,
    policy: mergePolicy({}),
    ...options
  });
}

test('parser extracts customer, line items, tax, due date and totals offline', () => {
  const parsed = parseInvoiceText('Invoice for Acme Corp <billing@acme.example>\n2 hours consulting at $150/hour\n1 report at $25\ntax 8%\ndue 2026-12-01', { now: new Date('2026-10-20T00:00:00.000Z') });
  assert.equal(parsed.customer.name, 'Acme Corp');
  assert.equal(parsed.customer.email, 'billing@acme.example');
  assert.equal(parsed.subtotal, 325);
  assert.equal(parsed.tax, 26);
  assert.equal(parsed.total, 351);
  assert.equal(parsed.items.length, 2);
  assert.equal(parsed.dueDate, '2026-12-01');
});

test('parser handles the exact demo prompts without dropping the whole line', () => {
  const first = parseInvoiceText('Invoice Acme Design Co <accounts@acme.example> for 2 brand review sessions at $125 each, tax 8%, due in 15 days', { now: new Date('2026-11-07T00:00:00.000Z') });
  assert.equal(first.customer.name, 'Acme Design Co');
  assert.equal(first.customer.email, 'accounts@acme.example');
  assert.deepEqual(first.items, [{ description: 'brand review sessions', quantity: 2, unitPrice: 125, amount: 250 }]);
  assert.equal(first.taxRate, 8);
  assert.equal(first.total, 270);
  assert.equal(first.dueDate, '2026-11-22');

  const second = parseInvoiceText('Create an invoice for Northwind Studio <billing@northwind.example> for 1 cashflow setup at $450, due 2026-11-30', { now: new Date('2026-11-07T00:00:00.000Z') });
  assert.equal(second.customer.name, 'Northwind Studio');
  assert.equal(second.total, 450);
  assert.equal(second.dueDate, '2026-11-30');
});

test('parser never turns an invoice header or customer email into a line item', () => {
  const sandboxEmail = 'sb-vj6st53751629@personal.example.com';
  const variants = [
    `Invoice Acme Design Co ${sandboxEmail} 1 brand review session at $125, tax 8%, due in 15 days`,
    `Invoice Acme Design Co <${sandboxEmail}> 1 brand review session at $125, tax 8%, due in 15 days`,
    `Invoice Acme Design Co ${sandboxEmail} for a brand review session at $125, tax 8%, due in 15 days`,
    `Invoice Acme Design Co ${sandboxEmail} 1 brand review session at 125, tax 8%, due in 15 days`,
    `Invoice Acme Design Co <${sandboxEmail}> 1 brand review session at $125\ntax 8%\ndue in 15 days`
  ];
  for (const text of variants) {
    const parsed = parseInvoiceText(text, { now: new Date('2026-11-11T00:00:00.000Z') });
    assert.equal(parsed.customer.name, 'Acme Design Co');
    assert.equal(parsed.customer.email, sandboxEmail);
    assert.deepEqual(parsed.items, [{ description: 'brand review session', quantity: 1, unitPrice: 125, amount: 125 }]);
    assert.equal(parsed.total, 135);
    assert.equal(parsed.dueDate, '2026-11-26');
    assert.equal(/@/.test(parsed.items[0].description), false);
  }

  const noEmail = parseInvoiceText('Invoice Acme Design Co 1 brand review session at $125, tax 8%, due in 15 days', { now: new Date('2026-11-11T00:00:00.000Z') });
  assert.equal(noEmail.customer.name, 'Acme Design Co');
  assert.deepEqual(noEmail.items, [{ description: 'brand review session', quantity: 1, unitPrice: 125, amount: 125 }]);
  assert.equal(noEmail.total, 135);
});

test('parser handles labels, multiple items, thousands separators, net terms and currency symbols', () => {
  const bill = parseInvoiceText('Bill to Harbor and Pine, 3 logo sketches at $80 each and 2 revisions at $40 each, 7.5% tax, net 30', { now: new Date('2026-11-07T00:00:00.000Z') });
  assert.equal(bill.customer.name, 'Harbor and Pine');
  assert.equal(bill.items.length, 2);
  assert.equal(bill.items[0].quantity, 3);
  assert.equal(bill.total, 344);
  assert.equal(bill.dueDate, '2026-12-07');

  const euros = parseInvoiceText('Invoice Globex for 2 weeks of design at $2,000 per week, tax 0%, due in 2 weeks', { now: new Date('2026-11-07T00:00:00.000Z') });
  assert.equal(euros.customer.name, 'Globex');
  assert.equal(euros.items[0].unitPrice, 2000);
  assert.equal(euros.total, 4000);
  assert.equal(euros.dueDate, '2026-11-21');

  const symbol = parseInvoiceText('Invoice Initech for 1 audit at €900', { now: new Date('2026-11-07T00:00:00.000Z') });
  assert.equal(symbol.currency, 'EUR');
  assert.equal(symbol.total, 900);
});

test('totals use rounded cents and reject invalid items', () => {
  assert.deepEqual(calculateTotals([{ description: 'Fractional', quantity: 3, unitPrice: 0.1 }], 7.5), { items: [{ description: 'Fractional', quantity: 3, unitPrice: 0.1, amount: 0.3 }], subtotal: 0.3, taxRate: 7.5, tax: 0.02, total: 0.32 });
  assert.throws(() => calculateTotals([], 0), ValidationError);
  assert.throws(() => calculateTotals([{ description: 'Bad', quantity: 1, unitPrice: -1 }], 0), ValidationError);
  assert.throws(() => calculateTotals([{ description: 'Bad tax', quantity: 1, unitPrice: 10 }], 101), ValidationError);
});

test('PayPal invoice payload allocates tax per item so PayPal totals match the app', () => {
  const invoice = { id: 'inv_test_001', customer: { name: 'Tax Buyer', email: 'tax@example.com' }, currency: 'USD', dueDate: '2026-12-01', notes: 'Thanks', reference: null, items: [{ description: 'A', quantity: 3, unitPrice: 10, amount: 30 }, { description: 'B', quantity: 1, unitPrice: 5.1, amount: 5.1 }], subtotal: 35.1, taxRate: 7.5, tax: 2.63, total: 37.73 };
  const payload = buildPayPalInvoicePayload(invoice);
  assert.equal(payload.detail.currency_code, 'USD');
  assert.equal(payload.detail.payment_term.due_date, '2026-12-01');
  assert.equal(payload.items.length, 2);
  const taxTotal = payload.items.reduce((sum, item) => sum + Number(item.tax?.amount?.value || 0), 0);
  const itemTotal = payload.items.reduce((sum, item) => sum + Number(item.unit_amount.value) * Number(item.quantity), 0);
  assert.equal(Math.round((taxTotal + itemTotal) * 100) / 100, invoice.total);
  assert.deepEqual(allocateTax(invoice.items, invoice.tax).map((value) => Math.round(value * 100)), [225, 38]);
});

test('seed data is relative to now and always contains one overdue, one paid and one draft invoice', () => {
  const seeds = buildSeedInvoices({ now: FIXED_NOW });
  assert.equal(seeds.length, 4);
  assert.equal(seeds.find((invoice) => invoice.id === 'inv_seed_002').dueDate, '2026-10-12');
  assert.equal(seeds.find((invoice) => invoice.id === 'inv_seed_002').status, 'SENT');
  assert.equal(seeds.find((invoice) => invoice.id === 'inv_seed_003').status, 'PAID');
  assert.equal(seeds.find((invoice) => invoice.id === 'inv_seed_004').status, 'DRAFT');
  assert.ok(seeds.every((invoice) => invoice.payToken && invoice.payToken.length >= 20));
  assert.ok(seeds.every((invoice) => verifyChain(invoice.events).valid));
});

test('store creates and sends an invoice through mock PayPal with an audit chain', async () => {
  const store = createTestStore();
  const created = store.createInvoice({ customer: { name: 'Demo Buyer', email: 'buyer@example.com' }, items: [{ description: 'Analysis', quantity: 2, unitPrice: 80 }], taxRate: 5 });
  assert.equal(created.status, 'DRAFT');
  assert.equal(created.total, 168);
  assert.equal(created.payToken.length >= 20, true);
  const sent = await store.sendInvoice(created.id);
  assert.equal(sent.status, 'SENT');
  assert.equal(sent.paypalInvoiceId, 'MOCK-INV-0001');
  assert.equal(sent.events.at(-1).type, 'INVOICING.INVOICE.SENT');
  assert.ok(sent.events.at(-1).hash);
  assert.equal(store.verifyAudit().valid, true);
  await assert.rejects(() => store.sendInvoice(created.id), /already been sent/);
});

test('webhook simulation resolves ids and ignores stale and refunded transitions', () => {
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

  const refunded = store.simulateWebhook({ id: 'evt_refund_1', eventType: 'INVOICING.INVOICE.REFUNDED', invoiceId: 'inv_seed_001' });
  assert.equal(refunded.invoice.status, 'REFUNDED');
  const afterRefund = store.simulateWebhook({ id: 'evt_paid_2', eventType: 'INVOICING.INVOICE.PAID', invoiceId: 'inv_seed_001' });
  assert.equal(afterRefund.stale, true);
  assert.equal(afterRefund.invoice.status, 'REFUNDED');

  for (const [eventType, status] of [['INVOICING.INVOICE.CANCELLED', 'CANCELLED'], ['INVOICING.INVOICE.VOIDED', 'VOID']]) {
    const terminalStore = createTestStore();
    const closed = terminalStore.simulateWebhook({ eventType, invoiceId: 'inv_seed_001' });
    assert.equal(closed.invoice.status, status);
  }
});

test('insights explain risk, apply policy, and project payer-adjusted cash', () => {
  const store = createTestStore();
  const insights = store.insights();
  const overdue = insights.invoices.find((item) => item.invoiceId === 'inv_seed_002');
  assert.equal(overdue.status, 'SENT');
  assert.equal(overdue.risk, 'CRITICAL');
  assert.equal(overdue.daysOverdue, 8);
  assert.equal(overdue.nextAction.type, 'REMIND_INVOICE');
  assert.equal(overdue.policy.reminder.ruleId, 'REMINDER_ALLOWED');
  assert.ok(overdue.reasonCodes.includes('OVERDUE'));
  assert.ok(overdue.expectedPaymentDate);
  assert.equal(overdue.forecastBasis, 'due_date');
  assert.equal(insights.projectedCashPosition['7'].USD, 250);
  assert.equal(insights.projectedCashPosition['30'].USD, 737.13);
  assert.equal(insights.nextAction.invoiceId, 'inv_seed_002');
  assert.equal(insights.summary.overdueCount, 1);
  assert.equal(insights.summary.draftCount, 1);
  assert.ok(insights.summary.healthScore < 100);
  assert.ok(insights.policyDecisions.length >= 1);
});

test('policy blocks the reminder limit and escalates instead', async () => {
  const store = createTestStore({ policy: mergePolicy({ reminders: { maxReminders: 1, minDaysOverdue: 1 } }) });
  await store.remindInvoice('inv_seed_002');
  const insight = store.insights().invoices.find((item) => item.invoiceId === 'inv_seed_002');
  assert.equal(insight.nextAction.action, 'ESCALATE');
  assert.equal(insight.policy.reminder.ruleId, 'REMINDER_LIMIT_REACHED');
});

test('reminder and cancellation record hash-chained timeline events', async () => {
  const adapter = new MockPayPalAdapter();
  const store = new InvoiceStore({ adapter, clock: () => FIXED_NOW, policy: mergePolicy({}) });
  const invoice = await store.remindInvoice('inv_seed_002');
  assert.equal(invoice.reminderCount, 1);
  assert.deepEqual(adapter.reminders, ['MOCK-INV-SEED-002']);
  assert.equal(invoice.events.at(-1).type, 'INVOICING.INVOICE.REMINDER_SENT');
  assert.ok(invoice.events.at(-1).prevHash);
  const cancelled = await store.cancelInvoice('inv_seed_002');
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(store.verifyAudit().valid, true);
});

test('checkout creates an order, captures it, and marks the invoice paid exactly once', async () => {
  const store = createTestStore();
  const { order, invoice } = await store.ensurePaymentOrder('inv_seed_001', { baseUrl: 'https://demo.example' });
  assert.equal(order.status, 'CREATED');
  assert.equal(order.mock, true);
  assert.ok(invoice.paypalOrderId);
  const first = await store.capturePayment('inv_seed_001', { orderId: order.id });
  assert.equal(first.invoice.status, 'PAID');
  assert.equal(first.duplicate, false);
  const second = await store.capturePayment('inv_seed_001', { orderId: order.id });
  assert.equal(second.duplicate, true);
  assert.equal(store.verifyAudit().valid, true);
  const view = publicInvoiceView(store.getInvoice('inv_seed_001'));
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'paypalInvoiceId'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(view, 'events'), false);
});

test('recordPayment handles a verified capture webhook without calling capture again', () => {
  const store = createTestStore();
  const result = store.recordPayment('inv_seed_001', { source: 'paypal', verified: true, eventId: 'CAP-1', detail: { captureId: 'CAP-1', amount: 487.13 } });
  assert.equal(result.invoice.status, 'PAID');
  assert.equal(result.invoice.paymentReference, 'CAP-1');
  const duplicate = store.recordPayment('inv_seed_001', { source: 'paypal', verified: true, eventId: 'CAP-1' });
  assert.equal(duplicate.duplicate, true);
});

test('audit chain detects tampering', () => {
  const store = createTestStore();
  const invoice = store.getInvoice('inv_seed_002');
  invoice.events[0].type = 'TAMPERED';
  const result = store.verifyAudit();
  assert.equal(result.valid, false);
  assert.equal(result.failures[0].invoiceId, 'inv_seed_002');
  assert.equal(verifyChain(invoice.events).valid, false);
});

test('audit append is deterministic for identical events', () => {
  const first = [];
  const second = [];
  appendEvent(first, { type: 'X', at: '2026-01-01T00:00:00.000Z' });
  appendEvent(second, { type: 'X', at: '2026-01-01T00:00:00.000Z' });
  assert.equal(first[0].hash, second[0].hash);
  appendEvent(first, { type: 'Y', at: '2026-01-02T00:00:00.000Z' });
  assert.equal(first[1].prevHash, first[0].hash);
});

test('optional file persistence restores invoices, sequence and audit chain', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-store-'));
  const file = path.join(directory, 'store.json');
  try {
    const persistence = new FilePersistence(file, { debounceMs: 0 });
    const store = new InvoiceStore({ adapter: new MockPayPalAdapter(), clock: () => FIXED_NOW, policy: mergePolicy({}), persistence });
    const created = store.createInvoice({ customer: { name: 'Persisted Buyer', email: 'persist@example.com' }, items: [{ description: 'Saved', quantity: 1, unitPrice: 42 }] });
    await store.persist?.();
    await persistence.flush();
    const restoredPersistence = new FilePersistence(file, { debounceMs: 0 });
    const restored = new InvoiceStore({ adapter: new MockPayPalAdapter(), clock: () => FIXED_NOW, policy: mergePolicy({}), persistence: restoredPersistence });
    assert.equal(restored.restored, true);
    assert.ok(restored.getInvoice(created.id));
    assert.equal(restored.getInvoice(created.id).payToken, created.payToken);
    assert.equal(restored.verifyAudit().valid, true);
    assert.equal(restored.sequence, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('sandbox adapter uses documented PayPal endpoints and rejects untrusted cert URLs', async () => {
  const calls = [];
  const adapter = new PayPalSandboxAdapter({
    clientId: 'client',
    clientSecret: 'secret',
    baseUrl: 'https://sandbox.test',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/token')) return { ok: true, status: 200, json: async () => ({ access_token: 'token', expires_in: 300 }) };
      if (url.endsWith('/verify-webhook-signature')) return { ok: true, status: 200, json: async () => ({ verification_status: 'SUCCESS' }) };
      if (url.endsWith('/v2/checkout/orders')) return { ok: true, status: 200, json: async () => ({ id: 'ORDER-1', status: 'CREATED', links: [{ rel: 'approve', href: 'https://paypal.test/approve' }] }) };
      if (url.endsWith('/capture')) return { ok: true, status: 200, json: async () => ({ id: 'ORDER-1', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP-1', amount: { value: '10.00', currency_code: 'USD' } }] } }] }) };
      return { ok: true, status: 200, json: async () => ({}) };
    }
  });
  const invoice = { id: 'inv_remote_1', customer: { name: 'Remote', email: 'remote@example.com' }, currency: 'USD', dueDate: '2026-12-01', notes: null, reference: null, items: [{ description: 'Work', quantity: 1, unitPrice: 10, amount: 10 }], subtotal: 10, taxRate: 0, tax: 0, total: 10 };
  const order = await adapter.createOrder(invoice, { returnUrl: 'https://demo.example/pay/token', cancelUrl: 'https://demo.example/pay/token' });
  assert.equal(order.id, 'ORDER-1');
  assert.equal(order.approveUrl, 'https://paypal.test/approve');
  assert.equal(calls.at(-1).url, 'https://sandbox.test/v2/checkout/orders');
  const captured = await adapter.captureOrder('ORDER-1');
  assert.equal(captured.captureId, 'CAP-1');
  assert.equal(calls.at(-1).url, 'https://sandbox.test/v2/checkout/orders/ORDER-1/capture');

  const signature = { transmissionId: 't1', transmissionTime: 'now', certUrl: 'https://api-m.sandbox.paypal.com/cert', authAlgo: 'SHA256withRSA', transmissionSig: 'sig', webhookId: 'wh_1', webhookEvent: { id: 'evt_1' } };
  assert.equal(await adapter.verifyWebhookSignature(signature), true);
  assert.equal(await adapter.verifyWebhookSignature({ ...signature, certUrl: 'https://evil.example/cert' }), false);
  assert.equal(await adapter.verifyWebhookSignature({ ...signature, certUrl: 'http://api-m.sandbox.paypal.com/cert' }), false);

  const failing = new PayPalSandboxAdapter({
    clientId: ' client-id ',
    clientSecret: ' secret ',
    baseUrl: 'https://api-m.sandbox.paypal.com',
    fetchImpl: async () => ({
      ok: false,
      status: 401,
      headers: { get: (name) => name === 'paypal-debug-id' ? 'debug-401' : null },
      json: async () => ({ error: 'invalid_client', error_description: 'Client Authentication failed' })
    })
  });
  await assert.rejects(() => failing.accessToken(), (error) => {
    assert.equal(error.code, 'PAYPAL_ERROR');
    assert.match(error.message, /401/);
    assert.match(error.message, /invalid_client/);
    assert.match(error.message, /Client Authentication failed/);
    assert.equal(error.details.status, 401);
    assert.equal(error.details.environment, 'sandbox');
    assert.equal(error.details.debugId, 'debug-401');
    assert.equal(JSON.stringify(error.details).includes('secret'), false);
    return true;
  });
  assert.equal(failing.clientId, 'client-id');
  assert.equal(failing.clientSecret, 'secret');

  const forbidden = new PayPalSandboxAdapter({
    clientId: 'client-id',
    clientSecret: 'secret',
    baseUrl: 'https://api-m.sandbox.paypal.com',
    fetchImpl: async (url) => {
      if (url.endsWith('/v1/oauth2/token')) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ access_token: 'token', expires_in: 300, scope: 'https://uri.paypal.com/services/payments' }) };
      }
      return {
        ok: false,
        status: 403,
        headers: { get: (name) => name === 'paypal-debug-id' ? 'debug-403' : null },
        json: async () => ({ name: 'NOT_AUTHORIZED', message: 'Authorization failed due to insufficient permissions.' })
      };
    }
  });
  await assert.rejects(() => forbidden.createInvoice(invoice), (error) => {
    assert.match(error.message, /403/);
    assert.match(error.message, /NOT_AUTHORIZED/);
    assert.match(error.message, /Invoicing scope/);
    assert.equal(error.details.status, 403);
    assert.equal(error.details.hasInvoicingScope, false);
    assert.equal(error.details.debugId, 'debug-403');
    return true;
  });
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

test('provider aliases use explicit xAI base URLs, models, and bearer headers', async () => {
  let call;
  const result = await parseInvoiceTextWithMetadataAsync('anything', {
    env: { AI_PROVIDER: 'grok/xai', XAI_API_KEY: 'xai-key', XAI_BASE_URL: 'https://xai.test/v1', XAI_MODEL: 'grok-test' },
    fetchImpl: async (url, options) => {
      call = { url, options };
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ customer: { name: 'xAI Buyer', email: 'xai@example.com' }, items: [{ description: 'Work', quantity: 1, unitPrice: 25 }], currency: 'USD', dueDate: null }) } }] }) };
    }
  });
  assert.equal(call.url, 'https://xai.test/v1/chat/completions');
  assert.equal(call.options.headers.Authorization, 'Bearer xai-key');
  assert.equal(JSON.parse(call.options.body).model, 'grok-test');
  assert.deepEqual(result.ai, { provider: 'xai', mode: 'ai', model: 'grok-test', fallback: false, reason: null });
});

test('auto provider prefers configured cloud keys without probing external services', async () => {
  let calls = 0;
  const resolved = await resolveAIProvider({
    env: { AI_PROVIDER: 'auto', OPENAI_API_KEY: 'openai-key', XAI_API_KEY: 'xai-key', GEMINI_API_KEY: 'gemini-key', OLLAMA_PROBE_URL: 'http://unique-auto-priority.test/api/tags' },
    fetchImpl: async () => { calls += 1; throw new Error('probe should not run'); }
  });
  assert.equal(resolved.provider, 'openai');
  assert.equal(resolved.model, 'gpt-4o-mini');
  assert.equal(calls, 0);
});

test('auto provider detects local Ollama and caches the bounded probe', async () => {
  const calls = [];
  const env = { AI_PROVIDER: 'auto', OLLAMA_PROBE_URL: 'http://unique-ollama.test/api/tags', OLLAMA_BASE_URL: 'http://unique-ollama.test/v1', OLLAMA_MODEL: 'local-test' };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/tags')) return { ok: true, status: 200 };
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify({ customer: { name: 'Local Buyer', email: 'local@example.com' }, items: [{ description: 'Local work', quantity: 1, unitPrice: 40 }], currency: 'USD', dueDate: null }) } }] }) };
  };
  const first = await parseInvoiceTextWithMetadataAsync('anything', { env, fetchImpl });
  const second = await parseInvoiceTextWithMetadataAsync('anything', { env, fetchImpl });
  assert.equal(first.ai.provider, 'ollama');
  assert.equal(second.ai.provider, 'ollama');
  assert.equal(calls.filter((call) => call.url.endsWith('/api/tags')).length, 1);
  assert.equal(calls.filter((call) => call.url.endsWith('/chat/completions')).length, 2);
});

test('metadata reports deterministic fallback when a selected provider fails', async () => {
  const result = await parseInvoiceTextWithMetadataAsync('Invoice for Metadata Buyer <metadata@example.com>\n1 audit at $100', {
    env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'http://metadata.test/v1' },
    fetchImpl: async () => { throw new Error('offline'); }
  });
  assert.equal(result.ai.provider, 'deterministic');
  assert.equal(result.ai.mode, 'deterministic');
  assert.equal(result.ai.fallback, true);
  assert.match(result.ai.reason, /openai/i);
  assert.equal(result.invoice.total, 100);
});

test('buildInsights is pure and does not mutate invoices', () => {
  const store = createTestStore();
  const invoices = store.listInvoices();
  const before = JSON.stringify(invoices);
  buildInsights(invoices, { now: FIXED_NOW });
  assert.equal(JSON.stringify(invoices), before);
});
