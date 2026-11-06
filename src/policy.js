'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Policy as data.
 *
 * Every automated recommendation carries the named rule that allowed or blocked
 * it, plus the numeric inputs behind that decision. Judges can read the JSON,
 * change a threshold, and watch the queue respond. The AI never invents policy.
 */
const DEFAULT_POLICY = Object.freeze({
  version: 1,
  description: 'Default collections policy for Cashflow Copilot.',
  reminders: {
    minDaysOverdue: 1,
    cooldownHours: 0,
    maxReminders: 3,
    minAmount: 0,
    escalateAfterReminders: 2
  },
  sending: {
    requireApproval: true,
    maxInvoiceTotal: 100000
  },
  writeOff: {
    afterDaysOverdue: 90,
    maxAmount: 500
  }
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readPolicyFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) throw new Error('policy must be a JSON object');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    const wrapped = new Error(`could not load policy: ${error.message}`);
    wrapped.code = 'POLICY_INVALID';
    throw wrapped;
  }
}

function normalizeNumber(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function mergePolicy(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const reminders = isPlainObject(source.reminders) ? source.reminders : {};
  const sending = isPlainObject(source.sending) ? source.sending : {};
  const writeOff = isPlainObject(source.writeOff) ? source.writeOff : {};
  return {
    version: normalizeNumber(source.version, DEFAULT_POLICY.version, { min: 1, max: 100 }),
    description: typeof source.description === 'string' ? source.description.slice(0, 500) : DEFAULT_POLICY.description,
    reminders: {
      minDaysOverdue: normalizeNumber(reminders.minDaysOverdue, DEFAULT_POLICY.reminders.minDaysOverdue, { max: 365 }),
      cooldownHours: normalizeNumber(reminders.cooldownHours, DEFAULT_POLICY.reminders.cooldownHours, { max: 8760 }),
      maxReminders: normalizeNumber(reminders.maxReminders, DEFAULT_POLICY.reminders.maxReminders, { max: 50 }),
      minAmount: normalizeNumber(reminders.minAmount, DEFAULT_POLICY.reminders.minAmount, { max: 1e9 }),
      escalateAfterReminders: normalizeNumber(reminders.escalateAfterReminders, DEFAULT_POLICY.reminders.escalateAfterReminders, { max: 50 })
    },
    sending: {
      requireApproval: sending.requireApproval === undefined ? DEFAULT_POLICY.sending.requireApproval : Boolean(sending.requireApproval),
      maxInvoiceTotal: normalizeNumber(sending.maxInvoiceTotal, DEFAULT_POLICY.sending.maxInvoiceTotal, { max: 1e9 })
    },
    writeOff: {
      afterDaysOverdue: normalizeNumber(writeOff.afterDaysOverdue, DEFAULT_POLICY.writeOff.afterDaysOverdue, { max: 3650 }),
      maxAmount: normalizeNumber(writeOff.maxAmount, DEFAULT_POLICY.writeOff.maxAmount, { max: 1e9 })
    }
  };
}

function loadPolicy({ env = process.env, filePath = env.POLICY_FILE || path.join(process.cwd(), 'policies', 'collections.json') } = {}) {
  const fromFile = filePath ? readPolicyFile(filePath) : null;
  return mergePolicy(fromFile || {});
}

function evaluateReminder({ insight, invoice, policy, now }) {
  const amount = Number(insight.amount) || 0;
  const reminders = Number(invoice.reminderCount) || 0;
  const daysOverdue = Number(insight.daysOverdue) || 0;
  const base = {
    ruleId: 'REMINDER_ALLOWED',
    rule: 'reminders.minDaysOverdue + reminders.maxReminders + cooldown',
    inputs: { daysOverdue, reminders, amount, lastRemindedAt: invoice.lastRemindedAt || null },
    allowed: true,
    decision: 'allow'
  };

  if (reminders >= policy.reminders.maxReminders) {
    return { ...base, ruleId: 'REMINDER_LIMIT_REACHED', allowed: false, decision: 'escalate', message: `Reminder limit (${policy.reminders.maxReminders}) reached; escalate instead.` };
  }
  if (daysOverdue < policy.reminders.minDaysOverdue) {
    return { ...base, ruleId: 'NOT_OVERDUE_ENOUGH', allowed: false, decision: 'wait', message: `Only ${daysOverdue} days overdue; policy waits for ${policy.reminders.minDaysOverdue}.` };
  }
  if (amount < policy.reminders.minAmount) {
    return { ...base, ruleId: 'BELOW_MIN_AMOUNT', allowed: false, decision: 'skip', message: `Amount ${amount} is below the reminder minimum.` };
  }
  if (policy.reminders.cooldownHours > 0 && invoice.lastRemindedAt) {
    const elapsedHours = (Date.parse(now) - Date.parse(invoice.lastRemindedAt)) / 3600000;
    if (Number.isFinite(elapsedHours) && elapsedHours < policy.reminders.cooldownHours) {
      return { ...base, ruleId: 'COOLDOWN_ACTIVE', allowed: false, decision: 'wait', message: `Last reminder was ${Math.max(0, Math.round(elapsedHours))}h ago; cooldown is ${policy.reminders.cooldownHours}h.` };
    }
  }
  return base;
}

/**
 * Apply policy to a computed insight. This runs after the risk model so the
 * explanation and the permission are separate, inspectable decisions.
 */
function applyPolicyToInsight(insight, invoice, policy, now) {
  const decision = { ...insight };
  decision.policy = {
    version: policy.version,
    sendingRequiresApproval: policy.sending.requireApproval,
    reminder: null
  };
  if (insight.nextAction.action === 'REMIND_INVOICE') {
    const reminder = evaluateReminder({ insight, invoice, policy, now });
    decision.policy.reminder = reminder;
    if (!reminder.allowed) {
      decision.reasonCodes = [...decision.reasonCodes, reminder.ruleId];
      if (reminder.decision === 'escalate') {
        decision.nextAction = { ...insight.nextAction, action: 'ESCALATE', type: 'ESCALATE', label: 'Escalate collection', requiresApproval: false, priority: Math.min(100, insight.nextAction.priority + 5) };
        decision.explanation = `${insight.explanation} ${reminder.message}`;
        decision.urgency = 'CRITICAL';
        decision.risk = 'CRITICAL';
      } else {
        decision.nextAction = { ...insight.nextAction, action: 'REVIEW_POLICY', type: 'REVIEW_POLICY', label: 'Review policy hold', requiresApproval: false };
        decision.explanation = `${insight.explanation} ${reminder.message}`;
      }
    }
  }
  if (insight.nextAction.action === 'SEND_INVOICE' && insight.amount > policy.sending.maxInvoiceTotal) {
    decision.reasonCodes = [...decision.reasonCodes, 'SEND_LIMIT_EXCEEDED'];
    decision.nextAction = { ...insight.nextAction, action: 'REVIEW_LIMIT', type: 'REVIEW_LIMIT', label: 'Review send limit' };
    decision.explanation = `${decision.explanation} The total exceeds the policy send limit of ${policy.sending.maxInvoiceTotal}.`;
  }
  return decision;
}

module.exports = { DEFAULT_POLICY, applyPolicyToInsight, evaluateReminder, loadPolicy, mergePolicy };
