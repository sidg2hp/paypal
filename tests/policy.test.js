'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { InvoiceStore, MockPayPalAdapter } = require('../src/core');
const { applyPolicyToInsight, evaluateReminder, mergePolicy } = require('../src/policy');

const NOW = '2026-10-20T12:00:00.000Z';

test('policy merge clamps values and keeps safe defaults', () => {
  const policy = mergePolicy({ reminders: { maxReminders: -5, cooldownHours: 999999, minDaysOverdue: 'abc' }, sending: { requireApproval: false } });
  assert.equal(policy.reminders.maxReminders, 0);
  assert.equal(policy.reminders.cooldownHours, 8760);
  assert.equal(policy.reminders.minDaysOverdue, 1);
  assert.equal(policy.sending.requireApproval, false);
  assert.equal(mergePolicy({}).sending.requireApproval, true);
});

test('reminder policy enforces cooldown, minimum amount and reminder limits with named rules', () => {
  const policy = mergePolicy({
    reminders: { cooldownHours: 24, minAmount: 100, maxReminders: 2, minDaysOverdue: 3 }
  });
  const insight = { amount: 250, daysOverdue: 8, nextAction: { action: 'REMIND_INVOICE' } };
  const baseInvoice = { reminderCount: 0, lastRemindedAt: null };

  const allowed = evaluateReminder({ insight, invoice: baseInvoice, policy, now: NOW });
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.ruleId, 'REMINDER_ALLOWED');

  const cooldown = evaluateReminder({ insight, invoice: { reminderCount: 1, lastRemindedAt: '2026-10-20T09:00:00.000Z' }, policy, now: NOW });
  assert.equal(cooldown.allowed, false);
  assert.equal(cooldown.ruleId, 'COOLDOWN_ACTIVE');
  assert.equal(cooldown.decision, 'wait');

  const limit = evaluateReminder({ insight, invoice: { reminderCount: 2 }, policy, now: NOW });
  assert.equal(limit.allowed, false);
  assert.equal(limit.ruleId, 'REMINDER_LIMIT_REACHED');
  assert.equal(limit.decision, 'escalate');

  const small = evaluateReminder({ insight: { ...insight, amount: 50 }, invoice: baseInvoice, policy, now: NOW });
  assert.equal(small.ruleId, 'BELOW_MIN_AMOUNT');

  const early = evaluateReminder({ insight: { ...insight, daysOverdue: 1 }, invoice: baseInvoice, policy, now: NOW });
  assert.equal(early.ruleId, 'NOT_OVERDUE_ENOUGH');
});

test('a blocked reminder changes the next action to an escalation', () => {
  const policy = mergePolicy({ reminders: { maxReminders: 0 } });
  const insight = {
    amount: 250,
    daysOverdue: 8,
    risk: 'CRITICAL',
    urgency: 'CRITICAL',
    reasonCodes: ['OVERDUE'],
    explanation: 'Overdue.',
    nextAction: { action: 'REMIND_INVOICE', priority: 100, label: 'Send reminder' }
  };
  const result = applyPolicyToInsight(insight, { reminderCount: 0 }, policy, NOW);
  assert.equal(result.nextAction.action, 'ESCALATE');
  assert.equal(result.policy.reminder.ruleId, 'REMINDER_LIMIT_REACHED');
  assert.ok(result.reasonCodes.includes('REMINDER_LIMIT_REACHED'));
});

test('send policy caps the largest invoice', () => {
  const policy = mergePolicy({ sending: { maxInvoiceTotal: 100 } });
  const insight = { amount: 500, daysOverdue: 0, risk: 'MEDIUM', urgency: 'HIGH', reasonCodes: ['DRAFT_NOT_SENT'], explanation: 'Draft.', nextAction: { action: 'SEND_INVOICE', priority: 90, label: 'Send invoice' } };
  const result = applyPolicyToInsight(insight, {}, policy, NOW);
  assert.equal(result.nextAction.action, 'REVIEW_LIMIT');
  assert.ok(result.reasonCodes.includes('SEND_LIMIT_EXCEEDED'));
});

test('store exposes the applied policy in state and insights', () => {
  const store = new InvoiceStore({ adapter: new MockPayPalAdapter(), clock: () => NOW, policy: mergePolicy({ reminders: { maxReminders: 2 } }) });
  assert.equal(store.state().policy.reminders.maxReminders, 2);
  assert.equal(store.insights().policy.reminders.maxReminders, 2);
  assert.ok(store.insights().policyDecisions.every((decision) => decision.ruleId));
});
