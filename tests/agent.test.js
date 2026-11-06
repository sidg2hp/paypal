'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CopilotAgent } = require('../src/agent');
const { InvoiceStore, MockPayPalAdapter } = require('../src/core');
const { mergePolicy } = require('../src/policy');

const NOW = '2026-10-20T12:00:00.000Z';

function createAgent(options = {}) {
  const store = new InvoiceStore({ adapter: new MockPayPalAdapter(), clock: () => NOW, policy: mergePolicy({}) });
  const agent = new CopilotAgent({ store, env: {}, now: () => NOW, fetchImpl: async () => { throw new Error('no network in tests'); }, ...options });
  return { store, agent };
}

test('collections review returns a ranked plan without executing anything', async () => {
  const { store, agent } = createAgent();
  const plan = await agent.plan('Who should I chase today?');
  assert.equal(plan.intent, 'collections_review');
  assert.ok(plan.steps.length >= 1);
  assert.equal(plan.steps[0].type, 'remind_invoice');
  assert.equal(plan.steps[0].invoiceId, 'inv_seed_002');
  assert.match(plan.steps[0].summary, /Acme Design Co/);
  assert.match(plan.steps[0].summary, /\$250\.00/);
  assert.equal(store.getInvoice('inv_seed_002').status, 'SENT');
  assert.equal(plan.ai.provider, 'deterministic');
});

test('executing a plan runs only the approved steps', async () => {
  const { store, agent } = createAgent();
  const plan = await agent.plan('who needs attention?');
  assert.ok(plan.steps.length >= 2);
  const result = await agent.execute(plan.id, [plan.steps[0].id]);
  assert.equal(result.executed, 1);
  assert.equal(result.results.length, 1);
  assert.equal(store.getInvoice(plan.steps[0].invoiceId).status, 'SENT');
  assert.equal(store.getInvoice(plan.steps[0].invoiceId).reminderCount, 1);
  if (plan.steps[1]) assert.equal(store.getInvoice(plan.steps[1].invoiceId).status, 'DRAFT');
});

test('reminder batch targets overdue invoices and executes through PayPal adapter', async () => {
  const { store, agent } = createAgent();
  const plan = await agent.plan('send reminders to everyone overdue');
  assert.equal(plan.intent, 'reminder_batch');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].invoiceId, 'inv_seed_002');
  const result = await agent.execute(plan.id, plan.steps.map((step) => step.id));
  assert.equal(result.executed, 1);
  assert.equal(store.getInvoice('inv_seed_002').events.at(-1).source, 'mock');
});

test('forecast intent answers with payer-adjusted numbers and no steps', async () => {
  const { agent } = createAgent();
  const plan = await agent.plan('What is my 30-day cash forecast?');
  assert.equal(plan.intent, 'forecast');
  assert.equal(plan.steps.length, 0);
  assert.match(plan.answer, /30 days/);
  assert.match(plan.answer, /\$/);
});

test('invoice intent produces an editable draft proposal', async () => {
  const { agent } = createAgent();
  const plan = await agent.plan('Invoice Globex for 1 audit at $900 due in 30 days');
  assert.equal(plan.intent, 'draft_invoice');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].execution, 'client');
  assert.equal(plan.steps[0].payload.invoice.customer.name, 'Globex');
  assert.equal(plan.steps[0].payload.invoice.total, 900);
});

test('payment link intent proposes a checkout link and execution returns a pay URL', async () => {
  const { store, agent } = createAgent();
  const plan = await agent.plan('Create a payment link for Acme Design Co');
  assert.equal(plan.intent, 'payment_link');
  assert.equal(plan.steps[0].type, 'create_payment_link');
  const result = await agent.execute(plan.id, [plan.steps[0].id], { baseUrl: 'https://demo.example' });
  assert.equal(result.executed, 1);
  assert.match(result.results[0].payUrl, /^\/pay\//);
  assert.ok(store.getInvoice('inv_seed_002').paypalOrderId);
});

test('explain intent uses the computed insight and can propose a reminder', async () => {
  const { agent } = createAgent();
  const plan = await agent.plan('Tell me about Acme Design Co');
  assert.equal(plan.intent, 'explain_invoice');
  assert.match(plan.answer, /Acme Design Co/);
  assert.match(plan.answer, /past due/i);
  assert.equal(plan.steps[0]?.type, 'remind_invoice');
});

test('unknown requests fall back to a portfolio review instead of an error', async () => {
  const { agent } = createAgent();
  const plan = await agent.plan('hello there, what can you do?');
  assert.ok(['greeting', 'portfolio_review', 'collections_review'].includes(plan.intent));
  assert.ok(plan.answer.length > 20);
});

test('expired plans are rejected before execution', async () => {
  const { agent } = createAgent();
  const plan = await agent.plan('who should I chase?');
  agent.plans.get(plan.id).expiresAt = Date.now() - 1;
  await assert.rejects(() => agent.execute(plan.id, [plan.steps[0].id]), /expired/);
});

test('missing approved steps are rejected', async () => {
  const { agent } = createAgent();
  const plan = await agent.plan('who should I chase?');
  await assert.rejects(() => agent.execute(plan.id, []), /approvedStepIds/);
});

test('configured model plans are validated against real invoice ids and allowed tools', async () => {
  const { agent } = createAgent({
    env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://planner.test/v1' },
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://planner.test/v1/chat/completions');
      const body = JSON.parse(options.body);
      assert.match(body.messages[0].content, /remind_invoice/);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{
            message: {
              content: JSON.stringify({
                intent: 'collections_review',
                answer: 'Acme is eight days late; send the policy-approved reminder.',
                actions: [
                  { tool: 'remind_invoice', invoiceId: 'inv_seed_002' },
                  { tool: 'remind_invoice', invoiceId: 'invented-invoice' },
                  { tool: 'delete_everything', invoiceId: 'inv_seed_001' },
                  { tool: 'send_invoice', invoiceId: 'inv_seed_001' }
                ]
              })
            }
          }]
        })
      };
    }
  });
  const plan = await agent.plan('who should I chase?');
  assert.equal(plan.ai.provider, 'openai');
  assert.equal(plan.ai.fallback, false);
  assert.equal(plan.answer, 'Acme is eight days late; send the policy-approved reminder.');
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].invoiceId, 'inv_seed_002');
  assert.equal(plan.steps[0].type, 'remind_invoice');
});

test('invalid model output falls back to the deterministic plan', async () => {
  const { agent } = createAgent({
    env: { AI_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key', OPENAI_BASE_URL: 'https://planner.test/v1' },
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'not json' } }] }) })
  });
  const plan = await agent.plan('who should I chase?');
  assert.equal(plan.ai.fallback, true);
  assert.match(plan.ai.reason, /unavailable/);
  assert.ok(plan.steps.length >= 1);
});
