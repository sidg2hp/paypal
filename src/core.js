'use strict';

const crypto = require('node:crypto');
const { appendEvent, verifyChain } = require('./audit');
const { buildPayerStats, forecastInvoice, projectCash } = require('./forecast');
const { applyPolicyToInsight, loadPolicy } = require('./policy');

const DEFAULT_CURRENCY = 'USD';
const MAX_BODY_TEXT = 8000;
const DEFAULT_OUTBOUND_TIMEOUT_MS = 10000;
const MAX_OUTBOUND_TIMEOUT_MS = 120000;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_OLLAMA_MODEL = 'llama3.2';
const DEFAULT_OLLAMA_PROBE_TIMEOUT_MS = 250;
const AI_PROVIDER_ALIASES = Object.freeze({
  auto: 'auto',
  deterministic: 'deterministic',
  ollama: 'ollama',
  openai: 'openai',
  grok: 'xai',
  xai: 'xai',
  'grok/xai': 'xai',
  gemini: 'gemini',
  google: 'gemini',
  'gemini/google': 'gemini'
});
const AI_PROVIDER_MODELS = Object.freeze({
  openai: 'gpt-4o-mini',
  xai: 'grok-3-mini',
  gemini: 'gemini-2.0-flash',
  ollama: DEFAULT_OLLAMA_MODEL
});
const AI_DETECTION_CACHE_TTL_MS = 5000;
const ollamaDetectionCache = new Map();
const INVOICE_TRANSITIONS = Object.freeze({
  DRAFT: Object.freeze(['SENT']),
  SENT: Object.freeze(['PAID', 'CANCELLED', 'VOID']),
  PAID: Object.freeze(['REFUNDED'])
});
const INVOICE_STATUSES = Object.freeze(['DRAFT', 'SENT', 'PAID', 'CANCELLED', 'VOID', 'REFUNDED']);
const CLOSED_STATUSES = Object.freeze(['PAID', 'CANCELLED', 'VOID', 'REFUNDED']);
const REMINDABLE_STATUSES = Object.freeze(['SENT']);

function normalizeTimeout(value, fallback = DEFAULT_OUTBOUND_TIMEOUT_MS) {
  const timeout = Number(value);
  return Number.isFinite(timeout) && timeout > 0 ? Math.max(1, Math.min(Math.floor(timeout), MAX_OUTBOUND_TIMEOUT_MS)) : fallback;
}

function timeoutError(label) {
  const error = new Error(`${label} timed out`);
  error.code = 'ETIMEDOUT';
  return error;
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = Promise.resolve().then(() => fetchImpl(url, { ...options, signal: controller.signal }));
  const timeout = new Promise((resolve, reject) => {
    const timeoutTimer = setTimeout(() => reject(timeoutError(label)), timeoutMs);
    request.then(() => clearTimeout(timeoutTimer), () => clearTimeout(timeoutTimer));
  });
  try {
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (controller.signal.aborted) throw timeoutError(label);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError(label)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

class ValidationError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ValidationError';
    this.code = 'VALIDATION_ERROR';
    this.statusCode = 400;
    if (details) this.details = details;
  }
}

class NotFoundError extends Error {
  constructor(message) {
    super(message);
    this.name = 'NotFoundError';
    this.code = 'NOT_FOUND';
    this.statusCode = 404;
  }
}

class PayPalError extends Error {
  constructor(message, statusCode = 502) {
    super(message);
    this.name = 'PayPalError';
    this.code = 'PAYPAL_ERROR';
    this.statusCode = statusCode >= 400 && statusCode < 600 ? 502 : 502;
  }
}

class AuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = 'UNAUTHORIZED';
    this.statusCode = 401;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function roundCents(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function parseAmount(value, field = 'amount') {
  let number = value;
  if (typeof value === 'string') {
    if (!/^\d+(?:\.\d{1,2})?$/.test(value.trim())) {
      throw new ValidationError(`${field} must be a non-negative amount with at most two decimals`);
    }
    number = Number(value);
  }
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0 || number > 1000000000) {
    throw new ValidationError(`${field} must be a non-negative finite amount`);
  }
  return roundCents(number);
}

function parsePositiveNumber(value, field) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000000) {
    throw new ValidationError(`${field} must be a positive finite number`);
  }
  return value;
}

function validateCurrency(value) {
  const currency = value === undefined ? DEFAULT_CURRENCY : value;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('currency must be a three-letter uppercase code');
  }
  return currency;
}

function validateDate(value, field = 'dueDate') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValidationError(`${field} must be an ISO date (YYYY-MM-DD)`);
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new ValidationError(`${field} must be a valid ISO date`);
  }
  return value;
}

function validateEmail(value) {
  if (typeof value !== 'string' || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new ValidationError('customer email must be a valid email address');
  }
  return value.toLowerCase();
}

function calculateTotals(items, taxRate = 0) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new ValidationError('at least one invoice item is required');
  }
  if (typeof taxRate !== 'number' || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 100) {
    throw new ValidationError('taxRate must be between 0 and 100');
  }
  const normalizedItems = items.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ValidationError(`items[${index}] must be an object`);
    }
    const description = item.description;
    if (typeof description !== 'string' || description.trim().length === 0 || description.length > 500) {
      throw new ValidationError(`items[${index}].description is required`);
    }
    const quantity = parsePositiveNumber(item.quantity, `items[${index}].quantity`);
    const unitPrice = parseAmount(item.unitPrice ?? item.unit_price, `items[${index}].unitPrice`);
    const amount = roundCents(quantity * unitPrice);
    return { description: description.trim(), quantity, unitPrice, amount };
  });
  const subtotal = roundCents(normalizedItems.reduce((sum, item) => sum + item.amount, 0));
  const tax = roundCents(subtotal * (taxRate / 100));
  return { items: normalizedItems, subtotal, taxRate, tax, total: roundCents(subtotal + tax) };
}

const SUPPORTED_CURRENCIES = Object.freeze(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'JPY', 'INR', 'SGD', 'NZD', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN', 'HKD', 'ZAR', 'PHP', 'THB', 'AED', 'ILS', 'CZK', 'HUF', 'TRY']);
const CURRENCY_SYMBOLS = Object.freeze({ '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW', '₽': 'RUB' });
const MONTHS = Object.freeze({ january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6, august: 7, september: 8, october: 9, november: 10, december: 11 });

function extractCurrency(text) {
  const explicit = text.match(/\b(?:currency\s*[:=]?\s*)?(USD|EUR|GBP|CAD|AUD|JPY|INR|SGD|NZD|CHF|SEK|NOK|DKK|PLN|BRL|MXN|HKD|ZAR|PHP|THB|AED|ILS|CZK|HUF|TRY)\b/i);
  if (explicit) return explicit[1].toUpperCase();
  for (const [symbol, currency] of Object.entries(CURRENCY_SYMBOLS)) {
    if (text.includes(symbol)) return currency;
  }
  return DEFAULT_CURRENCY;
}

function titleCaseSlug(value) {
  return value.replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()).trim();
}

