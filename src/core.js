'use strict';

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
  SENT: Object.freeze(['PAID', 'CANCELLED', 'VOID'])
});

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

function extractCurrency(text) {
  const explicit = text.match(/\b(?:currency\s*[:=]?\s*)?(USD|EUR|GBP|CAD|AUD|JPY)\b/i);
  if (explicit) return explicit[1].toUpperCase();
  if (text.includes('€')) return 'EUR';
  if (text.includes('£')) return 'GBP';
  if (text.includes('¥')) return 'JPY';
  return DEFAULT_CURRENCY;
}

function extractCustomer(text) {
  const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  const email = emailMatch ? emailMatch[0].toLowerCase() : null;
  let name = null;
  const patterns = [
    /(?:invoice|bill)\s+(?:for|to)\s+([^\n,;<(]+?)(?:\s*<[^>]+>|\s+\S+@\S+)?(?:[,;\n]|$)/i,
    /(?:customer|client|recipient)\s*[:=-]\s*([^\n,;<(]+?)(?:\s*<[^>]+>|\s+\S+@\S+)?(?:[,;\n]|$)/i,
    /(?:to)\s*[:=-]\s*([^\n,;<(]+?)(?:\s*<[^>]+>|\s+\S+@\S+)?(?:[,;\n]|$)/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      name = match[1].trim().replace(/\s+(?:email|e-mail)\s*$/i, '').trim();
      break;
    }
  }
  if (!name && email) {
    name = email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return { name: name || 'Customer', email };
}

function parseDueDate(text, baseDate = new Date()) {
  const absolute = text.match(/(?:due|pay(?:able)?\s+by)\s*(?:date)?\s*[:=]?\s*(\d{4}-\d{2}-\d{2})/i);
  if (absolute) return validateDate(absolute[1]);
  const relative = text.match(/due\s+in\s+(\d{1,3})\s+days?/i);
  if (relative) {
    const due = new Date(baseDate);
    if (Number.isNaN(due.getTime())) throw new ValidationError('base date must be valid');
    due.setUTCDate(due.getUTCDate() + Number(relative[1]));
    return due.toISOString().slice(0, 10);
  }
  return null;
}

function parseItems(text) {
  const items = [];
  const lines = text.split(/[\n\r]+/).map((line) => line.trim()).filter(Boolean);
  const candidates = lines.length > 1 ? lines : text.split(/\s*(?:;|,(?=\s*\d)|\s+and\s+(?=\d))/i).map((part) => part.trim()).filter(Boolean);
  for (const candidate of candidates) {
    if (/^(?:invoice|bill|customer|client|recipient|email|tax|currency|due|notes?)[\s:=-]/i.test(candidate)) continue;
    let match = candidate.match(/^[-*]?\s*(\d+(?:\.\d+)?)\s*(?:x|×|units?\s+of)?\s+(.+?)\s+(?:at|@|x|each\s+at)\s*[$€£¥]?\s*([\d,]+(?:\.\d{1,2})?)\s*(?:each|per\s+(?:hour|unit)|\/\s*(?:hour|unit))?\s*$/i);
    if (!match) {
      match = candidate.match(/^[-*]?\s*(.+?)\s*[-:]\s*(\d+(?:\.\d+)?)\s*(?:x\s*)?[$€£¥]?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i);
      if (match) match = [match[0], match[2], match[1], match[3]];
    }
    if (!match) {
      match = candidate.match(/^[-*]?\s*(\d+(?:\.\d+)?)\s+(.+?)\s+[$€£¥]?\s*([\d,]+(?:\.\d{1,2})?)\s*$/i);
    }
    if (match) {
      const quantity = Number(match[1]);
      const description = match[2].replace(/[,.]$/, '').replace(/^(?:hours?|hrs?|units?|items?)\s+(?:of\s+)?/i, '').trim();
      const unitPrice = Number(match[3].replace(/,/g, ''));
      if (description && Number.isFinite(quantity) && Number.isFinite(unitPrice)) items.push({ description, quantity, unitPrice });
    }
  }
  if (items.length === 0) {
    const fallback = text.match(/(?:for|of)\s+(.+?)\s+(?:at|for)\s*[$€£¥]?\s*([\d,]+(?:\.\d{1,2})?)/i);
    if (fallback) items.push({ description: fallback[1].replace(/[,.]$/, '').replace(/^(?:hours?|hrs?|units?|items?)\s+(?:of\s+)?/i, '').trim(), quantity: 1, unitPrice: Number(fallback[2].replace(/,/g, '')) });
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
    ollama: configuredProvider === 'ollama' || Boolean(configuredValue(env, 'OLLAMA_BASE_URL'))
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

function parseInvoiceText(input, { openAIHook, now = new Date() } = {}) {
  // Keep this synchronous deterministic path available for offline callers.
  // The HTTP app uses parseInvoiceTextAsync so an optional AI extractor can be
  // used without changing the deterministic fallback.
  if (process.env.OPENAI_API_KEY && typeof openAIHook === 'function') return openAIHook(input);
  if (typeof input !== 'string' || input.trim().length < 3 || input.length > MAX_BODY_TEXT) {
    throw new ValidationError(`text must be between 3 and ${MAX_BODY_TEXT} characters`);
  }
  const text = input.trim();
  const customer = extractCustomer(text);
  const items = parseItems(text);
  if (items.length === 0) throw new ValidationError('could not find an invoice item; include quantity, description, and price');
  const taxMatch = text.match(/(?:sales\s+)?tax\s*[:=]?\s*(\d+(?:\.\d+)?)\s*%/i);
  const taxRate = taxMatch ? Number(taxMatch[1]) : 0;
  const totals = calculateTotals(items, taxRate);
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

function seedInvoice(data) {
  const totals = calculateTotals(data.items, data.taxRate || 0);
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
    reminderCount: data.reminderCount || 0,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    events: data.events || []
  };
}

const SEEDED_INVOICES = [
  seedInvoice({
    id: 'inv_seed_001',
    customer: { name: 'Northwind Studio', email: 'billing@northwind.example' },
    currency: 'USD',
    dueDate: '2026-11-15',
    items: [{ description: 'Cashflow setup', quantity: 1, unitPrice: 450 }],
    taxRate: 8.25,
    status: 'SENT',
    paypalInvoiceId: 'MOCK-INV-SEED-001',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    events: [{ type: 'INVOICING.INVOICE.SENT', at: '2026-10-01T09:00:00.000Z' }]
  }),
  seedInvoice({
    id: 'inv_seed_002',
    customer: { name: 'Acme Design Co', email: 'accounts@acme.example' },
    currency: 'USD',
    dueDate: '2026-10-18',
    items: [{ description: 'Brand review', quantity: 2, unitPrice: 125 }],
    taxRate: 0,
    status: 'SENT',
    paypalInvoiceId: 'MOCK-INV-SEED-002',
    createdAt: '2026-09-15T09:00:00.000Z',
    updatedAt: '2026-10-08T09:00:00.000Z',
    events: [{ type: 'INVOICING.INVOICE.SENT', at: '2026-10-08T09:00:00.000Z' }]
  })
];

class MockPayPalAdapter {
  constructor() {
    this.name = 'mock';
    this.sequence = 1;
    this.reminders = [];
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
}

class PayPalSandboxAdapter {
  constructor({ clientId, clientSecret, fetchImpl = globalThis.fetch, baseUrl = 'https://api-m.sandbox.paypal.com', timeoutMs = normalizeTimeout(process.env.PAYPAL_TIMEOUT_MS || process.env.OUTBOUND_TIMEOUT_MS) } = {}) {
    if (!clientId || !clientSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required together');
    if (typeof fetchImpl !== 'function') throw new Error('fetch is required for the PayPal sandbox adapter');
    this.name = 'paypal-sandbox';
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = normalizeTimeout(timeoutMs);
    this.token = null;
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
      const body = await safeJson(response, this.timeoutMs, 'PayPal authentication response');
      if (!response.ok || !body?.access_token) throw new PayPalError('PayPal authentication failed');
      this.token = { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in || 300) * 1000 };
      return this.token.value;
    } catch (error) {
      if (error.code === 'ETIMEDOUT') throw new PayPalError('PayPal authentication request timed out');
      throw error;
    }
  }

  async request(path, options = {}) {
    try {
      const token = await this.accessToken();
      const response = await fetchWithTimeout(this.fetch, `${this.baseUrl}${path}`, {
        ...options,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(options.headers || {}) }
      }, this.timeoutMs, 'PayPal API request');
      const body = await safeJson(response, this.timeoutMs, 'PayPal API response');
      if (!response.ok) throw new PayPalError(`PayPal request failed (${response.status})`);
      return body;
    } catch (error) {
      if (error.code === 'ETIMEDOUT') throw new PayPalError('PayPal API request timed out');
      throw error;
    }
  }

  async createInvoice(invoice) {
    const payload = {
      detail: {
        invoice_number: invoice.id,
        reference: invoice.reference || invoice.id,
        currency_code: invoice.currency,
        note: invoice.notes || undefined,
        payment_term: invoice.dueDate ? { term_type: 'DUE_ON_DATE_SPECIFIED', due_date: invoice.dueDate } : undefined
      },
      invoicer: { name: { given_name: 'Cashflow', surname: 'Copilot' } },
      primary_recipients: [{ billing_info: { name: { full_name: invoice.customer.name }, email_address: invoice.customer.email } }],
      items: invoice.items.map((item) => ({ name: item.description, quantity: String(item.quantity), unit_amount: { currency_code: invoice.currency, value: item.unitPrice.toFixed(2) }, unit_of_measure: 'QUANTITY' }))
    };
    return this.request('/v2/invoicing/invoices', { method: 'POST', body: JSON.stringify(payload) });
  }

  async sendInvoice(paypalInvoiceId) {
    await this.request(`/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}/send`, { method: 'POST', body: JSON.stringify({}) });
    return { id: paypalInvoiceId, status: 'SENT' };
  }

  async remindInvoice(paypalInvoiceId) {
    await this.request(`/v2/invoicing/invoices/${encodeURIComponent(paypalInvoiceId)}/remind`, { method: 'POST', body: JSON.stringify({}) });
    return { id: paypalInvoiceId, status: 'SENT', reminded: true };
  }

  async verifyWebhookSignature({ transmissionId, transmissionTime, certUrl, authAlgo, transmissionSig, webhookId, webhookEvent }) {
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
  const closed = ['PAID', 'CANCELLED', 'VOID'].includes(invoice.status);
  const days = invoice.dueDate ? daysUntil(invoice.dueDate, asOf) : null;
  let risk = 'LOW';
  let urgency = 'LOW';
  let priority = 0;
  let action = 'NO_ACTION';
  const reasonCodes = [`STATUS_${invoice.status}`];

  if (invoice.status === 'DRAFT') {
    risk = 'MEDIUM';
    urgency = 'HIGH';
    priority = 90;
    action = 'SEND_INVOICE';
    reasonCodes.push('DRAFT_NOT_SENT');
  } else if (invoice.status === 'SENT') {
    action = 'MONITOR_PAYMENT';
    priority = 20;
    if (days === null) {
      risk = 'MEDIUM';
      urgency = 'MEDIUM';
      priority = 55;
      action = 'ADD_DUE_DATE';
      reasonCodes.push('NO_DUE_DATE');
    } else if (days < 0) {
      risk = days <= -7 ? 'CRITICAL' : 'HIGH';
      urgency = days <= -7 ? 'CRITICAL' : 'HIGH';
      priority = days <= -7 ? 100 : 95;
      action = 'REMIND_INVOICE';
      reasonCodes.push('OVERDUE');
      if (days <= -7) reasonCodes.push('OVERDUE_7_PLUS_DAYS');
    } else if (days <= 3) {
      risk = 'HIGH';
      urgency = 'HIGH';
      priority = 85;
      action = 'REMIND_INVOICE';
      reasonCodes.push('DUE_WITHIN_3_DAYS');
    } else if (days <= 7) {
      risk = 'MEDIUM';
      urgency = 'MEDIUM';
      priority = 65;
      action = 'REMIND_INVOICE';
      reasonCodes.push('DUE_WITHIN_7_DAYS');
    } else {
      reasonCodes.push('PAYMENT_PENDING');
    }
  } else if (closed) {
    reasonCodes.push(invoice.status === 'PAID' ? 'PAID_IN_FULL' : 'CLOSED');
  } else {
    risk = 'MEDIUM';
    urgency = 'MEDIUM';
    priority = 40;
    action = 'REVIEW_STATUS';
    reasonCodes.push('UNMAPPED_STATUS');
  }

  return {
    invoiceId: invoice.id,
    customer: invoice.customer,
    status: invoice.status,
    amount: invoice.total,
    currency: invoice.currency,
    dueDate: invoice.dueDate,
    daysUntilDue: days,
    risk,
    urgency,
    confidence: days === null && invoice.status === 'SENT' ? 0.84 : 0.99,
    reasonCodes,
    nextAction: { type: action, action, priority, invoiceId: invoice.id, reasonCodes: [...reasonCodes] }
  };
}

function buildInsights(invoices, { now = new Date().toISOString() } = {}) {
  const invoiceInsights = invoices.map((invoice) => buildInvoiceInsight(invoice, now));
  const recommendations = invoiceInsights.slice().sort((a, b) => b.nextAction.priority - a.nextAction.priority || a.invoiceId.localeCompare(b.invoiceId));
  const horizons = [7, 14, 30];
  const projectedCashPosition = {};
  const projections = [];
  for (const horizonDays of horizons) {
    const byCurrency = {};
    for (const insight of invoiceInsights) {
      if (insight.status !== 'SENT' || insight.daysUntilDue === null || insight.daysUntilDue > horizonDays) continue;
      byCurrency[insight.currency] = roundCents((byCurrency[insight.currency] || 0) + insight.amount);
    }
    projectedCashPosition[String(horizonDays)] = byCurrency;
    projections.push({ horizonDays, expectedIncoming: byCurrency, invoiceIds: invoiceInsights.filter((item) => item.status === 'SENT' && item.daysUntilDue !== null && item.daysUntilDue <= horizonDays).map((item) => item.invoiceId) });
  }
  return {
    asOf: now,
    invoices: invoiceInsights,
    recommendations,
    projectedCashPosition,
    projections,
    nextAction: recommendations[0]?.nextAction || null,
    prioritizedNextAction: recommendations[0]?.nextAction || null
  };
}

function createPayPalAdapter(env = process.env, options = {}) {
  const hasId = Boolean(env.PAYPAL_CLIENT_ID);
  const hasSecret = Boolean(env.PAYPAL_CLIENT_SECRET);
  if (!hasId && !hasSecret) return new MockPayPalAdapter();
  if (!hasId || !hasSecret) throw new Error('PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET must both be configured');
  return new PayPalSandboxAdapter({ clientId: env.PAYPAL_CLIENT_ID, clientSecret: env.PAYPAL_CLIENT_SECRET, ...options });
}

class InvoiceStore {
  constructor({ adapter = createPayPalAdapter(), clock = () => new Date().toISOString(), seed = SEEDED_INVOICES } = {}) {
    this.adapter = adapter;
    this.clock = clock;
    this.invoices = new Map(seed.map((invoice) => [invoice.id, clone(invoice)]));
    this.sequence = 1;
    this.pendingSends = new Set();
  }

  listInvoices() { return clone([...this.invoices.values()]); }

  getInvoice(id) {
    const invoice = this.invoices.get(id);
    if (!invoice) throw new NotFoundError(`invoice ${id} was not found`);
    return invoice;
  }

  state() {
    const invoices = this.listInvoices();
    const byStatus = {};
    const outstanding = {};
    const paid = {};
    for (const invoice of invoices) {
      byStatus[invoice.status] = (byStatus[invoice.status] || 0) + 1;
      if (invoice.status === 'PAID') paid[invoice.currency] = roundCents((paid[invoice.currency] || 0) + invoice.total);
      else if (!['CANCELLED', 'VOID'].includes(invoice.status)) outstanding[invoice.currency] = roundCents((outstanding[invoice.currency] || 0) + invoice.total);
    }
    return { invoices, summary: { invoiceCount: invoices.length, byStatus, outstanding, paid, totalOutstanding: outstanding.USD || 0, totalPaid: paid.USD || 0 }, adapter: this.adapter.name };
  }

  insights() {
    return buildInsights(this.listInvoices(), { now: this.clock() });
  }

  createInvoice(input) {
    const id = `inv_${String(this.sequence++).padStart(5, '0')}`;
    const now = this.clock();
    const invoice = normalizeInvoiceInput(input, id, now);
    this.invoices.set(id, invoice);
    return clone(invoice);
  }

  async sendInvoice(id) {
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
      invoice.events.push({ type: 'INVOICING.INVOICE.SENT', at: invoice.updatedAt });
      return clone(invoice);
    } finally {
      this.pendingSends.delete(id);
    }
  }

  async remindInvoice(id) {
    const invoice = this.getInvoice(id);
    if (invoice.status !== 'SENT') throw new ValidationError('only a sent invoice can be reminded');
    if (!invoice.paypalInvoiceId) throw new ValidationError('invoice has not been sent through PayPal');
    await this.adapter.remindInvoice(invoice.paypalInvoiceId);
    invoice.reminderCount = (invoice.reminderCount || 0) + 1;
    invoice.updatedAt = this.clock();
    invoice.events.push({ type: 'INVOICING.INVOICE.REMINDER_SENT', at: invoice.updatedAt });
    return clone(invoice);
  }

  simulateWebhook(input, { source = 'simulated', verified = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError('webhook body must be an object');
    const eventType = input.eventType ?? input.event_type;
    const resource = input.resource && typeof input.resource === 'object' ? input.resource : {};
    const invoiceId = input.invoiceId ?? input.invoice_id ?? resource.invoice_id ?? resource.id ?? resource.invoice?.id;
    const allowed = new Set(['INVOICING.INVOICE.SENT', 'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.CANCELLED', 'INVOICING.INVOICE.VOIDED']);
    if (typeof eventType !== 'string' || !allowed.has(eventType)) throw new ValidationError('eventType must be a supported invoice webhook event');
    if (typeof invoiceId !== 'string' || !invoiceId) throw new ValidationError('invoiceId is required');
    let invoice = this.invoices.get(invoiceId);
    if (!invoice) invoice = [...this.invoices.values()].find((candidate) => candidate.paypalInvoiceId === invoiceId);
    if (!invoice) throw new NotFoundError(`invoice ${invoiceId} was not found`);
    const nextStatus = eventType.endsWith('.PAID') ? 'PAID' : eventType.endsWith('.SENT') ? 'SENT' : eventType.endsWith('.VOIDED') ? 'VOID' : 'CANCELLED';
    const eventId = input.eventId ?? input.event_id ?? input.id;
    const eventKey = eventId ? `id:${eventId}` : `type:${eventType}`;
    const duplicate = invoice.events.some((event) => event.eventKey === eventKey || (!eventId && event.type === eventType));
    if (duplicate) return { accepted: true, duplicate: true, invoice: clone(invoice), event: { type: eventType, invoiceId: invoice.id, source, verified, ...(eventId ? { eventId } : {}) } };
    if (invoice.status === nextStatus || !(INVOICE_TRANSITIONS[invoice.status] || []).includes(nextStatus)) {
      return {
        accepted: true,
        duplicate: invoice.status === nextStatus,
        ignored: true,
        stale: invoice.status !== nextStatus,
        invoice: clone(invoice),
        event: { type: eventType, invoiceId: invoice.id, source, verified, ...(eventId ? { eventId } : {}) }
      };
    }
    invoice.status = nextStatus;
    invoice.updatedAt = this.clock();
    invoice.events.push({ type: eventType, at: invoice.updatedAt, source, verified, eventKey, ...(eventId ? { eventId } : {}) });
    return { accepted: true, duplicate: false, invoice: clone(invoice), event: { type: eventType, invoiceId: invoice.id, source, verified, ...(eventId ? { eventId } : {}) } };
  }
}

module.exports = {
  DEFAULT_CURRENCY,
  AuthorizationError,
  InvoiceStore,
  MockPayPalAdapter,
  NotFoundError,
  PayPalError,
  PayPalSandboxAdapter,
  SEEDED_INVOICES,
  ValidationError,
  calculateTotals,
  buildInsights,
  createPayPalAdapter,
  getAIProviderStatus,
  normalizeInvoiceInput,
  parseInvoiceText,
  parseInvoiceTextAsync,
  parseInvoiceTextWithMetadataAsync,
  resolveAIProvider
};
