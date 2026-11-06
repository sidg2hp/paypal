'use strict';

const crypto = require('node:crypto');
const { ValidationError, parseInvoiceText, resolveAIProvider } = require('./core');

/**
 * Cashflow Copilot agent.
 *
 * The agent has two jobs:
 *   1. Turn a merchant question into an explainable answer backed by real data.
 *   2. Propose a short list of concrete actions. It never executes anything
 *      itself: the merchant approves individual steps, then `execute()` runs
 *      only those approved steps through the existing InvoiceStore methods.
 *
 * The deterministic planner is the default so the demo works offline. When an
 * OpenAI-compatible provider is configured, the planner asks the model for a
 * JSON plan and validates every action against the same allowlist before the
 * merchant ever sees it.
 */

const PLAN_TTL_MS = 15 * 60 * 1000;
const MAX_PLANS = 40;
const MAX_STEPS = 8;

const ACTION_TYPES = Object.freeze({
  remind_invoice: { label: 'Send reminder', method: 'remindInvoice', approval: true },
  send_invoice: { label: 'Send invoice', method: 'sendInvoice', approval: true },
  cancel_invoice: { label: 'Cancel invoice', method: 'cancelInvoice', approval: true },
  create_payment_link: { label: 'Create PayPal payment link', method: 'ensurePaymentOrder', approval: true },
  draft_invoice: { label: 'Review invoice draft', method: null, approval: true }
});

function normalize(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function money(amount, currency = 'USD') {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(amount || 0));
}

function todaysInsights(store) {
  return store.insights();
}

function findInvoiceByHint(invoices, hint) {
  const normalized = normalize(hint);
  if (!normalized) return null;
  const tokens = normalized.split(' ').filter((token) => token.length > 2);
  let best = null;
  let bestScore = 0;
  for (const invoice of invoices) {
    const customer = normalize(invoice.customer?.name);
    let score = 0;
    if (customer === normalized) score = 100;
    else if (customer.includes(normalized) || normalized.includes(customer)) score = 80;
    else score = tokens.filter((token) => customer.includes(token)).length * 15;
    const invoiceId = invoice?.id || invoice?.invoiceId;
    if (invoiceId === hint) score = 120;
    if (score > bestScore) { best = invoice; bestScore = score; }
  }
  return bestScore >= 15 ? best : null;
}

function stepId(index) {
  return `step_${index + 1}`;
}

function makeStep(type, invoice, extra = {}) {
  const action = ACTION_TYPES[type];
  if (!action) throw new Error(`unknown agent action: ${type}`);
  const invoiceId = invoice?.id || invoice?.invoiceId || null;
  const customerName = invoice?.customer?.name || invoice?.customer?.full_name || invoice?.customer || invoiceId;
  return {
    type,
    invoiceId,
    summary: extra.summary || `${action.label}${invoiceId ? ` for ${customerName}` : ''}`,
    requiresApproval: action.approval,
    execution: action.method ? 'server' : 'client',
    payload: extra.payload || {}
  };
}

function summarizePortfolio(insights) {
  const summary = insights.summary;
  const parts = [];
  if (summary.overdueCount) parts.push(`${summary.overdueCount} invoice${summary.overdueCount === 1 ? ' is' : 's are'} overdue (${money(summary.overdueTotal)} at risk)`);
  if (summary.draftCount) parts.push(`${summary.draftCount} draft${summary.draftCount === 1 ? '' : 's'} waiting to be sent`);
  if (summary.dueWithin7Count) parts.push(`${summary.dueWithin7Count} due within 7 days`);
  if (!parts.length) parts.push('nothing is overdue and no draft is waiting');
  return `Right now ${parts.join(', ')}. Expected incoming cash is ${money(summary.projected7)} over 7 days, ${money(summary.projected14)} over 14 days, and ${money(summary.projected30)} over 30 days.`;
}

