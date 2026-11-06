'use strict';

/**
 * Deterministic evaluation harness for the parser and the agent planner.
 *
 * `npm run eval` is offline and needs no keys. It prints a table and exits
 * non-zero if any golden case regresses, so "the AI fallback is good enough for
 * a demo" is a measured claim rather than an opinion.
 */

const { InvoiceStore, MockPayPalAdapter, parseInvoiceText, ValidationError } = require('../src/core');
const { CopilotAgent } = require('../src/agent');
const { mergePolicy } = require('../src/policy');

const NOW = '2026-11-07T12:00:00.000Z';

const PARSER_CASES = [
  {
    name: 'demo prompt: inline customer before email',
    text: 'Invoice Acme Design Co <accounts@acme.example> for 2 brand review sessions at $125 each, tax 8%, due in 15 days',
    expect: { customer: 'Acme Design Co', email: 'accounts@acme.example', lines: 1, quantity: 2, unitPrice: 125, taxRate: 8, total: 270, dueDate: '2026-11-22', currency: 'USD' }
  },
  {
    name: 'demo prompt: create an invoice for',
    text: 'Create an invoice for Northwind Studio <billing@northwind.example> for 1 cashflow setup at $450, due 2026-11-30',
    expect: { customer: 'Northwind Studio', lines: 1, total: 450, dueDate: '2026-11-30', currency: 'USD' }
  },
  {
    name: 'multi-line invoice with hourly and fixed items',
    text: 'Invoice for Acme Corp <billing@acme.example>\n2 hours consulting at $150/hour\n1 report at $25\ntax 8%\ndue 2026-12-01',
    expect: { customer: 'Acme Corp', lines: 2, subtotal: 325, tax: 26, total: 351, dueDate: '2026-12-01' }
  },
  {
    name: 'labelled bill-to, two items, thousands separator and net terms',
    text: 'Bill to Harbor and Pine, 3 logo sketches at $80 each and 2 revisions at $40 each, 7.5% tax, net 30',
    expect: { customer: 'Harbor and Pine', lines: 2, total: 344, dueDate: '2026-12-07' }
  },
  {
    name: 'thousands separator is not split into a new line item',
    text: 'Invoice Globex for 2 weeks of design at $2,000 per week, tax 0%, due in 2 weeks',
    expect: { customer: 'Globex', lines: 1, quantity: 2, unitPrice: 2000, total: 4000, dueDate: '2026-11-21' }
  },
  {
    name: 'euro symbol sets the currency',
    text: 'Invoice Initech for 1 audit at €900',
    expect: { customer: 'Initech', total: 900, currency: 'EUR' }
  },
  {
    name: 'hourly line item and trailing percentage-first tax',
    text: 'Invoice Umbrella for 3 hours of research at $50/hour, 8.5% tax',
    expect: { customer: 'Umbrella', lines: 1, quantity: 3, unitPrice: 50, taxRate: 8.5, total: 162.75 }
  },
  {
    name: 'two items with per-item tax',
    text: 'Invoice Hooli for 4 sprints at $2,500 each and 1 workshop at $800, tax 7.5%',
    expect: { customer: 'Hooli', lines: 2, subtotal: 10800, tax: 810, total: 11610 }
  }
];

const PLANNER_CASES = [
  { message: 'Who should I chase today?', intent: 'collections_review', expectSteps: true },
  { message: 'send reminders to everyone overdue', intent: 'reminder_batch', expectSteps: true },
  { message: 'What is my 30-day cash forecast?', intent: 'forecast', expectSteps: false },
  { message: 'Invoice Globex for 1 audit at $900 due in 30 days', intent: 'draft_invoice', expectSteps: true },
  { message: 'Create a payment link for Acme Design Co', intent: 'payment_link', expectSteps: true },
  { message: 'Tell me about Acme Design Co', intent: 'explain_invoice', expectSteps: true }
];

function includesAll(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    const found = Array.isArray(actual) ? actual.includes(value) : actual?.[key];
    if (typeof value === 'number') {
      if (Math.abs(Number(found) - value) > 0.001) return `${key}: expected ${value}, got ${found}`;
    } else if (key === 'lines') {
      if (Number(actual?.items?.length) !== value) return `lines: expected ${value}, got ${actual?.items?.length}`;
    } else if (found !== value) {
      return `${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(found)}`;
    }
  }
  return null;
}

function checkParserCase(testCase) {
  try {
    const parsed = parseInvoiceText(testCase.text, { now: new Date(NOW) });
    const flattened = { ...parsed, customer: parsed.customer?.name, email: parsed.customer?.email, lines: parsed.items?.length, quantity: parsed.items?.[0]?.quantity, unitPrice: parsed.items?.[0]?.unitPrice };
    const failure = includesAll(flattened, testCase.expect);
    return failure ? { ok: false, detail: failure } : { ok: true, detail: `${parsed.items.length} line(s) · ${parsed.currency} ${parsed.total.toFixed(2)}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

async function checkPlannerCase(agent, testCase) {
  try {
    const plan = await agent.plan(testCase.message);
    if (plan.intent !== testCase.intent) return { ok: false, detail: `intent ${plan.intent} !== ${testCase.intent}` };
    if (testCase.expectSteps && plan.steps.length === 0) return { ok: false, detail: 'expected at least one proposed step' };
    if (!testCase.expectSteps && plan.steps.length > 0) return { ok: false, detail: `expected no steps, got ${plan.steps.length}` };
    return { ok: true, detail: `${plan.steps.length} step(s) · ${plan.intent}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

function printRow(name, result) {
  const status = result.ok ? 'PASS' : 'FAIL';
  console.log(`  ${status}  ${name.padEnd(56, ' ')} ${result.detail}`);
}

async function main() {
  let failures = 0;
  console.log('Parser goldens (deterministic fallback)');
  for (const testCase of PARSER_CASES) {
    const result = checkParserCase(testCase);
    if (!result.ok) failures += 1;
    printRow(testCase.name, result);
  }

  console.log('\nParser rejects malformed input');
  for (const text of ['hello', 'Invoice nobody for 1 thing at free']) {
    const result = (() => {
      try { parseInvoiceText(text, { now: new Date(NOW) }); return { ok: false, detail: 'expected a ValidationError' }; } catch (error) { return { ok: error instanceof ValidationError, detail: error.message }; }
    })();
    if (!result.ok) failures += 1;
    printRow(JSON.stringify(text), result);
  }

  const store = new InvoiceStore({ adapter: new MockPayPalAdapter(), clock: () => NOW, policy: mergePolicy({}) });
  const agent = new CopilotAgent({ store, env: {}, now: () => NOW, fetchImpl: async () => { throw new Error('offline'); } });
  console.log('\nPlanner intents (deterministic fallback)');
  for (const testCase of PLANNER_CASES) {
    const result = await checkPlannerCase(agent, testCase);
    if (!result.ok) failures += 1;
    printRow(testCase.message, result);
  }

  const total = PARSER_CASES.length + 2 + PLANNER_CASES.length;
  console.log(`\n${total - failures}/${total} golden cases passed.`);
  if (failures) {
    console.error(`${failures} evaluation case(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('eval failed:', error.message);
  process.exitCode = 1;
});
