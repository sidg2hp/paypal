'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { backtest, buildPayerStats, forecastInvoice, projectCash } = require('../src/forecast');

function addDays(iso, days) {
  const date = new Date(`${iso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function settledInvoice(id, email, dueDate, lateness, amount = 100) {
  return { id, customer: { name: email.split('@')[0], email }, status: 'PAID', dueDate, paidAt: `${addDays(dueDate, lateness)}T12:00:00.000Z`, updatedAt: `${addDays(dueDate, lateness)}T12:00:00.000Z`, total: amount, currency: 'USD' };
}

function syntheticLedger() {
  const invoices = [];
  const behaviours = [0, 4, 8, 12, 16, 20];
  behaviours.forEach((lateness, payerIndex) => {
    for (let month = 0; month < 12; month += 1) {
      const dueDate = addDays('2026-01-05', month * 28 + payerIndex);
      invoices.push(settledInvoice(`p${payerIndex}-m${month}`, `payer${payerIndex}@example.com`, dueDate, lateness, 100 + payerIndex * 10));
    }
  });
  return invoices;
}

test('payer stats use median lateness and ignore unsettled invoices', () => {
  const stats = buildPayerStats([
    settledInvoice('a', 'steady@example.com', '2026-01-01', 2),
    settledInvoice('b', 'steady@example.com', '2026-02-01', 4),
    settledInvoice('c', 'steady@example.com', '2026-03-01', 90),
    { id: 'd', customer: { email: 'steady@example.com' }, status: 'SENT', dueDate: '2026-01-01', total: 100 }
  ]);
  assert.equal(stats.payers.get('steady@example.com').paidCount, 3);
  assert.equal(stats.payers.get('steady@example.com').medianLateness, 4);
  assert.equal(stats.global.paidCount, 3);
});

test('forecastInvoice uses payer history when there are at least two settled invoices', () => {
  const stats = buildPayerStats([
    settledInvoice('a', 'late@example.com', '2026-01-01', 10),
    settledInvoice('b', 'late@example.com', '2026-02-01', 10),
    settledInvoice('c', 'fast@example.com', '2026-01-01', 0),
    settledInvoice('d', 'fast@example.com', '2026-02-01', 0)
  ]);
  const lateInvoice = { customer: { email: 'late@example.com' }, dueDate: '2026-03-01', status: 'SENT', total: 100, currency: 'USD' };
  const fastInvoice = { customer: { email: 'fast@example.com' }, dueDate: '2026-03-01', status: 'SENT', total: 100, currency: 'USD' };
  const late = forecastInvoice(lateInvoice, stats, { asOf: '2026-03-01T12:00:00.000Z' });
  const fast = forecastInvoice(fastInvoice, stats, { asOf: '2026-03-01T12:00:00.000Z' });
  assert.equal(late.expectedDate, '2026-03-11');
  assert.equal(fast.expectedDate, '2026-03-01');
  assert.equal(late.basis, 'payer_median_lateness');
  assert.equal(late.confidence > 0.6, true);
  assert.equal(forecastInvoice({ customer: {}, dueDate: null, status: 'SENT' }, stats).basis, 'no_due_date');
});

test('projectCash only includes open invoices inside the horizon', () => {
  const stats = buildPayerStats([]);
  const invoices = [
    { customer: { email: 'a@example.com' }, status: 'SENT', dueDate: '2026-03-05', total: 100, currency: 'USD' },
    { customer: { email: 'b@example.com' }, status: 'SENT', dueDate: '2026-03-20', total: 200, currency: 'USD' },
    { customer: { email: 'c@example.com' }, status: 'DRAFT', dueDate: '2026-03-05', total: 400, currency: 'USD' }
  ];
  const projections = projectCash(invoices, stats, [7, 14, 30], { asOf: '2026-03-01T12:00:00.000Z' });
  assert.equal(projections['7'].USD, 100);
  assert.equal(projections['14'].USD, 100);
  assert.equal(projections['30'].USD, 300);
});

test('backtest shows payer-aware forecasting beats a due-date baseline', () => {
  const ledger = syntheticLedger();
  const result = backtest(ledger, { trainRatio: 0.7 });
  assert.ok(result.trainCount > 0);
  assert.ok(result.testCount > 0);
  assert.equal(result.payerCount, 6);
  assert.ok(result.metrics.payerMedian.mae < result.metrics.dueDate.mae);
  assert.ok(result.metrics.payerMedian.mae <= result.metrics.globalMedian.mae);
  assert.ok(result.metrics.payerMedian.within7 >= result.metrics.dueDate.within7);
  assert.equal(Number.isFinite(result.metrics.payerMedian.mae), true);
  assert.ok(result.metrics.payerMedian.exact >= result.metrics.dueDate.exact);
});