function collectionSteps(insights, limit = 5) {
  return insights.recommendations
    .filter((recommendation) => recommendation.nextAction.action === 'REMIND_INVOICE' || recommendation.nextAction.action === 'SEND_INVOICE')
    .slice(0, limit)
    .map((recommendation) => {
      const invoice = insights.invoices.find((item) => item.invoiceId === recommendation.invoiceId);
      const type = recommendation.nextAction.action === 'REMIND_INVOICE' ? 'remind_invoice' : 'send_invoice';
      const label = type === 'remind_invoice'
        ? `Send a reminder to ${recommendation.customer.name} for ${money(recommendation.amount, recommendation.currency)}${recommendation.daysOverdue ? ` (${recommendation.daysOverdue} days overdue)` : ''}`
        : `Send draft ${recommendation.invoiceId} to ${recommendation.customer.name} for ${money(recommendation.amount, recommendation.currency)}`;
      return makeStep(type, invoice ? { id: recommendation.invoiceId, customer: recommendation.customer } : null, { summary: label });
    });
}

function planFromIntent(message, store, insights) {
  const text = message.trim();
  const lower = text.toLowerCase();
  const invoices = insights.invoices;
  const summary = insights.summary;

  if (!text) throw new ValidationError('tell the copilot what you need');

  // Greeting / capability discovery.
  if (/^(hi|hey|hello|good (morning|afternoon|evening))\b/.test(lower) && text.length < 40) {
    return {
      intent: 'greeting',
      answer: `${summarizePortfolio(insights)} Ask me who to chase, what is coming in, or to draft an invoice. I will always show the proposed action before anything is sent.`,
      steps: []
    };
  }

  // Explicit invoice creation is delegated to the deterministic parser so the
  // user gets the familiar editable review modal.
  if (/(invoice|bill|charge)\b/.test(lower) && /\d/.test(text) && !/(send|remind|chase|follow)/.test(lower)) {
    try {
      const draft = parseInvoiceText(text);
      return {
        intent: 'draft_invoice',
        answer: `I drafted an invoice for ${draft.customer.name} for ${money(draft.total, draft.currency)} with ${draft.items.length} line item${draft.items.length === 1 ? '' : 's'}. Review every field before approving.`,
        steps: [{ ...makeStep('draft_invoice', null, { summary: `Review the draft invoice for ${draft.customer.name}` }), payload: { invoice: draft } }]
      };
    } catch {
      // Fall through to the portfolio answer rather than failing the request.
    }
  }

  // Explicit reminder batch (imperative commands only; questions such as
  // "who should I chase?" fall through to the ranked collections review).
  const imperativeReminder = /^(please\s+)?(send|draft|create|run|start|remind|chase|follow up|nudge)\b/.test(lower) &&
    /(remind|chase|follow up|nudge|collect)/.test(lower) &&
    !/^remind me\s+(who|what|which|why|how)\b/.test(lower);
  if (imperativeReminder) {
    const hint = text.replace(/^(please\s+)?(send|draft|create|run|start)?\s*(a\s+|the\s+|all\s+)?(gentle\s+)?(reminder|reminders|chase|follow up|nudge|collect)\s*(to|for|from)?\s*/i, '').trim();
    let targets;
    if (hint && hint.length > 1 && !/^(everyone|all|everything|overdue|them|these)$/i.test(hint)) {
      const matched = findInvoiceByHint(invoices.filter((invoice) => invoice.status === 'SENT'), hint);
      targets = matched ? [matched] : invoices.filter((invoice) => invoice.status === 'SENT' && invoice.daysUntilDue !== null && invoice.daysUntilDue < 0);
    } else if (/overdue|all|everyone/.test(lower)) {
      targets = invoices.filter((invoice) => invoice.status === 'SENT' && invoice.daysUntilDue !== null && invoice.daysUntilDue < 0);
    } else {
      targets = invoices.filter((invoice) => invoice.status === 'SENT');
    }
    const steps = targets.slice(0, MAX_STEPS).map((invoice) => makeStep('remind_invoice', invoice, {
      summary: `Send a reminder to ${invoice.customer.name} for ${money(invoice.total ?? invoice.amount, invoice.currency)}${invoice.daysUntilDue !== null && invoice.daysUntilDue < 0 ? ` (${Math.abs(invoice.daysUntilDue)} days overdue)` : ''}`
    }));
    return {
      intent: 'reminder_batch',
      answer: steps.length
        ? `I found ${steps.length} sent invoice${steps.length === 1 ? '' : 's'} matching that request. Approve the reminders you want and I will send them through PayPal.`
        : 'I could not find a sent invoice matching that request. Nothing will be sent.',
      steps
    };
  }

  // Forecast.
  if (/(forecast|cash ?flow|coming in|expect|projection|runway|revenue)/.test(lower)) {
    return {
      intent: 'forecast',
      answer: `Expected incoming cash from open invoices: ${money(summary.projected7)} in 7 days, ${money(summary.projected14)} in 14 days, and ${money(summary.projected30)} in 30 days. ${summary.overdueCount ? `${money(summary.overdueTotal)} is already past due and should be treated as at-risk, not guaranteed.` : 'No open invoice is past due.'}`,
      steps: []
    };
  }

  // Payment link.
  if (/(payment link|pay link|checkout|pay now|share.*link)/.test(lower)) {
    const sent = invoices.filter((invoice) => invoice.status === 'SENT');
    const matched = findInvoiceByHint(sent, text) || sent[0];
    return {
      intent: 'payment_link',
      answer: matched
        ? `I can create a PayPal Checkout link for ${matched.customer.name} (${money(matched.total, matched.currency)}). The customer pays on a hosted page; the invoice only moves to PAID after PayPal confirms the capture.`
        : 'There is no sent invoice that can accept a payment link yet.',
      steps: matched ? [makeStep('create_payment_link', matched, { summary: `Create a PayPal payment link for ${matched.customer.name}` })] : []
    };
  }

  // Cancel.
  if (/\bcancel\b/.test(lower)) {
    const matched = findInvoiceByHint(invoices.filter((invoice) => invoice.status === 'SENT' || invoice.status === 'DRAFT'), text);
    return {
      intent: 'cancel_invoice',
      answer: matched
        ? `I can cancel ${matched.customer.name}'s invoice (${money(matched.total, matched.currency)}). Cancelling is final for this invoice.`
        : 'Tell me which customer invoice to cancel. I will not cancel anything without an exact match.',
      steps: matched ? [makeStep('cancel_invoice', matched, { summary: `Cancel ${matched.invoiceId} for ${matched.customer.name}` })] : []
    };
  }

  // Explain a specific customer.
  if (/(explain|why|tell me about|what.*happening|status of)/.test(lower)) {
    const matched = findInvoiceByHint(invoices, text);
    if (matched) {
      const matchedId = matched.invoiceId || matched.id;
      const insight = insights.invoices.find((item) => item.invoiceId === matchedId);
      const step = insight?.nextAction.action === 'REMIND_INVOICE' ? [makeStep('remind_invoice', matched, { summary: `Send a reminder to ${matched.customer.name}` })] : [];
      return {
        intent: 'explain_invoice',
        answer: `${matched.customer.name}: ${insight?.explanation || 'No anomaly detected.'} Confidence ${Math.round((insight?.confidence || 0.9) * 100)}%.`,
        steps: step
      };
    }
  }

  // Collections review is the default for "who should I chase" style asks and
  // for anything the planner does not recognise: always answer with the ranked
  // next action rather than a generic failure.
  const wantsAttention = /(attention|chase|overdue|risk|priority|queue|today|what should|next|who)/.test(lower);
  const steps = collectionSteps(insights);
  return {
    intent: wantsAttention ? 'collections_review' : 'portfolio_review',
    answer: `${summarizePortfolio(insights)} The highest-impact move is ${insights.nextAction?.label?.toLowerCase() || 'to keep monitoring'}.`,
    steps
  };
}