function cleanCustomerName(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[<>]/g, ' ')
    .replace(/\b(?:email|e-mail)\b\s*$/i, ' ')
    .replace(/^[\s,;:-]+|[\s,;:-]+$/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Extract the customer from free text. The previous implementation skipped any
 * line beginning with "invoice", which broke the most common phrasing:
 * "Invoice Acme Design Co <accounts@acme.example> for ...".
 */
function extractCustomer(text) {
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = emailMatch ? emailMatch[0].toLowerCase() : null;
  let name = null;

  // 1. Explicit labels always win.
  const labelled = [
    /(?:customer|client|recipient|bill(?:ed)?\s*to)\s*(?:name)?\s*[:=-]\s*([^\n,;<]+)/i,
    /(?:^|\n)\s*(?:to|for)\s*[:=-]\s*([^\n,;<]+)/i
  ];
  for (const pattern of labelled) {
    const match = text.match(pattern);
    if (match && cleanCustomerName(match[1])) { name = cleanCustomerName(match[1]); break; }
  }

  // 2. Text before the email address, with the invoice header stripped.
  if (!name && email && emailMatch) {
    let prefix = text.slice(0, emailMatch.index);
    prefix = prefix.replace(/^[\s\S]*?(?:^|\n)\s*/m, '');
    prefix = prefix.replace(/^\s*(?:(?:please|kindly)\s+)?(?:(?:create|make|draft|prepare|send|new|raise)\s+)?(?:an?\s+)?(?:invoice|bill|request)\s*(?:for|to)?\s*/i, '');
    prefix = prefix.split(/\s+(?:for|covering|due|with|amount|totalling|totaling)\s+/i)[0];
    prefix = prefix.split(/[,;\n]/)[0];
    const cleaned = cleanCustomerName(prefix);
    if (cleaned && !/^(?:me|us|you|the customer)$/i.test(cleaned)) name = cleaned;
  }

  // 3. "Invoice for Name" / "Bill to Name" without an email.
  if (!name) {
    const patterns = [
      /(?:invoice|bill|request)\s+(?:for|to)\s+([^\n,;<(]+?)(?=\s*(?:\d|for\b|due\b|with\b|amount\b|,|;|$))/i,
      /(?:[Ii]nvoice|[Bb]ill|[Rr]equest)\s+([A-Z][^\n,;<(]{1,80}?)(?=\s*(?:\d|for\b|due\b|with\b|at\b|,|;|$))/,
      /\b(?:for|to)\s+([A-Z][^\n,;<(]{1,80}?)(?=\s*(?:\d|for\b|due\b|with\b|at\b|,|;|$))/
    ];
    // Let the case-sensitive name patterns run first so "Invoice Globex for"
    // captures "Globex" instead of the lowercase "for" variant below.
    const ordered = [patterns[1], patterns[2], patterns[0]];
    for (const pattern of ordered) {
      const match = text.match(pattern);
      if (match && cleanCustomerName(match[1])) { name = cleanCustomerName(match[1]); break; }
    }
  }

  // 4. Last resort: derive a readable name from the email local part.
  if (!name && email) name = titleCaseSlug(email.split('@')[0]);
  return { name: name || 'Customer', email };
}

function addUtcDays(baseDate, days) {
  const due = new Date(baseDate);
  if (Number.isNaN(due.getTime())) throw new ValidationError('base date must be valid');
  due.setUTCDate(due.getUTCDate() + days);
  return due.toISOString().slice(0, 10);
}

function parseDueDate(text, baseDate = new Date()) {
  const absolute = text.match(/(?:due|pay(?:able)?\s+by)\s*(?:date|on)?\s*[:=]?\s*(\d{4}-\d{2}-\d{2})/i);
  if (absolute) return validateDate(absolute[1]);
  const relative = text.match(/(?:due|pay(?:able)?)\s*(?:in|within)?\s*(\d{1,3})\s*(days?|weeks?)/i);
  if (relative) return addUtcDays(baseDate, Number(relative[1]) * (relative[2].toLowerCase().startsWith('week') ? 7 : 1));
  const net = text.match(/\bnet\s*(\d{1,3})\b/i);
  if (net) return addUtcDays(baseDate, Number(net[1]));
  const written = text.match(/(?:due|on)\s*(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})/i);
  if (written) {
    const month = MONTHS[written[2].toLowerCase()];
    const iso = `${written[3]}-${String(month + 1).padStart(2, '0')}-${String(written[1]).padStart(2, '0')}`;
    return validateDate(iso);
  }
  return null;
}

function parseTaxRate(text) {
  const percentFirst = text.match(/(\d+(?:\.\d+)?)\s*%\s*(?:sales\s+)?tax\b/i);
  if (percentFirst) return Number(percentFirst[1]);
  const taxFirst = text.match(/(?:sales\s+)?tax(?:\s+rate)?\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (taxFirst) return Number(taxFirst[1]);
  const bareTax = text.match(/(?:sales\s+)?tax(?:\s+rate)?\s*[:=]\s*(\d+(?:\.\d+)?)\s*$/im);
  if (bareTax) return Number(bareTax[1]);
  return 0;
}

// A comma only starts a new line item when it is followed by whitespace and a
// number; this keeps thousands separators such as "2,000" intact.
const ITEM_SEGMENT_SPLIT = /\s*;\s*|,\s+(?=\d)|(?:\s+and\s+)(?=\d)/i;
const ITEM_HEADER_PATTERN = /^(?:(?:please\s+)?(?:create|make|draft|prepare|send|new|raise)\s+)?(?:an?\s+)?(?:invoice|bill)\b/i;
const ITEM_METADATA_PATTERN = /^\s*(?:tax|currency|due|notes?|customer|client|recipient|reference|invoice\s*(?:number|#)?)\b\s*[:=-]/i;
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// Find "quantity description at price" anywhere in a clause, not only at the
// start. This is what prevents an invoice header or a customer email from
// being captured as the line-item description.
const ITEM_SEARCH_PATTERN = /(?:^|\s)(\d+(?:\.\d+)?)\s*(?:x|×|units?\s+of)?\s+(.+?)\s+(?:at|@|for|each\s+at)\s*[$€£¥₹]?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:each|per\s+[\w/-]+|\/\s*[\w/-]+)?/i;

function stripHeaderAndIdentity(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(EMAIL_PATTERN, ' ')
    .replace(/^\s*(?:please\s+)?(?:(?:create|make|draft|prepare|send|new|raise)\s+)?(?:an?\s+)?(?:invoice|bill)\s*(?:for|to)?\s*/i, '')
    .replace(/^[\s,;:-]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function isBadItemDescription(value) {
  const text = String(value || '').trim();
  if (!text) return true;
  if (EMAIL_PATTERN.test(text)) return true;
  if (/^(?:invoice|bill|create|make|draft|prepare|send|new|raise|customer|client|recipient|bill\s*to)\b/i.test(text)) return true;
  if (/^(?:tax|due|currency|notes?|reference|subtotal|total)\b\s*(?:[:=-]|\d|$)/i.test(text)) return true;
  return false;
}

// A description that still contains "1 brand review session at" is a fragment
// of an item whose quantity/price were captured by a broader pattern.
function looksLikeEmbeddedItem(value) {
  const text = String(value || '').trim();
  return /\b\d+(?:\.\d+)?\s+\S.*\b(?:at|for)\s*$/i.test(text)
    || /\bfor\s+(?:an?\s+)?[A-Za-z].*\bat\s*$/i.test(text);
}

function parseItemFromSearch(value) {
  const match = String(value || '').match(ITEM_SEARCH_PATTERN);
  if (!match) return null;
  const quantity = Number(match[1]);
  const description = cleanItemDescription(match[2]);
  const unitPrice = Number(match[3].replace(/,/g, ''));
  if (isBadItemDescription(description) || looksLikeEmbeddedItem(description)) return null;
  if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice)) return null;
  return { description, quantity, unitPrice };
}

// "for a brand review session at $125" has no explicit quantity. Treat it as
// one unit instead of letting the broad description+price pattern swallow the
// customer name and the word "for".
function parseItemFromForClause(value) {
  const match = String(value || '').match(/\b(?:for|of)\s+(?:an?\s+)?(.+?)\s+(?:at|@|for)\s*[$€£¥₹]?\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return null;
  const description = cleanItemDescription(match[1]);
  const unitPrice = Number(match[2].replace(/,/g, ''));
  if (isBadItemDescription(description) || looksLikeEmbeddedItem(description)) return null;
  if (!description || !Number.isFinite(unitPrice)) return null;
  return { description, quantity: 1, unitPrice };
}

function cleanItemDescription(value) {
  return String(value || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(EMAIL_PATTERN, ' ')
    .replace(/[,.]\s*$/, '')
    .replace(/\s+(?:each|apiece)$/i, '')
    .replace(/\s+per\s+(?:hour|unit|item|session|day)$/i, '')
    .replace(/^(?:hours?|hrs?|units?|items?|sessions?)\s+(?:of\s+)?/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function matchItemSegment(segment) {
  let candidate = segment
    .replace(/^\s*[-*•]\s*/, '')
    .replace(/^\s*(?:for|of|line\s*item\s*\d*\s*[:.-]?)\s+/i, '')
    .replace(/[\s,;]+$/, '')
    .trim();
  candidate = stripHeaderAndIdentity(candidate);
  if (!candidate || ITEM_METADATA_PATTERN.test(candidate)) return null;
  const searched = parseItemFromSearch(candidate);
  if (searched) return searched;
  const forClause = parseItemFromForClause(candidate);
  if (forClause) return forClause;
  const patterns = [
    /^(\d+(?:\.\d+)?)\s*(?:x|×|units?\s+of)?\s+(.+?)\s+(?:at|@|x|for|each\s+at)\s*[$€£¥₹]?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:each|per\s+[\w/-]+|\/\s*[\w/-]+)?\s*$/i,
    /^(.+?)\s*[-–—:]\s*(\d+(?:\.\d+)?)\s*(?:x|×)?\s*[$€£¥₹]?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i,
    /^(\d+(?:\.\d+)?)\s+(.+?)\s+[$€£¥₹]?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i,
    /^(.+?)\s+[$€£¥₹]?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i
  ];
  for (const [index, pattern] of patterns.entries()) {
    const match = candidate.match(pattern);
    if (!match) continue;
    const quantity = index === 0 || index === 2 ? Number(match[1]) : index === 1 ? Number(match[2]) : 1;
    const description = cleanItemDescription(index === 1 ? match[1] : index === 3 ? match[1] : match[2]);
    const unitPrice = Number((index === 0 ? match[3] : index === 1 ? match[3] : index === 2 ? match[3] : match[2]).replace(/,/g, ''));
    if (isBadItemDescription(description) || looksLikeEmbeddedItem(description)) continue;
    if (!description || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(unitPrice)) continue;
    return { description, quantity, unitPrice };
  }
  return null;
}

function parseItems(text) {
  const items = [];
  const lines = text.split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean);
  const keptLines = lines.filter((line) => !ITEM_METADATA_PATTERN.test(line) && !/^\s*(?:email|e-mail)\b\s*[:=]/i.test(line));
  const candidates = [];
  if (keptLines.length > 1) {
    candidates.push(...keptLines);
  } else {
    let line = keptLines[0] || text;
    const metadataCut = line.search(/\s+(?:tax|sales\s+tax|due|notes?|currency|reference)\b\s*[:=]?/i);
    if (metadataCut > 0) line = line.slice(0, metadataCut);
    const forMatch = line.match(/\b(?:for|of)\s+(?=\d)/i);
    if (forMatch) line = line.slice(forMatch.index);
    else if (ITEM_HEADER_PATTERN.test(line)) line = line.replace(ITEM_HEADER_PATTERN, '').replace(/<[^>]*>/g, ' ');
    candidates.push(...line.split(ITEM_SEGMENT_SPLIT));
  }
  for (const candidate of candidates) {
    const item = matchItemSegment(candidate);
    if (item) items.push(item);
  }
  if (items.length === 0) {
    // Last resort: search the whole prompt (minus header/email) for a
    // quantity-description-price clause. This also covers prompts that put the
    // customer and the item on one line without a "for" before the quantity.
    const searched = parseItemFromSearch(stripHeaderAndIdentity(text));
    if (searched) items.push(searched);
  }
  if (items.length === 0) {
    const fallback = text.match(/(?:for|of)\s+(?:an?\s+)?(.+?)\s+(?:at|for)\s*[$€£¥₹]?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (fallback) {
      const description = cleanItemDescription(fallback[1]);
      const unitPrice = Number(fallback[2].replace(/,/g, ''));
      if (description && !isBadItemDescription(description) && !looksLikeEmbeddedItem(description) && Number.isFinite(unitPrice)) {
        items.push({ description, quantity: 1, unitPrice });
      }
    }
  }
  return items;
}

function normalizeAIProvider(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return AI_PROVIDER_ALIASES[normalized] || null;
}

function configuredValue(env, ...names) {
  for (const name of names) {
    if (typeof env[name] === 'string' && env[name].trim()) return env[name].trim();
  }
  return '';
}

function providerModel(provider, env, overrides = {}) {
  if (overrides.model) return String(overrides.model).trim();
  if (provider === 'openai') return configuredValue(env, 'OPENAI_MODEL') || AI_PROVIDER_MODELS.openai;
  if (provider === 'xai') return configuredValue(env, 'GROK_MODEL', 'XAI_MODEL') || AI_PROVIDER_MODELS.xai;
  if (provider === 'gemini') return configuredValue(env, 'GEMINI_MODEL') || AI_PROVIDER_MODELS.gemini;
  if (provider === 'ollama') return configuredValue(env, 'OLLAMA_MODEL') || AI_PROVIDER_MODELS.ollama;
  return null;
}

function providerBaseUrl(provider, env, overrides = {}) {
  if (overrides.baseUrl) return String(overrides.baseUrl).trim().replace(/\/$/, '');
  if (provider === 'openai') return configuredValue(env, 'OPENAI_BASE_URL') || 'https://api.openai.com/v1';
  if (provider === 'xai') return configuredValue(env, 'XAI_BASE_URL') || 'https://api.x.ai/v1';
  if (provider === 'gemini') return configuredValue(env, 'GEMINI_BASE_URL') || 'https://generativelanguage.googleapis.com/v1beta/openai';
  if (provider === 'ollama') return configuredValue(env, 'OLLAMA_BASE_URL') || DEFAULT_OLLAMA_BASE_URL;
  return null;
}

function providerKey(provider, env, overrides = {}) {
  if (Object.prototype.hasOwnProperty.call(overrides, 'apiKey')) return overrides.apiKey || '';
  if (provider === 'openai') return configuredValue(env, 'OPENAI_API_KEY');
  if (provider === 'xai') return configuredValue(env, 'XAI_API_KEY', 'GROK_API_KEY');
  if (provider === 'gemini') return configuredValue(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY');
  if (provider === 'ollama') return 'ollama';
  return '';
}

function ollamaProbeUrl(env) {
  if (configuredValue(env, 'OLLAMA_PROBE_URL')) return configuredValue(env, 'OLLAMA_PROBE_URL');
  const baseUrl = configuredValue(env, 'OLLAMA_BASE_URL') || DEFAULT_OLLAMA_BASE_URL;
  return baseUrl.replace(/\/v1\/?$/, '') + '/api/tags';
}

function probeCacheKey(env) {
  return ollamaProbeUrl(env);
}

async function detectOllama({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const url = probeCacheKey(env);
  const cached = ollamaDetectionCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.reachable;
  if (typeof fetchImpl !== 'function') return false;
  const timeoutMs = Math.min(normalizeTimeout(env.OLLAMA_PROBE_TIMEOUT_MS, DEFAULT_OLLAMA_PROBE_TIMEOUT_MS), 2000);
  let reachable = false;
  try {
    const response = await fetchWithTimeout(fetchImpl, url, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs, 'Ollama detection');
    reachable = Boolean(response && response.ok !== false && (!response.status || response.status < 400));
  } catch {
    reachable = false;
  }
  ollamaDetectionCache.set(url, { reachable, expiresAt: Date.now() + AI_DETECTION_CACHE_TTL_MS });
  return reachable;
}

function deterministicProvider(reason, fallback = true) {
  return { provider: 'deterministic', mode: 'deterministic', model: null, fallback, reason };
}

function publicAIProviderMetadata(value) {
  return { provider: value.provider, mode: value.mode, model: value.model ?? null, fallback: Boolean(value.fallback), reason: value.reason || null };
}

async function resolveAIProvider({ env = process.env, fetchImpl = globalThis.fetch, provider, apiKey, baseUrl, model } = {}) {
  const overrides = {};
  if (apiKey !== undefined) overrides.apiKey = apiKey;
  if (baseUrl !== undefined) overrides.baseUrl = baseUrl;
  if (model !== undefined) overrides.model = model;
  const configuredProvider = provider === undefined ? configuredValue(env, 'AI_PROVIDER') || 'auto' : provider;
  const normalized = normalizeAIProvider(configuredProvider);
  if (!normalized) return { ...deterministicProvider('Unsupported AI_PROVIDER; using deterministic parser'), configuredProvider: String(configuredProvider), requestedProvider: String(configuredProvider) };
  if (normalized === 'deterministic') return { ...deterministicProvider('Explicit deterministic provider', false), configuredProvider: normalized, requestedProvider: normalized };

  let selected = normalized;
  let reason = null;
  if (normalized === 'auto') {
    if (apiKey !== undefined && apiKey) selected = 'openai';
    else if (configuredValue(env, 'OPENAI_API_KEY')) selected = 'openai';
    else if (configuredValue(env, 'XAI_API_KEY', 'GROK_API_KEY')) selected = 'xai';
    else if (configuredValue(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY')) selected = 'gemini';
    else if (await detectOllama({ env, fetchImpl })) selected = 'ollama';
    else return { ...deterministicProvider('No configured cloud provider and local Ollama was not reachable'), configuredProvider: 'auto', requestedProvider: 'auto' };
  }
  const key = providerKey(selected, env, overrides);
  if (!key) return { ...deterministicProvider(`${selected} API key is not configured`), configuredProvider: normalized, requestedProvider: normalized };
  return {
    provider: selected,
    mode: 'ai',
    model: providerModel(selected, env, overrides),
    baseUrl: providerBaseUrl(selected, env, overrides),
    apiKey: key,
    fallback: false,
    reason,
    configuredProvider: normalized,
    requestedProvider: normalized
  };
}

function getAIProviderStatus({ env = process.env } = {}) {
  const configuredProvider = configuredValue(env, 'AI_PROVIDER') || 'auto';
  const normalized = normalizeAIProvider(configuredProvider);
  if (!normalized) return { configuredProvider: configuredProvider.toLowerCase(), selectedProvider: 'deterministic', mode: 'deterministic', model: null, fallback: true, reason: 'Unsupported AI_PROVIDER; using deterministic parser', configured: {} };
  const configured = {
    openai: Boolean(configuredValue(env, 'OPENAI_API_KEY')),
    xai: Boolean(configuredValue(env, 'XAI_API_KEY', 'GROK_API_KEY')),
    gemini: Boolean(configuredValue(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY')),
    // Ollama has a documented local default, so selecting it explicitly is
    // enough to make it a configured provider even when no URL is supplied.
    ollama: normalizeAIProvider(configuredProvider) === 'ollama' || Boolean(configuredValue(env, 'OLLAMA_BASE_URL'))
  };
  if (normalized === 'deterministic') return { configuredProvider: normalized, selectedProvider: normalized, mode: 'deterministic', model: null, fallback: false, reason: 'Explicit deterministic provider', configured };
  if (normalized !== 'auto') {
    const keyConfigured = normalized === 'ollama' || configured[normalized];
    return { configuredProvider: normalized, selectedProvider: keyConfigured ? normalized : 'deterministic', mode: keyConfigured ? 'ai' : 'deterministic', model: keyConfigured ? providerModel(normalized, env) : null, fallback: !keyConfigured, reason: keyConfigured ? null : `${normalized} API key is not configured`, configured };
  }
  const selected = configured.openai ? 'openai' : configured.xai ? 'xai' : configured.gemini ? 'gemini' : null;
  if (selected) return { configuredProvider: normalized, selectedProvider: selected, mode: 'ai', model: providerModel(selected, env), fallback: false, reason: null, configured };
  const cached = ollamaDetectionCache.get(probeCacheKey(env));
  if (cached?.expiresAt > Date.now() && cached.reachable) return { configuredProvider: normalized, selectedProvider: 'ollama', mode: 'ai', model: providerModel('ollama', env), fallback: false, reason: 'Local Ollama detected', configured };
  return { configuredProvider: normalized, selectedProvider: 'deterministic', mode: 'deterministic', model: null, fallback: true, reason: 'No configured cloud provider; Ollama detection has not confirmed a local server', configured };
}

function parseInvoiceText(input, { now = new Date() } = {}) {
  // Synchronous deterministic path. The HTTP app uses
  // parseInvoiceTextWithMetadataAsync so an optional AI extractor can be used
  // without changing this offline fallback.
  if (typeof input !== 'string' || input.trim().length < 3 || input.length > MAX_BODY_TEXT) {
    throw new ValidationError(`text must be between 3 and ${MAX_BODY_TEXT} characters`);
  }
  const text = input.trim();
  const customer = extractCustomer(text);
  const items = parseItems(text);
  if (items.length === 0) throw new ValidationError('could not find an invoice item; include quantity, description, and price');
  const totals = calculateTotals(items, parseTaxRate(text));
  const notesMatch = text.match(/notes?\s*[:=-]\s*(.+)$/im);
  return {
    customer: { name: customer.name, ...(customer.email ? { email: customer.email } : {}) },
    currency: extractCurrency(text),
    dueDate: parseDueDate(text, now),
    ...(notesMatch ? { notes: notesMatch[1].trim() } : {}),
    ...totals
  };
}

function normalizeAiExtraction(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('AI extraction must be an object');
  const customer = value.customer && typeof value.customer === 'object' ? value.customer : {};
  const name = typeof customer.name === 'string' && customer.name.trim() ? customer.name.trim() : 'Customer';
  const email = customer.email === undefined || customer.email === null || customer.email === '' ? undefined : validateEmail(customer.email);
  const currency = validateCurrency(value.currency);
  const dueDate = validateDate(value.dueDate ?? value.due_date);
  const totals = calculateTotals(value.items, value.taxRate ?? value.tax_rate ?? 0);
  if (value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 2000)) throw new ValidationError('notes must be a string up to 2000 characters');
  return {
    customer: { name, ...(email ? { email } : {}) },
    currency,
    dueDate,
    ...(value.notes ? { notes: value.notes.trim() } : {}),
    ...totals
  };
}

function parseAiJson(content) {
  if (typeof content !== 'string') throw new Error('AI response did not contain text');
  const withoutFence = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(withoutFence);
}

async function parseInvoiceTextWithMetadataAsync(input, {
  env = process.env,
  provider,
  apiKey,
  fetchImpl = globalThis.fetch,
  baseUrl,
  model,
  timeoutMs = normalizeTimeout(env.AI_TIMEOUT_MS || env.OUTBOUND_TIMEOUT_MS),
  now = new Date()
} = {}) {
  const resolved = await resolveAIProvider({ env, provider, apiKey, baseUrl, model, fetchImpl });
  if (resolved.mode !== 'ai' || typeof fetchImpl !== 'function') {
    return { invoice: parseInvoiceText(input, { now }), ai: publicAIProviderMetadata(resolved.mode === 'ai' ? deterministicProvider('AI fetch is unavailable') : resolved) };
  }
  try {
    if (typeof input !== 'string' || input.trim().length < 3 || input.length > MAX_BODY_TEXT) throw new ValidationError(`text must be between 3 and ${MAX_BODY_TEXT} characters`);
    const response = await fetchWithTimeout(fetchImpl, `${resolved.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${resolved.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: resolved.model,
        temperature: 0,
        messages: [
          { role: 'system', content: 'Extract an invoice into JSON only. Return customer {name,email}, currency, dueDate (YYYY-MM-DD or null), items [{description,quantity,unitPrice}], taxRate, and optional notes. Do not invent missing values.' },
          { role: 'user', content: input.trim() }
        ]
      })
    }, normalizeTimeout(timeoutMs), 'AI extraction request');
    const body = await safeJson(response, normalizeTimeout(timeoutMs), 'AI extraction response');
    if (!response.ok) throw new Error(`AI extraction failed (${response.status})`);
    const content = body?.choices?.[0]?.message?.content;
    return { invoice: normalizeAiExtraction(parseAiJson(content), now), ai: publicAIProviderMetadata(resolved) };
  } catch (error) {
    // AI is an enhancement, never a dependency. Deliberately do not log the
    // error because provider responses can contain prompts or sensitive data.
    if (error instanceof ValidationError && /^text must be/.test(error.message)) throw error;
    const reason = error?.code === 'ETIMEDOUT' ? `${resolved.provider} request timed out` : `${resolved.provider} response was unavailable or invalid`;
    return { invoice: parseInvoiceText(input, { now }), ai: publicAIProviderMetadata(deterministicProvider(reason)) };
  }
}

async function parseInvoiceTextAsync(input, options = {}) {
  const result = await parseInvoiceTextWithMetadataAsync(input, options);
  return result.invoice;
}

function normalizeInvoiceInput(input, id, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('invoice body must be an object');
  // Parsed invoice responses include calculated fields so they can be submitted
  // directly to this endpoint. Recalculate them below instead of trusting them.
  const allowed = new Set(['customer', 'customerName', 'customerEmail', 'currency', 'dueDate', 'due_date', 'items', 'taxRate', 'tax_rate', 'notes', 'reference', 'subtotal', 'tax', 'total']);
  const unknown = Object.keys(input).filter((key) => !allowed.has(key));
  if (unknown.length) throw new ValidationError(`unknown invoice field: ${unknown[0]}`);
  const customerInput = input.customer || {};
  if (typeof customerInput !== 'object' || Array.isArray(customerInput)) throw new ValidationError('customer must be an object');
  const name = input.customerName ?? customerInput.name;
  if (typeof name !== 'string' || name.trim().length < 1 || name.length > 200) throw new ValidationError('customer name is required');
  const email = validateEmail(input.customerEmail ?? customerInput.email);
  const currency = validateCurrency(input.currency);
  const dueDate = validateDate(input.dueDate ?? input.due_date);
  const taxRate = input.taxRate ?? input.tax_rate ?? 0;
  const totals = calculateTotals(input.items, taxRate);
  if (input.notes !== undefined && (typeof input.notes !== 'string' || input.notes.length > 2000)) throw new ValidationError('notes must be a string up to 2000 characters');
  if (input.reference !== undefined && (typeof input.reference !== 'string' || input.reference.length > 120)) throw new ValidationError('reference must be a string up to 120 characters');
  return {
    id,
    customer: { name: name.trim(), email },
    currency,
    dueDate,
    items: totals.items,
    subtotal: totals.subtotal,
    taxRate: totals.taxRate,
    tax: totals.tax,
    total: totals.total,
    notes: input.notes?.trim() || null,
    reference: input.reference?.trim() || null,
    status: 'DRAFT',
    paypalInvoiceId: null,
    reminderCount: 0,
    createdAt: now,
    updatedAt: now,
    events: []
  };
}

function newPayToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function seedInvoice(data) {
  const totals = calculateTotals(data.items, data.taxRate || 0);
  const events = [];
  for (const event of data.events || []) appendEvent(events, event);
  return {
    id: data.id,
    customer: data.customer,
    currency: data.currency || DEFAULT_CURRENCY,
    dueDate: data.dueDate || null,
    items: totals.items,
    subtotal: totals.subtotal,
    taxRate: totals.taxRate,
    tax: totals.tax,
    total: totals.total,
    notes: data.notes || null,
    reference: data.reference || null,
    status: data.status || 'DRAFT',
    paypalInvoiceId: data.paypalInvoiceId || null,
    payToken: data.payToken || newPayToken(),
    paypalOrderId: data.paypalOrderId || null,
    orderStatus: data.orderStatus || null,
    reminderCount: data.reminderCount || 0,
    lastRemindedAt: data.lastRemindedAt || null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    events
  };
}

function isoDay(base, offsetDays) {
  const date = new Date(base);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function isoMoment(base, offsetDays, hour = 9) {
  const date = new Date(base);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

/**
 * Seed data is relative to "now" so a demo recorded weeks from now still shows
 * one overdue invoice, one invoice due soon, one paid invoice, and one draft.
 */
function buildSeedInvoices({ now = new Date().toISOString() } = {}) {
  const base = new Date(now);
  if (Number.isNaN(base.getTime())) throw new ValidationError('seed base date must be valid');
  const sentAtOne = isoMoment(base, -18);
  const sentAtTwo = isoMoment(base, -24);
  const paidAt = isoMoment(base, -3, 14);
  return [
    seedInvoice({
      id: 'inv_seed_001',
      customer: { name: 'Northwind Studio', email: 'billing@northwind.example' },
      currency: 'USD',
      dueDate: isoDay(base, 9),
      items: [{ description: 'Cashflow setup', quantity: 1, unitPrice: 450 }],
      taxRate: 8.25,
      status: 'SENT',
      paypalInvoiceId: 'MOCK-INV-SEED-001',
      createdAt: sentAtOne,
      updatedAt: sentAtOne,
      events: [{ type: 'INVOICING.INVOICE.SENT', at: sentAtOne, source: 'seed' }]
    }),
    seedInvoice({
      id: 'inv_seed_002',
      customer: { name: 'Acme Design Co', email: 'accounts@acme.example' },
      currency: 'USD',
      dueDate: isoDay(base, -8),
      items: [{ description: 'Brand review', quantity: 2, unitPrice: 125 }],
      taxRate: 0,
      status: 'SENT',
      paypalInvoiceId: 'MOCK-INV-SEED-002',
      createdAt: sentAtTwo,
      updatedAt: sentAtTwo,
      events: [{ type: 'INVOICING.INVOICE.SENT', at: sentAtTwo, source: 'seed' }]
    }),
    seedInvoice({
      id: 'inv_seed_003',
      customer: { name: 'Harbor & Pine', email: 'finance@harborandpine.example' },
      currency: 'USD',
      dueDate: isoDay(base, -2),
      items: [{ description: 'Q3 brand system', quantity: 1, unitPrice: 1200 }],
      taxRate: 0,
      status: 'PAID',
      paypalInvoiceId: 'MOCK-INV-SEED-003',
      createdAt: isoMoment(base, -31),
      updatedAt: paidAt,
      events: [
        { type: 'INVOICING.INVOICE.SENT', at: isoMoment(base, -31), source: 'seed' },
        { type: 'INVOICING.INVOICE.PAID', at: paidAt, source: 'seed', verified: false, eventId: 'SEED-PAID-003' }
      ]
    }),
    seedInvoice({
      id: 'inv_seed_004',
      customer: { name: 'Meridian Labs', email: 'ops@meridianlabs.example' },
      currency: 'USD',
      dueDate: isoDay(base, 21),
      items: [
        { description: 'Discovery workshop', quantity: 1, unitPrice: 900 },
        { description: 'Prototype sprint', quantity: 2, unitPrice: 650 }
      ],
      taxRate: 5,
      status: 'DRAFT',
      createdAt: isoMoment(base, -1, 16),
      updatedAt: isoMoment(base, -1, 16),
      events: []
    })
  ];
}

const SEEDED_INVOICES = buildSeedInvoices();

function allocateTax(items, tax) {
  const cents = Math.round(tax * 100);
  if (!items.length || cents === 0) return items.map(() => 0);
  const subtotalCents = items.reduce((sum, item) => sum + Math.round(item.amount * 100), 0);
  if (subtotalCents === 0) return items.map(() => 0);
  let allocated = 0;
  return items.map((item, index) => {
    if (index === items.length - 1) return (cents - allocated) / 100;
    const share = Math.round((Math.round(item.amount * 100) / subtotalCents) * cents);
    allocated += share;
    return share / 100;
  });
}

/**
 * Build the Invoicing v2 payload. Tax is allocated per item so the PayPal
 * invoice total always equals the locally displayed total (the previous
 * implementation omitted tax entirely, which silently under-billed).
 */
function buildPayPalInvoicePayload(invoice, { brandName = 'Cashflow Copilot', invoicerEmail = null } = {}) {
  const taxShares = allocateTax(invoice.items, invoice.tax);
  const items = invoice.items.map((item, index) => {
    const taxAmount = taxShares[index];
    return {
      name: item.description.slice(0, 127),
      description: item.description.slice(0, 1000),
      quantity: String(item.quantity),
      unit_amount: { currency_code: invoice.currency, value: item.unitPrice.toFixed(2) },
      ...(taxAmount > 0
        ? { tax: { name: 'Tax', percent: String(invoice.taxRate), amount: { currency_code: invoice.currency, value: taxAmount.toFixed(2) } } }
        : {}),
      unit_of_measure: 'QUANTITY'
    };
  });
  return {
    detail: {
      invoice_number: invoice.id.slice(0, 25),
      reference: (invoice.reference || invoice.id).slice(0, 120),
      currency_code: invoice.currency,
      note: invoice.notes ? invoice.notes.slice(0, 4000) : undefined,
      memo: invoice.notes ? invoice.notes.slice(0, 1000) : undefined,
      payment_term: invoice.dueDate ? { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: invoice.dueDate } : undefined
    },
    invoicer: {
      name: { given_name: 'Cashflow', surname: 'Copilot' },
      ...(invoicerEmail ? { email_address: invoicerEmail } : {})
    },
    primary_recipients: [{ billing_info: { name: { full_name: invoice.customer.name }, email_address: invoice.customer.email } }],
    items
  };
}

function buildPayPalOrderPayload(invoice, { returnUrl, cancelUrl, brandName = 'Cashflow Copilot' } = {}) {
  return {
    intent: 'CAPTURE',
    purchase_units: [{
      reference_id: invoice.id.slice(0, 256),
      custom_id: invoice.id.slice(0, 127),
      description: `Invoice ${invoice.id} for ${invoice.customer.name}`.slice(0, 127),
      amount: { currency_code: invoice.currency, value: invoice.total.toFixed(2) }
    }],
    application_context: {
      brand_name: brandName.slice(0, 127),
      user_action: 'PAY_NOW',
      shipping_preference: 'NO_SHIPPING',
      ...(returnUrl ? { return_url: returnUrl.slice(0, 4000) } : {}),
      ...(cancelUrl ? { cancel_url: cancelUrl.slice(0, 4000) } : {})
    }
  };
}

class MockPayPalAdapter {
  constructor() {
    this.name = 'mock';
    this.sequence = 1;
    this.orderSequence = 1;
    this.captureSequence = 1;
    this.reminders = [];
    this.orders = new Map();
    this.captures = [];
  }

  async createInvoice(invoice) {
    const id = `MOCK-INV-${String(this.sequence++).padStart(4, '0')}`;
    return { id, status: 'DRAFT', href: `/mock/paypal/invoices/${id}` };
  }

  async sendInvoice(paypalInvoiceId) {
    return { id: paypalInvoiceId, status: 'SENT' };
  }

  async remindInvoice(paypalInvoiceId) {
    this.reminders.push(paypalInvoiceId);
    return { id: paypalInvoiceId, status: 'SENT', reminded: true };
  }

  async cancelInvoice(paypalInvoiceId) {
    return { id: paypalInvoiceId, status: 'CANCELLED' };
  }

  async createOrder(invoice, { returnUrl, cancelUrl } = {}) {
    const id = `MOCK-ORDER-${String(this.orderSequence++).padStart(4, '0')}`;
    this.orders.set(id, { id, invoiceId: invoice.id, status: 'CREATED', amount: invoice.total, currency: invoice.currency, returnUrl, cancelUrl });
    return { id, status: 'CREATED', approveUrl: null, mock: true };
  }

  async captureOrder(orderId) {
    const order = this.orders.get(orderId);
    if (!order) throw new PayPalError('mock order was not found');
    if (order.status === 'COMPLETED') return { id: orderId, status: 'COMPLETED', captureId: order.captureId, amount: order.amount, currency: order.currency, mock: true, duplicate: true };
    const captureId = `MOCK-CAPTURE-${String(this.captureSequence++).padStart(4, '0')}`;
    order.status = 'COMPLETED';
    order.captureId = captureId;
    this.captures.push(captureId);
    return { id: orderId, status: 'COMPLETED', captureId, amount: order.amount, currency: order.currency, mock: true, duplicate: false };
  }
}

class PayPalSandboxAdapter {
  constructor({ clientId, clientSecret, fetchImpl = globalThis.fetch, baseUrl = process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com', brandName = process.env.PAYPAL_BRAND_NAME || 'Cashflow Copilot', invoicerEmail = process.env.PAYPAL_INVOICER_EMAIL || null, timeoutMs = normalizeTimeout(process.env.PAYPAL_TIMEOUT_MS || process.env.OUTBOUND_TIMEOUT_MS) } = {}) {
    const normalizedId = String(clientId || '').trim();
    const normalizedSecret = String(clientSecret || '').trim();
    if (!normalizedId || !normalizedSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required together');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is required for the PayPal sandbox adapter');
    this.name = 'paypal-sandbox';
    this.clientId = normalizedId;
    this.clientSecret = normalizedSecret;
    this.fetch = fetchImpl;
    this.baseUrl = String(baseUrl || '').trim().replace(/\/+$/, '');
    this.brandName = brandName;
    this.invoicerEmail = invoicerEmail;
    this.timeoutMs = normalizeTimeout(timeoutMs);
    this.token = null;
  }

  environmentName() {
    let host = '';
    try { host = new URL(this.baseUrl).hostname.toLowerCase(); } catch { return 'custom'; }
    if (host.includes('sandbox')) return 'sandbox';
    if (host === 'api-m.paypal.com' || host === 'api.paypal.com') return 'live';
    return 'custom';
  }

  async accessToken() {
    if (this.token && this.token.expiresAt > Date.now() + 30000) return this.token.value;
    try {
      const response = await fetchWithTimeout(this.fetch, `${this.baseUrl}/v1/oauth2/token`, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
          Accept: 'application/json',
          'Accept-Language': 'en_US',
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
      }, this.timeoutMs, 'PayPal authentication request');
      this.lastDebugId = response.headers?.get?.('paypal-debug-id') || this.lastDebugId || null;
      const body = await safeJson(response, this.timeoutMs, 'PayPal authentication response');
      if (!response.ok || !body?.access_token) {
        const status = Number(response.status) || 0;
        const paypalError = body?.error || body?.name || null;
        const description = body?.error_description || body?.message || null;
        const suffix = [status || null, paypalError, description].filter(Boolean).join(' ');
        const error = new PayPalError(`PayPal authentication failed${suffix ? ` (${suffix})` : ''}`);
        error.details = {
          status,
          paypalError,
          paypalErrorDescription: description,
          debugId: this.lastDebugId,
          environment: this.environmentName(),
          baseUrl: this.baseUrl
        };
        throw error;
      }
      this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 300) * 1000 };
      return this.token.value;
    } catch (error) {
      if (error.code === 'ETIMEDOUT') throw new PayPalError('PayPal authentication request timed out');
      if (error instanceof PayPalError) throw error;
      throw new PayPalError('PayPal authentication request failed');
    }
  }

  async request(path, options = {}) {
    try {
      const token = await this.accessToken();
      const response = await fetchWithTimeout(this.fetch, `${this.baseUrl}${path}`, {
        ...options,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
      }, this.timeoutMs, 'PayPal API request');
      this.lastDebugId = response.headers?.get?.('paypal-debug-id') || this.lastDebugId || null;
      const body = await safeJson(response, this.timeoutMs, 'PayPal API response');
      if (!response.ok) {
        const status = Number(response.status) || 0;
        const paypalError = body?.name || body?.error || null;
        const description = body?.message || body?.error_description || null;
        const error = new PayPalError(`PayPal request failed (${status}${paypalError ? ` ${paypalError}` : ''}${description ? `: ${description}` : ''})`);
        error.details = { status, paypalError, paypalErrorDescription: description, debugId: this.lastDebugId, environment: this.environmentName(), baseUrl: this.baseUrl };
        throw error;
      }
      return body;
    } catch (error) {
      if (error.code === 'ETIMEDOUT') throw new PayPalError('PayPal API request timed out');
      if (error instanceof PayPalError) throw error;
      throw new PayPalError('PayPal API request failed');
    }
  }

  async createInvoice(invoice) {
    return this.request('/v2/invoicing/invoices', {
      method: 'POST',
      body: JSON.stringify(buildPayPalInvoicePayload(invoice, { invoicerEmail: this.invoicerEmail }))
    });
  }

  async sendInvoice(paypalInvoiceId) {
    await this.request(`/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}/send`, {
      method: 'POST',
      body: JSON.stringify({ send_to_recipient: true, email_notification: true })
    });
    return { id: paypalInvoiceId, status: 'SENT' };
  }

  async remindInvoice(paypalInvoiceId) {
    await this.request(`/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}/remind`, { method: 'POST', body: JSON.stringify({}) });
    return { id: paypalInvoiceId, status: 'SENT', reminded: true };
  }

  async cancelInvoice(paypalInvoiceId) {
    await this.request(`/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}/cancel`, {
      method: 'POST',
      body: JSON.stringify({ subject: 'Invoice cancelled', note: 'Cancelled by the merchant from Cashflow Copilot.', send_to_invoice_payer: false })
    });
    return { id: paypalInvoiceId, status: 'CANCELLED' };
  }

  async getInvoice(paypalInvoiceId) {
    return this.request(`/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}`, { method: 'GET' });
  }

  async createOrder(invoice, { returnUrl, cancelUrl } = {}) {
    const body = await this.request('/v2/checkout/orders', {
      method: 'POST',
      body: JSON.stringify(buildPayPalOrderPayload(invoice, { returnUrl, cancelUrl, brandName: this.brandName }))
    });
    const approveLink = Array.isArray(body?.links) ? body.links.find((link) => link.rel === 'approve' || link.rel === 'payer-action') : null;
    return { id: body?.id, status: body?.status || 'CREATED', approveUrl: approveLink?.href || null, mock: false };
  }

  async captureOrder(orderId) {
    const body = await this.request(`/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      method: 'POST',
      headers: { 'PayPal-Request-Id': `capture-${orderId}` },
      body: JSON.stringify({})
    });
    const capture = body?.purchase_units?.[0]?.payments?.captures?.[0];
    const amount = capture?.amount?.value ? Number(capture.amount.value) : null;
    return {
      id: body?.id || orderId,
      status: body?.status || 'COMPLETED',
      captureId: capture?.id || null,
      amount,
      currency: capture?.amount?.currency_code || null,
      mock: false,
      duplicate: false
    };
  }

  async verifyWebhookSignature({ transmissionId, transmissionTime, certUrl, authAlgo, transmissionSig, webhookId, webhookEvent }) {
    // The cert URL is supplied by the caller and forwarded to PayPal. Restrict
    // it to PayPal hosts so a forged header cannot turn the verifier into an
    // outbound request to an arbitrary origin.
    let certHost = '';
    try {
      const parsed = new URL(certUrl);
      certHost = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:') return false;
    } catch {
      return false;
    }
    const allowed = /(^|\.)(paypal\.com|paypalobjects\.com|paypal\.cn)$/i.test(certHost);
    if (!allowed) return false;
    const body = await this.request('/v1/notifications/verify-webhook-signature', {
      method: 'POST',
      body: JSON.stringify({
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: webhookEvent
      })
    });
    return body?.verification_status === 'SUCCESS';
  }
}

async function safeJson(response, timeoutMs, label = 'response') {
  try {
    const body = response.json();
    return timeoutMs ? await withTimeout(body, timeoutMs, label) : await body;
  } catch (error) {
    if (error.code === 'ETIMEDOUT') throw error;
    return null;
  }
}

function dateOnly(value) {
  return String(value).slice(0, 10);
}

function daysUntil(date, asOf) {
  return Math.floor((Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${dateOnly(asOf)}T00:00:00.000Z`)) / 86400000);
}

function buildInvoiceInsight(invoice, asOf) {
  const closed = CLOSED_STATUSES.includes(invoice.status);
  const days = invoice.dueDate ? daysUntil(invoice.dueDate, asOf) : null;
  let risk = 'LOW';
  let urgency = 'LOW';
  let priority = 0;
  let action = 'NO_ACTION';
  let explanation = 'No action is needed.';
  const reasonCodes = [`STATUS_${invoice.status}`];

  if (invoice.status === 'DRAFT') {
    risk = 'MEDIUM';
    urgency = 'HIGH';
    priority = 90;
    action = 'SEND_INVOICE';
    explanation = `This draft for ${invoice.customer.name} has not been sent, so the payment clock has not started.`;
    reasonCodes.push('DRAFT_NOT_SENT');
  } else if (invoice.status === 'SENT') {
    action = 'MONITOR_PAYMENT';
    priority = 20;
    explanation = `Payment is still pending for ${invoice.customer.name}.`;
    if (days === null) {
      risk = 'MEDIUM';
      urgency = 'MEDIUM';
      priority = 55;
      action = 'ADD_DUE_DATE';
      explanation = 'This invoice has no due date, which weakens the forecast and the reminder policy.';
      reasonCodes.push('NO_DUE_DATE');
    } else if (days < 0) {
      const overdueDays = Math.abs(days);
      risk = days <= -7 ? 'CRITICAL' : 'HIGH';
      urgency = days <= -7 ? 'CRITICAL' : 'HIGH';
      priority = days <= -7 ? 100 : 95;
      action = 'REMIND_INVOICE';
      explanation = `${invoice.customer.name} is ${overdueDays} day${overdueDays === 1 ? '' : 's'} past due on ${invoice.currency} ${invoice.total.toFixed(2)}. A reminder is the highest-leverage next action.`;
      reasonCodes.push('OVERDUE');
      if (days <= -7) reasonCodes.push('OVERDUE_7_PLUS_DAYS');
    } else if (days <= 3) {
      risk = 'HIGH';
      urgency = 'HIGH';
      priority = 85;
      action = 'REMIND_INVOICE';
      explanation = `Due in ${days} day${days === 1 ? '' : 's'}. A short reminder now protects the due date.`;
      reasonCodes.push('DUE_WITHIN_3_DAYS');
    } else if (days <= 7) {
      risk = 'MEDIUM';
      urgency = 'MEDIUM';
      priority = 65;
      action = 'REMIND_INVOICE';
      explanation = `Due in ${days} days. A heads-up keeps the payment on track.`;
      reasonCodes.push('DUE_WITHIN_7_DAYS');
    } else {
      explanation = `Due in ${days} days and not yet at risk. Keep monitoring.`;
      reasonCodes.push('PAYMENT_PENDING');
    }
  } else if (closed) {
    reasonCodes.push(invoice.status === 'PAID' ? 'PAID_IN_FULL' : invoice.status === 'REFUNDED' ? 'REFUNDED' : 'CLOSED');
    explanation = invoice.status === 'PAID' ? 'Paid in full. Nothing to collect.' : invoice.status === 'REFUNDED' ? 'This invoice was refunded.' : 'This invoice is closed.';
  } else {
    risk = 'MEDIUM';
    urgency = 'MEDIUM';
    priority = 40;
    action = 'REVIEW_STATUS';
    explanation = 'This invoice has an unexpected status and should be reviewed.';
    reasonCodes.push('UNMAPPED_STATUS');
  }

  const riskScore = risk === 'CRITICAL' ? 100 : risk === 'HIGH' ? 80 : risk === 'MEDIUM' ? 50 : 10;
  return {
    invoiceId: invoice.id,
    customer: invoice.customer,
    status: invoice.status,
    amount: invoice.total,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    daysUntilDue: days,
    daysOverdue: days !== null && days < 0 ? Math.abs(days) : 0,
    risk,
    riskScore,
    urgency,
    confidence: days === null && invoice.status === 'SENT' ? 0.84 : 0.99,
    reasonCodes,
    explanation,
    nextAction: {
      type: action,
      action,
      priority,
      invoiceId: invoice.id,
      reasonCodes: [...reasonCodes],
      requiresApproval: action === 'REMIND_INVOICE' || action === 'SEND_INVOICE',
      label: action === 'REMIND_INVOICE' ? 'Send reminder' : action === 'SEND_INVOICE' ? 'Send invoice' : action === 'ADD_DUE_DATE' ? 'Add a due date' : action === 'MONITOR_PAYMENT' ? 'Monitor payment' : 'No action'
    }
  };
}

function sumByCurrency(items) {
  const totals = {};
  for (const item of items) {
    const amount = Number(item.amount ?? item.total ?? 0);
    totals[item.currency || DEFAULT_CURRENCY] = roundCents((totals[item.currency || DEFAULT_CURRENCY] || 0) + amount);
  }
  return totals;
}

function buildInsights(invoices, { now = new Date().toISOString(), policy = loadPolicy() } = {}) {
  const payerStats = buildPayerStats(invoices);
  const invoiceInsights = invoices.map((invoice) => {
    const base = buildInvoiceInsight(invoice, now);
    const forecast = forecastInvoice(invoice, payerStats, { asOf: now });
    const withForecast = {
      ...base,
      expectedPaymentDate: forecast.expectedDate,
      expectedDaysFromNow: forecast.expectedDaysFromNow,
      forecastBasis: forecast.basis,
      forecastConfidence: forecast.confidence,
      payerMedianLatenessDays: forecast.medianLateness,
      payerPaidCount: forecast.paidCount
    };
    return applyPolicyToInsight(withForecast, invoice, policy, now);
  });
  const open = invoiceInsights.filter((insight) => insight.status === 'DRAFT' || insight.status === 'SENT');
  const actionable = invoiceInsights
    .filter((insight) => !['NO_ACTION', 'MONITOR_PAYMENT'].includes(insight.nextAction.action) && !CLOSED_STATUSES.includes(insight.status))
    .sort((a, b) => b.nextAction.priority - a.nextAction.priority || a.invoiceId.localeCompare(b.invoiceId));
  const overdue = open.filter((insight) => insight.daysUntilDue !== null && insight.daysUntilDue < 0);
  const dueWithin7 = open.filter((insight) => insight.daysUntilDue !== null && insight.daysUntilDue >= 0 && insight.daysUntilDue <= 7);
  const drafts = open.filter((insight) => insight.status === 'DRAFT');
  const sent = open.filter((insight) => insight.status === 'SENT');
  const outstandingByCurrency = sumByCurrency(sent);
  const draftByCurrency = sumByCurrency(drafts);
  const overdueByCurrency = sumByCurrency(overdue);
  const dueWithin7ByCurrency = sumByCurrency(dueWithin7);
  const collectedByCurrency = sumByCurrency(invoiceInsights.filter((insight) => insight.status === 'PAID'));

  const outstandingTotal = Object.values(outstandingByCurrency).reduce((sum, value) => sum + value, 0);
  const overdueTotal = Object.values(overdueByCurrency).reduce((sum, value) => sum + value, 0);
  const overdueRatio = outstandingTotal > 0 ? overdueTotal / outstandingTotal : 0;
  const healthScore = Math.max(0, Math.min(100, Math.round(100 - overdueRatio * 65 - drafts.length * 4 - (dueWithin7.length > 2 ? 5 : 0))));
  const healthLabel = healthScore >= 80 ? 'healthy' : healthScore >= 60 ? 'watch' : healthScore >= 40 ? 'at risk' : 'critical';

  const horizons = [7, 14, 30];
  const expectedCashPosition = projectCash(invoices, payerStats, horizons, { asOf: now });
  const projectedCashPosition = expectedCashPosition;
  const projections = horizons.map((horizonDays) => {
    const expected = invoiceInsights.filter((insight) => {
      if (insight.status !== 'SENT') return false;
      if (insight.expectedDaysFromNow !== null) return insight.expectedDaysFromNow <= horizonDays;
      return insight.daysUntilDue !== null && insight.daysUntilDue <= horizonDays;
    });
    return { horizonDays, expectedIncoming: expectedCashPosition[String(horizonDays)] || {}, invoiceIds: expected.map((item) => item.invoiceId) };
  });
  const totalForHorizon = (horizonDays) => Object.values(expectedCashPosition[String(horizonDays)] || {}).reduce((sum, value) => sum + value, 0);

  const policyDecisions = invoiceInsights
    .filter((insight) => insight.policy?.reminder)
    .map((insight) => ({ invoiceId: insight.invoiceId, customer: insight.customer?.name, ...insight.policy.reminder }));

  return {
    asOf: now,
    invoices: invoiceInsights,
    recommendations: actionable,
    projectedCashPosition,
    expectedCashPosition,
    projections,
    payerStats: {
      global: payerStats.global,
      payers: [...payerStats.payers.values()].sort((a, b) => b.paidCount - a.paidCount)
    },
    policy: { version: policy.version, reminders: policy.reminders, sending: policy.sending, writeOff: policy.writeOff },
    policyDecisions,
    summary: {
      invoiceCount: invoices.length,
      openCount: open.length,
      sentCount: sent.length,
      overdueCount: overdue.length,
      dueWithin7Count: dueWithin7.length,
      draftCount: drafts.length,
      paidCount: invoiceInsights.filter((insight) => insight.status === 'PAID').length,
      outstandingByCurrency,
      draftByCurrency,
      overdueByCurrency,
      dueWithin7ByCurrency,
      collectedByCurrency,
      outstandingTotal,
      overdueTotal,
      healthScore,
      healthLabel,
      projected7: totalForHorizon(7),
      projected14: totalForHorizon(14),
      projected30: totalForHorizon(30)
    },
    nextAction: actionable[0]?.nextAction || null,
    prioritizedNextAction: actionable[0]?.nextAction || null
  };
}

function createPayPalAdapter(env = process.env, options = {}) {
  const clientId = String(env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(env.PAYPAL_CLIENT_SECRET || '').trim();
  if (!clientId && !clientSecret) return new MockPayPalAdapter();
  if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must both be configured');
  return new PayPalSandboxAdapter({
    clientId,
    clientSecret,
    baseUrl: env.PAYPAL_BASE_URL || undefined,
    brandName: env.PAYPAL_BRAND_NAME || undefined,
    invoicerEmail: env.PAYPAL_INVOICER_EMAIL || undefined,
    ...options
  });
}

function rehydrateInvoice(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string') throw new Error('invalid persisted invoice');
  const invoice = { ...raw, customer: raw.customer || { name: 'Customer' }, items: Array.isArray(raw.items) ? raw.items : [] };
  invoice.payToken = invoice.payToken || newPayToken();
  invoice.reminderCount = Number(invoice.reminderCount) || 0;
  invoice.lastRemindedAt = invoice.lastRemindedAt || null;
  invoice.paypalOrderId = invoice.paypalOrderId || null;
  invoice.orderStatus = invoice.orderStatus || null;
  invoice.orderApproveUrl = invoice.orderApproveUrl || null;
  invoice.events = Array.isArray(raw.events) ? raw.events : [];
  if (invoice.events.some((event) => !event.hash)) {
    const sealed = [];
    for (const event of invoice.events) appendEvent(sealed, event);
    invoice.events = sealed;
  }
  return invoice;
}

class InvoiceStore {
  constructor({ adapter = createPayPalAdapter(), clock = () => new Date().toISOString(), seed = null, persistence = null, minReminderIntervalHours = 0, policy = loadPolicy() } = {}) {
    this.adapter = adapter;
    this.clock = clock;
    this.persistence = persistence;
    this.policy = policy;
    this.minReminderIntervalHours = Math.max(0, Number(minReminderIntervalHours) || 0);
    this.pendingSends = new Set();
    this.pendingReminders = new Set();
    this.pendingCaptures = new Set();
    this.restored = false;
    const snapshot = persistence?.load?.() || null;
    if (snapshot) {
      this.invoices = new Map((snapshot.invoices || []).map((invoice) => {
        const restored = rehydrateInvoice(invoice);
        // Mock checkout orders do not survive a process restart; clear the
        // stale remote handle so a new order can be created cleanly.
        if (this.adapter?.name === 'mock' && restored.orderStatus === 'CREATED') {
          restored.paypalOrderId = null;
          restored.orderStatus = null;
          restored.orderApproveUrl = null;
        }
        return [restored.id, restored];
      }));
      this.sequence = Number(snapshot.sequence) || this.inferencesSequence();
      this.restored = true;
    } else {
      const initial = seed || buildSeedInvoices({ now: this.clock() });
      this.invoices = new Map(initial.map((invoice) => [invoice.id, clone(invoice)]));
      this.sequence = 1;
    }
    this.syncAdapterSequence();
  }

  inferencesSequence() {
    let highest = 0;
    for (const id of this.invoices.keys()) {
      const match = id.match(/^inv_(\d+)$/);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    return highest + 1;
  }

  syncAdapterSequence() {
    if (this.adapter?.name !== 'mock') return;
    let highest = 0;
    for (const invoice of this.invoices.values()) {
      const match = String(invoice.paypalInvoiceId || '').match(/^MOCK-INV-(\d+)$/);
      if (match) highest = Math.max(highest, Number(match[1]));
    }
    this.adapter.sequence = Math.max(this.adapter.sequence || 1, highest + 1);
  }

  snapshot() {
    return { version: 1, savedAt: this.clock(), sequence: this.sequence, invoices: this.listInvoices() };
  }

  persist() {
    if (!this.persistence) return;
    this.persistence.scheduleSave(this.snapshot());
  }

  listInvoices() { return clone([...this.invoices.values()]); }

  getInvoice(id) {
    const invoice = this.invoices.get(id);
    if (!invoice) throw new NotFoundError(`invoice ${id} was not found`);
    return invoice;
  }

  findByPayToken(token) {
    if (typeof token !== 'string' || token.length < 10 || token.length > 128) throw new NotFoundError('payment link was not found');
    const invoice = [...this.invoices.values()].find((candidate) => candidate.payToken === token);
    if (!invoice) throw new NotFoundError('payment link was not found');
    return invoice;
  }

  state() {
    const invoices = this.listInvoices();
    const insights = buildInsights(invoices, { now: this.clock(), policy: this.policy });
    const byStatus = {};
    for (const invoice of invoices) byStatus[invoice.status] = (byStatus[invoice.status] || 0) + 1;
    return {
      invoices,
      summary: {
        ...insights.summary,
        invoiceCount: invoices.length,
        byStatus,
        outstanding: insights.summary.outstandingByCurrency,
        paid: insights.summary.collectedByCurrency,
        totalOutstanding: insights.summary.outstandingByCurrency.USD || 0,
        totalPaid: insights.summary.collectedByCurrency.USD || 0
      },
      adapter: this.adapter.name,
      persisted: Boolean(this.persistence),
      policy: insights.policy
    };
  }

  insights() {
    return buildInsights(this.listInvoices(), { now: this.clock(), policy: this.policy });
  }

  payerStats() {
    return this.insights().payerStats;
  }

  verifyAudit() {
    const invoices = [...this.invoices.values()].map((invoice) => {
      const chain = verifyChain(invoice.events);
      return { invoiceId: invoice.id, ...chain };
    });
    const checkedEvents = invoices.reduce((sum, item) => sum + item.total, 0);
    const failures = invoices.filter((item) => !item.valid);
    return {
      valid: failures.length === 0,
      checkedAt: this.clock(),
      invoiceCount: invoices.length,
      checkedEvents,
      failures,
      invoices
    };
  }

  createInvoice(input) {
    const id = `inv_${String(this.sequence++).padStart(5, '0')}`;
    const now = this.clock();
    const invoice = normalizeInvoiceInput(input, id, now);
    invoice.payToken = newPayToken();
    this.invoices.set(id, invoice);
    this.persist();
    return clone(invoice);
  }

  async sendInvoice(id, { actor = 'merchant' } = {}) {
    const invoice = this.getInvoice(id);
    if (invoice.status === 'SENT') throw new ValidationError('invoice has already been sent');
    if (invoice.status !== 'DRAFT') throw new ValidationError(`a ${invoice.status.toLowerCase()} invoice cannot be sent`);
    if (this.pendingSends.has(id)) throw new ValidationError('invoice is already being sent');
    this.pendingSends.add(id);
    try {
      if (!invoice.paypalInvoiceId) {
        const remote = await this.adapter.createInvoice(invoice);
        if (!remote?.id) throw new PayPalError('PayPal did not return an invoice id');
        invoice.paypalInvoiceId = remote.id;
      }
      await this.adapter.sendInvoice(invoice.paypalInvoiceId);
      invoice.status = 'SENT';
      invoice.updatedAt = this.clock();
      appendEvent(invoice.events, { type: 'INVOICING.INVOICE.SENT', at: invoice.updatedAt, actor, source: this.adapter.name, detail: { paypalInvoiceId: invoice.paypalInvoiceId } });
      this.persist();
      return clone(invoice);
    } finally {
      this.pendingSends.delete(id);
    }
  }

  async remindInvoice(id, { actor = 'merchant', force = false } = {}) {
    const invoice = this.getInvoice(id);
    if (!REMINDABLE_STATUSES.includes(invoice.status)) throw new ValidationError('only a sent invoice can be reminded');
    if (!invoice.paypalInvoiceId) throw new ValidationError('invoice has not been sent through PayPal');
    if (this.pendingReminders.has(id)) throw new ValidationError('a reminder is already being sent');
    if (!force && this.minReminderIntervalHours > 0 && invoice.lastRemindedAt) {
      const elapsedHours = (Date.parse(this.clock()) - Date.parse(invoice.lastRemindedAt)) / 3600000;
      if (elapsedHours < this.minReminderIntervalHours) throw new ValidationError(`a reminder was sent less than ${this.minReminderIntervalHours} hours ago`);
    }
    this.pendingReminders.add(id);
    try {
      await this.adapter.remindInvoice(invoice.paypalInvoiceId);
      invoice.reminderCount = (invoice.reminderCount || 0) + 1;
      invoice.updatedAt = this.clock();
      invoice.lastRemindedAt = invoice.updatedAt;
      appendEvent(invoice.events, { type: 'INVOICING.INVOICE.REMINDER_SENT', at: invoice.updatedAt, actor, source: this.adapter.name, detail: { reminderNumber: invoice.reminderCount } });
      this.persist();
      return clone(invoice);
    } finally {
      this.pendingReminders.delete(id);
    }
  }

  async cancelInvoice(id, { actor = 'merchant', reason = 'Cancelled by the merchant' } = {}) {
    const invoice = this.getInvoice(id);
    if (!['DRAFT', 'SENT'].includes(invoice.status)) throw new ValidationError(`a ${invoice.status.toLowerCase()} invoice cannot be cancelled`);
    if (invoice.status === 'SENT') {
      if (!invoice.paypalInvoiceId) throw new ValidationError('invoice has not been sent through PayPal');
      await this.adapter.cancelInvoice(invoice.paypalInvoiceId);
    }
    invoice.status = 'CANCELLED';
    invoice.updatedAt = this.clock();
    appendEvent(invoice.events, { type: 'INVOICING.INVOICE.CANCELLED', at: invoice.updatedAt, actor, source: this.adapter.name, detail: { reason } });
    this.persist();
    return clone(invoice);
  }

  async ensurePaymentOrder(id, { baseUrl } = {}) {
    const invoice = this.getInvoice(id);
    if (invoice.status !== 'SENT') throw new ValidationError(`a ${invoice.status.toLowerCase()} invoice cannot be paid`);
    if (!invoice.customer?.email) throw new ValidationError('a customer email is required before a payment link can be created');
    if (invoice.paypalOrderId && ['CREATED', 'APPROVED'].includes(invoice.orderStatus)) {
      return { order: { id: invoice.paypalOrderId, status: invoice.orderStatus, approveUrl: invoice.orderApproveUrl, mock: this.adapter.name === 'mock' }, invoice: clone(invoice) };
    }
    if (typeof this.adapter.createOrder !== 'function') throw new PayPalError('the configured adapter does not support checkout orders');
    const returnUrl = baseUrl ? `${baseUrl}/pay/${invoice.payToken}?status=return` : undefined;
    const cancelUrl = baseUrl ? `${baseUrl}/pay/${invoice.payToken}?status=cancel` : undefined;
    const order = await this.adapter.createOrder(invoice, { returnUrl, cancelUrl });
    if (!order?.id) throw new PayPalError('PayPal did not return an order id');
    invoice.paypalOrderId = order.id;
    invoice.orderStatus = order.status || 'CREATED';
    invoice.orderApproveUrl = order.approveUrl || null;
    invoice.updatedAt = this.clock();
    appendEvent(invoice.events, { type: 'CHECKOUT.ORDER.CREATED', at: invoice.updatedAt, actor: 'merchant', source: this.adapter.name, detail: { orderId: order.id } });
    this.persist();
    return { order: { ...order, id: order.id, status: invoice.orderStatus }, invoice: clone(invoice) };
  }

  async capturePayment(id, { orderId, source = 'paypal-checkout', verified = false, actor = 'customer' } = {}) {
    const invoice = this.getInvoice(id);
    if (invoice.status === 'PAID') return { duplicate: true, invoice: clone(invoice), capture: null };
    if (invoice.status !== 'SENT') throw new ValidationError(`a ${invoice.status.toLowerCase()} invoice cannot be paid`);
    const resolvedOrderId = orderId || invoice.paypalOrderId;
    if (!resolvedOrderId) throw new ValidationError('a PayPal order must be created before it can be captured');
    if (this.pendingCaptures.has(id)) throw new ValidationError('this payment is already being captured');
    this.pendingCaptures.add(id);
    try {
      const capture = await this.adapter.captureOrder(resolvedOrderId);
      if (!capture || !['COMPLETED', 'APPROVED'].includes(String(capture.status || '').toUpperCase())) {
        throw new PayPalError('PayPal did not confirm the payment capture');
      }
      invoice.status = 'PAID';
      invoice.orderStatus = 'COMPLETED';
      invoice.paymentReference = capture.captureId || resolvedOrderId;
      invoice.paidAt = this.clock();
      invoice.updatedAt = invoice.paidAt;
      appendEvent(invoice.events, {
        type: 'PAYMENT.CAPTURE.COMPLETED',
        at: invoice.paidAt,
        actor,
        source,
        verified,
        eventId: capture.captureId || resolvedOrderId,
        detail: { orderId: resolvedOrderId, captureId: capture.captureId || null, amount: capture.amount ?? invoice.total, currency: capture.currency || invoice.currency }
      });
      this.persist();
      return { duplicate: false, invoice: clone(invoice), capture };
    } finally {
      this.pendingCaptures.delete(id);
    }
  }

  /**
   * Record a payment that PayPal has already confirmed (for example through a
   * PAYMENT.CAPTURE.COMPLETED webhook). Unlike capturePayment this never calls
   * the capture endpoint again.
   */
  recordPayment(id, { source = 'paypal', verified = true, eventId = null, detail = {}, actor = 'paypal' } = {}) {
    const invoice = this.getInvoice(id);
    if (invoice.status === 'PAID') return { duplicate: true, invoice: clone(invoice) };
    if (invoice.status !== 'SENT') throw new ValidationError(`a ${invoice.status.toLowerCase()} invoice cannot record a payment`);
    invoice.status = 'PAID';
    invoice.paidAt = this.clock();
    invoice.updatedAt = invoice.paidAt;
    invoice.paymentReference = detail.captureId || eventId || invoice.paymentReference || null;
    appendEvent(invoice.events, {
      type: 'PAYMENT.CAPTURE.COMPLETED',
      at: invoice.paidAt,
      actor,
      source,
      verified,
      ...(eventId ? { eventId } : {}),
      detail
    });
    this.persist();
    return { duplicate: false, invoice: clone(invoice) };
  }

  simulateWebhook(input, { source = 'simulated', verified = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('webhook body must be an object');
    const eventType = input.eventType ?? input.event_type;
    const resource = input.resource && typeof input.resource === 'object' ? input.resource : {};
    const invoiceId = input.invoiceId ?? input.invoice_id ?? resource.invoice_id ?? resource.id ?? resource.invoice?.id;
    const allowed = new Set(['INVOICING.INVOICE.SENT', 'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.VOIDED', 'INVOICING.INVOICE.REFUNDED']);
    if (typeof eventType !== 'string' || !allowed.has(eventType)) throw new ValidationError('eventType must be a supported invoice webhook event');
    if (typeof invoiceId !== 'string' || !invoiceId) throw new ValidationError('invoiceId is required');
    let invoice = this.invoices.get(invoiceId);
    if (!invoice) invoice = [...this.invoices.values()].find((candidate) => candidate.paypalInvoiceId === invoiceId);
    if (!invoice) throw new NotFoundError(`invoice ${invoiceId} was not found`);
    const nextStatus = eventType.endsWith('.PAID') ? 'PAID'
      : eventType.endsWith('.SENT') ? 'SENT'
        : eventType.endsWith('.VOIDED') ? 'VOID'
          : eventType.endsWith('.REFUNDED') ? 'REFUNDED'
            : 'CANCELLED';
    const eventId = input.eventId ?? input.event_id ?? input.id;
    const eventKey = eventId ? `id:${eventId}` : `type:${eventType}`;
    const duplicate = invoice.events.some((event) => event.eventKey === eventKey || (!eventId && event.type === eventType));
    const baseEvent = { type: eventType, invoiceId: invoice.id, source, verified, ...(eventId ? { eventId } : {}) };
    if (duplicate) return { accepted: true, duplicate: true, invoice: clone(invoice), event: baseEvent };
    if (invoice.status === nextStatus || !(INVOICE_TRANSITIONS[invoice.status] || []).includes(nextStatus)) {
      return { accepted: true, duplicate: invoice.status === nextStatus, ignored: true, stale: invoice.status !== nextStatus, invoice: clone(invoice), event: baseEvent };
    }
    invoice.status = nextStatus;
    invoice.updatedAt = this.clock();
    if (nextStatus === 'PAID') invoice.paidAt = invoice.updatedAt;
    appendEvent(invoice.events, { type: eventType, at: invoice.updatedAt, source, verified, eventKey, actor: source === 'paypal' ? 'paypal' : 'simulator', ...(eventId ? { eventId } : {}) });
    this.persist();
    return { accepted: true, duplicate: false, invoice: clone(invoice), event: baseEvent };
  }

  reset() {
    const seeds = buildSeedInvoices({ now: this.clock() });
    this.invoices = new Map(seeds.map((invoice) => [invoice.id, clone(invoice)]));
    this.sequence = 1;
    this.syncAdapterSequence();
    this.persist();
    return this.state();
  }
}

/**
 * A stable, public projection of an invoice for the customer-facing pay page.
 * It intentionally excludes merchant-only fields such as PayPal ids and events.
 */
function publicInvoiceView(invoice) {
  return {
    id: invoice.id,
    customer: { name: invoice.customer.name },
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    notes: invoice.notes,
    items: invoice.items.map((item) => ({ description: item.description, quantity: item.quantity, unitPrice: item.unitPrice, amount: item.amount })),
    subtotal: invoice.subtotal,
    taxRate: invoice.taxRate,
    tax: invoice.tax,
    total: invoice.total,
    status: invoice.status,
    payToken: invoice.payToken,
    paidAt: invoice.paidAt || null,
    paymentReference: invoice.paymentReference || null,
    orderStatus: invoice.orderStatus || null
  };
}

module.exports = {
  CLOSED_STATUSES,
  DEFAULT_CURRENCY,
  INVOICE_STATUSES,
  INVOICE_TRANSITIONS,
  AuthorizationError,
  InvoiceStore,
  MockPayPalAdapter,
  NotFoundError,
  PayPalError,
  PayPalSandboxAdapter,
  SEEDED_INVOICES,
  ValidationError,
  allocateTax,
  buildInsights,
  buildPayPalInvoicePayload,
  buildPayPalOrderPayload,
  buildSeedInvoices,
  calculateTotals,
  createPayPalAdapter,
  extractCurrency,
  extractCustomer,
  getAIProviderStatus,
  normalizeInvoiceInput,
  parseInvoiceText,
  parseInvoiceTextAsync,
  parseInvoiceTextWithMetadataAsync,
  parseItems,
  parseTaxRate,
  publicInvoiceView,
  resolveAIProvider,
  verifyChain
};
