'use strict';

/**
 * Real PayPal Sandbox evidence run.
 *
 * This is the only script that makes live network calls to PayPal. It creates,
 * sends, reads back, and reminds a sandbox invoice, then writes a timestamped
 * JSON evidence file with PayPal-Debug-Id values. Run it with sandbox
 * credentials before submission and commit the resulting file under
 * docs/sandbox-evidence/.
 *
 * It never prints the client id or secret, and it does not capture any headers.
 */

const fs = require('node:fs');
const path = require('node:path');
const { InvoiceStore, createPayPalAdapter } = require('../src/core');

function timestamp() {
  return new Date().toISOString();
}

function fileStamp() {
  return timestamp().replace(/[:.]/g, '-');
}

async function main() {
  const env = process.env;
  if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) {
    console.error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required for a real sandbox evidence run.');
    console.error('Set them, then re-run: npm run sandbox:check');
    process.exitCode = 2;
    return;
  }

  const adapter = createPayPalAdapter(env);
  if (adapter.name !== 'paypal-sandbox') {
    console.error('The sandbox adapter was not selected. Check both PayPal credentials.');
    process.exitCode = 2;
    return;
  }

  const store = new InvoiceStore({ adapter, clock: () => new Date().toISOString() });
  const customerEmail = env.SANDBOX_TEST_EMAIL || 'sb-buyer@business.example.com';
  const evidence = {
    generatedAt: timestamp(),
    mode: 'paypal-sandbox',
    baseUrl: adapter.baseUrl,
    customerEmail,
    steps: [],
    outcome: 'started',
    note: 'Real PayPal Sandbox API calls. No secrets are recorded. Verify ids in the PayPal Developer Dashboard.'
  };

  try {
    const invoice = store.createInvoice({
      customer: { name: 'Cashflow Copilot Sandbox Buyer', email: customerEmail },
      currency: env.SANDBOX_TEST_CURRENCY || 'USD',
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10),
      items: [{ description: 'Sandbox evidence run', quantity: 1, unitPrice: 12.34 }],
      taxRate: 0,
      notes: 'Created by scripts/sandbox-check.js to verify the PayPal Invoicing integration.'
    });
    evidence.invoice = { id: invoice.id, total: invoice.total, currency: invoice.currency, dueDate: invoice.dueDate };

    adapter.lastDebugId = null;
    const sent = await store.sendInvoice(invoice.id);
    evidence.steps.push({
      action: 'create + send invoice',
      paypalInvoiceId: sent.paypalInvoiceId,
      status: sent.status,
      debugId: adapter.lastDebugId || null
    });

    adapter.lastDebugId = null;
    const remote = await adapter.getInvoice(sent.paypalInvoiceId);
    evidence.steps.push({
      action: 'read back invoice',
      status: remote?.status || null,
      remoteTotal: remote?.amount?.value || null,
      remoteCurrency: remote?.amount?.currency_code || null,
      debugId: adapter.lastDebugId || null
    });
    evidence.remote = {
      status: remote?.status || null,
      total: remote?.amount?.value || null,
      currency: remote?.amount?.currency_code || null,
      recipient: remote?.primary_recipients?.[0]?.billing_info?.email_address || null
    };

    adapter.lastDebugId = null;
    const reminded = await store.remindInvoice(invoice.id);
    evidence.steps.push({
      action: 'send reminder',
      paypalInvoiceId: reminded.paypalInvoiceId,
      status: reminded.status,
      reminderCount: reminded.reminderCount,
      debugId: adapter.lastDebugId || null
    });

    evidence.outcome = 'success';
    evidence.auditValid = store.verifyAudit().valid;
  } catch (error) {
    evidence.outcome = 'failed';
    evidence.error = { name: error.name || 'Error', code: error.code || null, message: error.message || 'unknown' };
    evidence.steps.push({ action: 'aborted', debugId: adapter.lastDebugId || null });
    process.exitCode = 1;
  }

  const directory = path.join(process.cwd(), 'docs', 'sandbox-evidence');
  fs.mkdirSync(directory, { recursive: true });
  const output = path.join(directory, `${fileStamp()}.json`);
  fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`Sandbox evidence: ${evidence.outcome}`);
  for (const step of evidence.steps) console.log(`  ${step.action}: ${step.status || step.message || ''}${step.debugId ? ` · PayPal-Debug-Id ${step.debugId}` : ''}`);
  console.log(`  wrote ${path.relative(process.cwd(), output)}`);
  if (evidence.outcome !== 'success') console.error('Sandbox run failed. The evidence file records the error for debugging.');
}

main().catch((error) => {
  console.error('sandbox check failed:', error.message);
  process.exitCode = 1;
});