function publicPlan(plan) {
  return {
    id: plan.id,
    intent: plan.intent,
    answer: plan.answer,
    steps: plan.steps,
    createdAt: plan.createdAt,
    expiresAt: plan.expiresAt,
    ai: plan.ai
  };
}

function deterministicMetadata(reason) {
  return { provider: 'deterministic', mode: 'deterministic', model: null, fallback: true, reason: reason || 'No AI provider configured; using the deterministic planner' };
}

function buildAgentContext(insights, now) {
  return {
    asOf: now,
    summary: insights.summary,
    invoices: insights.invoices.map((insight) => ({
      invoiceId: insight.invoiceId,
      customer: insight.customer?.name,
      status: insight.status,
      amount: insight.amount,
      currency: insight.currency,
      dueDate: insight.dueDate,
      daysUntilDue: insight.daysUntilDue,
      risk: insight.risk,
      reasonCodes: insight.reasonCodes,
      nextAction: insight.nextAction.action
    }))
  };
}

async function requestModelPlan({ message, context, resolved, fetchImpl, timeoutMs }) {
  const system = [
    'You are Cashflow Copilot, an accounts-receivable operator for a small business.',
    'You can only propose these actions: remind_invoice, send_invoice, cancel_invoice, create_payment_link, draft_invoice.',
    'Never invent invoice ids. Only use ids present in the context.',
    'Never claim an action has been executed. The merchant approves every step.',
    'Reply with JSON only: {"intent": string, "answer": string, "actions": [{"tool": string, "invoiceId": string|null, "text": string|null, "reason": string}]}',
    `Context: ${JSON.stringify(context)}`
  ].join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: { Authorization: `Bearer ${resolved.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolved.model,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: message }
        ]
      })
    });
    if (!response.ok) throw new Error(`planner request failed (${response.status})`);
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('planner returned no content');
    const withoutFence = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    return JSON.parse(withoutFence);
  } finally {
    clearTimeout(timer);
  }
}

function planFromModel(raw, store, insights, fallbackPlan) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('planner returned a non-object plan');
  const answer = typeof raw.answer === 'string' && raw.answer.trim() ? raw.answer.trim().slice(0, 1200) : fallbackPlan.answer;
  const intent = typeof raw.intent === 'string' ? raw.intent.slice(0, 60) : fallbackPlan.intent;
  const actions = Array.isArray(raw.actions) ? raw.actions.slice(0, MAX_STEPS) : [];
  const steps = [];
  for (const action of actions) {
    const tool = String(action?.tool || '');
    if (!ACTION_TYPES[tool]) continue;
    if (tool === 'draft_invoice') {
      const draftText = typeof action.text === 'string' ? action.text : '';
      if (!draftText) continue;
      try {
        const draft = parseInvoiceText(draftText);
        steps.push({ ...makeStep('draft_invoice', null, { summary: `Review the draft invoice for ${draft.customer.name}` }), payload: { invoice: draft } });
      } catch {
        // Ignore invalid draft proposals from the model.
      }
      continue;
    }
    const invoice = insights.invoices.find((item) => item.invoiceId === action.invoiceId);
    if (!invoice) continue;
    const stored = store.getInvoice(invoice.invoiceId);
    const allowedStatuses = tool === 'remind_invoice' ? ['SENT'] : tool === 'send_invoice' ? ['DRAFT'] : tool === 'cancel_invoice' ? ['DRAFT', 'SENT'] : ['SENT'];
    if (!allowedStatuses.includes(stored.status)) continue;
    steps.push(makeStep(tool, stored, { summary: `${ACTION_TYPES[tool].label} for ${stored.customer.name}${tool === 'remind_invoice' || tool === 'create_payment_link' ? ` (${money(stored.total, stored.currency)})` : ''}` }));
  }
  return { intent: intent || fallbackPlan.intent, answer, steps };
}

class CopilotAgent {
  constructor({ store, env = process.env, fetchImpl = globalThis.fetch, now = () => new Date().toISOString(), timeoutMs } = {}) {
    this.store = store;
    this.env = env;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.plans = new Map();
    this.timeoutMs = timeoutMs || Math.max(1000, Math.min(30000, Number(env.AI_TIMEOUT_MS) || 10000));
  }

  prune() {
    const now = Date.now();
    for (const [id, plan] of this.plans) {
      if (plan.expiresAt < now) this.plans.delete(id);
    }
    while (this.plans.size > MAX_PLANS) {
      const oldest = this.plans.keys().next().value;
      this.plans.delete(oldest);
    }
  }

  async plan(message, { provider, apiKey, baseUrl, model } = {}) {
    if (typeof message !== 'string' || !message.trim()) throw new ValidationError('message is required');
    if (message.length > 2000) throw new ValidationError('message must be 2000 characters or fewer');
    const now = this.now();
    const insights = todaysInsights(this.store);
    const deterministic = planFromIntent(message, this.store, insights);
    let plan = deterministic;
    let ai = deterministicMetadata();

    let resolved = null;
    try {
      resolved = await resolveAIProvider({ env: this.env, provider, apiKey, baseUrl, model, fetchImpl: this.fetchImpl });
    } catch {
      resolved = null;
    }
    if (resolved && resolved.mode === 'ai' && typeof this.fetchImpl === 'function') {
      try {
        const raw = await requestModelPlan({ message, context: buildAgentContext(insights, now), resolved, fetchImpl: this.fetchImpl, timeoutMs: this.timeoutMs });
        plan = planFromModel(raw, this.store, insights, deterministic);
        ai = { provider: resolved.provider, mode: 'ai', model: resolved.model, fallback: false, reason: null };
      } catch {
        plan = deterministic;
        ai = deterministicMetadata(`${resolved.provider} planner was unavailable; deterministic plan used`);
      }
    }

    this.prune();
    const createdAt = now;
    const storedPlan = {
      id: `plan_${crypto.randomUUID()}`,
      intent: plan.intent,
      answer: plan.answer,
      steps: plan.steps.map((step, index) => ({ ...step, id: stepId(index) })),
      createdAt,
      expiresAt: Date.now() + PLAN_TTL_MS,
      ai
    };
    this.plans.set(storedPlan.id, storedPlan);
    return publicPlan(storedPlan);
  }

  getPlan(planId) {
    const plan = this.plans.get(planId);
    if (!plan) throw new ValidationError('plan was not found or has expired');
    if (plan.expiresAt < Date.now()) { this.plans.delete(planId); throw new ValidationError('plan has expired; ask the copilot again'); }
    return plan;
  }

  async execute(planId, approvedStepIds, { baseUrl } = {}) {
    const plan = this.getPlan(planId);
    if (!Array.isArray(approvedStepIds) || approvedStepIds.length === 0) throw new ValidationError('approvedStepIds must contain at least one step id');
    const approved = new Set(approvedStepIds);
    const results = [];
    for (const step of plan.steps) {
      if (!approved.has(step.id)) continue;
      if (step.execution !== 'server') {
        results.push({ stepId: step.id, type: step.type, status: 'client_action', message: 'Open the review modal for this draft.' });
        continue;
      }
      try {
        if (step.type === 'remind_invoice') {
          const invoice = await this.store.remindInvoice(step.invoiceId, { actor: 'copilot' });
          results.push({ stepId: step.id, type: step.type, status: 'executed', invoice: summarizeInvoice(invoice) });
        } else if (step.type === 'send_invoice') {
          const invoice = await this.store.sendInvoice(step.invoiceId, { actor: 'copilot' });
          results.push({ stepId: step.id, type: step.type, status: 'executed', invoice: summarizeInvoice(invoice) });
        } else if (step.type === 'cancel_invoice') {
          const invoice = await this.store.cancelInvoice(step.invoiceId, { actor: 'copilot' });
          results.push({ stepId: step.id, type: step.type, status: 'executed', invoice: summarizeInvoice(invoice) });
        } else if (step.type === 'create_payment_link') {
          const { order, invoice } = await this.store.ensurePaymentOrder(step.invoiceId, { baseUrl });
          results.push({ stepId: step.id, type: step.type, status: 'executed', order: { id: order.id, approveUrl: order.approveUrl || null, mock: Boolean(order.mock) }, invoice: summarizeInvoice(invoice), payUrl: `/pay/${invoice.payToken}` });
        } else {
          results.push({ stepId: step.id, type: step.type, status: 'skipped', message: 'Unsupported step type.' });
        }
      } catch (error) {
        results.push({ stepId: step.id, type: step.type, status: 'failed', message: error.message || 'Action failed' });
      }
    }
    return { planId, results, executed: results.filter((result) => result.status === 'executed').length };
  }
}

function summarizeInvoice(invoice) {
  return { id: invoice.id, status: invoice.status, customer: invoice.customer?.name || null, total: invoice.total, currency: invoice.currency, reminderCount: invoice.reminderCount || 0 };
}

module.exports = { ACTION_TYPES, CopilotAgent, planFromIntent };
