'use strict';

/**
 * Payer-aware cash forecasting.
 *
 * The model is deliberately small and explainable:
 *   expected payment date = due date + median observed lateness for that payer
 * If a payer has no history, fall back to the portfolio median, then to zero.
 *
 * `scripts/backtest.js` trains and tests this model against two baselines on a
 * deterministic synthetic ledger. The same pure functions run on live invoice
 * history inside the app, so the published number is reproducible.
 */

const DAY_MS = 86400000;

function toDay(value) {
  const parsed = Date.parse(String(value || '').slice(0, 10));
  return Number.isNaN(parsed) ? null : Math.floor(parsed / DAY_MS);
}

function median(values) {
  const numbers = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

function payerKey(invoice) {
  const email = String(invoice.customer?.email || '').toLowerCase().trim();
  if (email) return email;
  return `name:${String(invoice.customer?.name || '').toLowerCase().trim()}`;
}

/**
 * Build per-payer lateness statistics from paid invoices.
 * Lateness is sign-correct: positive means paid after the due date.
 */
function buildPayerStats(invoices) {
  const buckets = new Map();
  const all = [];
  for (const invoice of invoices) {
    if (invoice.status !== 'PAID') continue;
    const due = toDay(invoice.dueDate);
    if (due === null) continue;
    const paidDay = toDay(invoice.paidAt || invoice.updatedAt);
    if (paidDay === null) continue;
    const lateness = paidDay - due;
    const key = payerKey(invoice);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(lateness);
    all.push(lateness);
  }
  const stats = new Map();
  for (const [key, values] of buckets) {
    stats.set(key, {
      payer: key,
      paidCount: values.length,
      medianLateness: median(values),
      meanLateness: values.reduce((sum, value) => sum + value, 0) / values.length
    });
  }
  return {
    payers: stats,
    global: { paidCount: all.length, medianLateness: median(all) ?? 0, meanLateness: all.length ? all.reduce((sum, value) => sum + value, 0) / all.length : 0 }
  };
}

/**
 * @returns {{expectedDate: string|null, expectedDaysFromNow: number|null, basis: string, confidence: number, medianLateness: number, paidCount: number}}
 */
function forecastInvoice(invoice, stats, { asOf = new Date().toISOString() } = {}) {
  const due = toDay(invoice.dueDate);
  const today = toDay(asOf);
  if (due === null || today === null) {
    return { expectedDate: null, expectedDaysFromNow: null, basis: 'no_due_date', confidence: 0.3, medianLateness: 0, paidCount: 0 };
  }
  const payer = stats.payers.get(payerKey(invoice));
  const hasPayerHistory = payer && payer.paidCount >= 2;
  const lateness = hasPayerHistory ? payer.medianLateness : stats.global.medianLateness || 0;
  const expectedDay = due + lateness;
  const paidCount = hasPayerHistory ? payer.paidCount : 0;
  const confidence = hasPayerHistory ? Math.min(0.92, 0.55 + paidCount * 0.06) : stats.global.paidCount >= 5 ? 0.55 : 0.4;
  return {
    expectedDate: new Date(expectedDay * DAY_MS).toISOString().slice(0, 10),
    expectedDaysFromNow: expectedDay - today,
    basis: hasPayerHistory ? 'payer_median_lateness' : stats.global.paidCount >= 5 ? 'portfolio_median_lateness' : 'due_date',
    confidence,
    medianLateness: lateness,
    paidCount
  };
}

function projectCash(invoices, stats, horizons, { asOf = new Date().toISOString() } = {}) {
  const open = invoices.filter((invoice) => invoice.status === 'SENT');
  const result = {};
  for (const horizon of horizons) {
    const byCurrency = {};
    for (const invoice of open) {
      const forecast = forecastInvoice(invoice, stats, { asOf });
      if (forecast.expectedDaysFromNow === null || forecast.expectedDaysFromNow > horizon) continue;
      byCurrency[invoice.currency] = Math.round(((byCurrency[invoice.currency] || 0) + invoice.total) * 100) / 100;
    }
    result[String(horizon)] = byCurrency;
  }
  return result;
}

/**
 * Backtest a list of settled invoices. The first `trainRatio` of records (sorted
 * by paid date) trains payer stats; the rest are scored.
 */
function backtest(records, { trainRatio = 0.7, horizons = [7, 14, 30] } = {}) {
  const settled = records
    .filter((record) => record.status === 'PAID' && record.dueDate && record.paidAt)
    .sort((a, b) => String(a.paidAt).localeCompare(String(b.paidAt)));
  const split = Math.max(1, Math.floor(settled.length * trainRatio));
  const train = settled.slice(0, split);
  const test = settled.slice(split);
  const stats = buildPayerStats(train);
  const errors = { dueDate: [], globalMedian: [], payerMedian: [] };
  let dueDateHits = 0;
  let globalHits = 0;
  let payerHits = 0;
  const predictions = [];
  for (const record of test) {
    const due = toDay(record.dueDate);
    const actual = toDay(record.paidAt);
    if (due === null || actual === null) continue;
    const payer = stats.payers.get(payerKey(record));
    const payerLate = payer && payer.paidCount >= 2 ? payer.medianLateness : null;
    const globalLate = stats.global.medianLateness || 0;
    const duePrediction = due;
    const globalPrediction = due + globalLate;
    const payerPrediction = due + (payerLate ?? globalLate);
    errors.dueDate.push(Math.abs(duePrediction - actual));
    errors.globalMedian.push(Math.abs(globalPrediction - actual));
    errors.payerMedian.push(Math.abs(payerPrediction - actual));
    if (duePrediction === actual) dueDateHits += 1;
    if (globalPrediction === actual) globalHits += 1;
    if (payerPrediction === actual) payerHits += 1;
    predictions.push({ record, actual, duePrediction, globalPrediction, payerPrediction });
  }
  const mae = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const rmse = (values) => values.length ? Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length) : null;
  const within = (values, days) => values.length ? values.filter((value) => value <= days).length / values.length : 0;
  const horizonResults = {};
  for (const horizon of horizons) {
    const rows = predictions.filter((prediction) => prediction.actual - toDay(prediction.record.updatedAt || prediction.record.paidAt) <= horizon);
    horizonResults[String(horizon)] = {
      sample: rows.length,
      dueDateAccuracy: rows.length ? rows.filter((row) => new Date(row.duePrediction * DAY_MS).toISOString().slice(0, 10) <= String(row.record.paidAt).slice(0, 10)).length / rows.length : 0
    };
  }
  return {
    trainCount: train.length,
    testCount: test.length,
    payerCount: stats.payers.size,
    metrics: {
      dueDate: { mae: mae(errors.dueDate), rmse: rmse(errors.dueDate), within3: within(errors.dueDate, 3), within7: within(errors.dueDate, 7), exact: test.length ? dueDateHits / test.length : 0 },
      globalMedian: { mae: mae(errors.globalMedian), rmse: rmse(errors.globalMedian), within3: within(errors.globalMedian, 3), within7: within(errors.globalMedian, 7), exact: test.length ? globalHits / test.length : 0 },
      payerMedian: { mae: mae(errors.payerMedian), rmse: rmse(errors.payerMedian), within3: within(errors.payerMedian, 3), within7: within(errors.payerMedian, 7), exact: test.length ? payerHits / test.length : 0 }
    },
    horizonResults,
    stats
  };
}

module.exports = { DAY_MS, backtest, buildPayerStats, forecastInvoice, median, payerKey, projectCash, toDay };
