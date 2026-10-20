(() => {
  'use strict';

  const state = { data: null, insights: null, draft: null, items: [], lastFocus: null, loading: false, mode: 'mock', tourFocus: null };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(Number(value || 0));
  const date = (value) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00`)) : 'No due date';
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));

  async function api(path, options = {}) {
    const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || `Request failed (${response.status})`);
    return payload;
  }

  function initials(name) { return String(name || '?').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
  function statusPill(status) {
    const normalized = String(status || 'UNKNOWN').toUpperCase();
    const labels = { SENT: 'Sent', PAID: 'Paid', DRAFT: 'Draft', CANCELLED: 'Cancelled', VOID: 'Void' };
    return `<span class="status-pill status-${escapeHtml(normalized.toLowerCase())}">${escapeHtml(labels[normalized] || normalized)}</span>`;
  }

  function setBanner(message, tone = '') {
    const banner = $('#data-banner');
    banner.className = `data-banner ${tone}`.trim();
    $('#data-banner-text').textContent = message;
  }

  function renderConnection(adapter) {
    const isLive = adapter === 'paypal-sandbox';
    state.mode = isLive ? 'sandbox' : 'mock';
    $('#connection-title').textContent = isLive ? 'PayPal Sandbox' : 'PayPal demo';
    $('#adapter-status').textContent = isLive ? 'Connected · sandbox API' : 'Connected · mock adapter';
    $('#adapter-label').textContent = isLive ? 'SANDBOX API' : 'MOCK · SYNTHETIC DATA';
    $('#mode-chip').innerHTML = `<span class="pulse-dot"></span> ${isLive ? 'SANDBOX MODE' : 'MOCK MODE'}`;
    $('#footer-mode').textContent = isLive ? 'Sandbox mode · PayPal API' : 'Demo mode · synthetic data';
    $('#banner-source').textContent = isLive ? 'Source: PayPal Sandbox' : 'Source: mock adapter';
    $('#tour-mode').innerHTML = `<span class="signal-dot"></span><strong>${isLive ? 'Sandbox provenance:' : 'Demo provenance:'}</strong> ${isLive ? 'Invoice actions use PayPal Sandbox; real webhook verification is available when configured.' : 'Invoices and payment events are synthetic; no production PayPal action is being performed.'}`;
    $('#today-label').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase();
  }

  function renderMetrics(summary = {}) {
    const byStatus = summary.byStatus || {};
    const openCount = Number(byStatus.SENT || 0) + Number(byStatus.DRAFT || 0);
    $('#metric-outstanding').textContent = money(summary.totalOutstanding);
    $('#metric-paid').textContent = money(summary.totalPaid);
    $('#metric-open').textContent = String(openCount);
    $('#metric-outstanding-count').textContent = String(Number(byStatus.SENT || 0));
    $('#nav-invoice-count').textContent = String(summary.invoiceCount || 0);
    const riskCount = (state.insights?.recommendations || []).filter((item) => ['HIGH', 'CRITICAL'].includes(item.risk)).length;
    $('#metric-risk').textContent = `${riskCount} ${riskCount === 1 ? 'needs' : 'need'} attention`;
    const dots = $('#mini-status');
    dots.innerHTML = Array.from({ length: Math.min(Math.max(openCount, 1), 4) }, (_, index) => `<span class="mini-dot ${index < riskCount ? 'amber' : 'blue'}"></span>`).join('');
  }

  function renderInvoices(invoices = []) {
    const rows = $('#invoice-rows');
    if (!invoices.length) {
      rows.innerHTML = `<tr><td colspan="5"><div class="empty-state"><span class="empty-icon">▤</span><strong>No invoices yet</strong><p>Use Copilot to create your first invoice.</p></div></td></tr>`;
      return;
    }
    rows.innerHTML = invoices.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map((invoice, index) => {
      const insight = state.insights?.invoices?.find((item) => item.invoiceId === invoice.id);
      const avatarClass = index % 3 === 1 ? 'purple' : index % 3 === 2 ? 'green' : '';
      return `<tr data-invoice-id="${escapeHtml(invoice.id)}" tabindex="0" aria-label="Open invoice for ${escapeHtml(invoice.customer?.name || 'client')}"><td><div class="client-cell"><span class="client-avatar ${avatarClass}">${escapeHtml(initials(invoice.customer?.name))}</span><div><strong>${escapeHtml(invoice.customer?.name || 'Unnamed client')}</strong><small>${escapeHtml(invoice.customer?.email || 'No email')}</small></div></div></td><td class="amount">${escapeHtml(money(invoice.total, invoice.currency))}</td><td class="due ${insight?.risk === 'CRITICAL' || insight?.risk === 'HIGH' ? 'soon' : ''}">${escapeHtml(date(invoice.dueDate))}</td><td>${statusPill(invoice.status)}</td><td><button class="row-menu" data-row-action="${escapeHtml(invoice.id)}" type="button" aria-label="Open ${escapeHtml(invoice.customer?.name || 'invoice')}">↗</button></td></tr>`;
    }).join('');
    $$('tr[data-invoice-id]', rows).forEach((row) => row.addEventListener('click', (event) => {
      if (event.target.closest('button')) event.stopPropagation();
      openInvoiceDrawer(row.dataset.invoiceId);
    }));
    $$('tr[data-invoice-id]', rows).forEach((row) => row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openInvoiceDrawer(row.dataset.invoiceId); }
    }));
    $$('.row-menu', rows).forEach((button) => button.addEventListener('click', () => openInvoiceDrawer(button.dataset.rowAction)));
  }

  function relativeTime(value) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return 'recently';
    const days = Math.max(0, Math.round((Date.now() - timestamp) / 86400000));
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }

  function eventLabel(type) {
    const labels = { 'INVOICING.INVOICE.PAID': 'Payment received', 'INVOICING.INVOICE.SENT': 'Invoice sent', 'INVOICING.INVOICE.REMINDER_SENT': 'Reminder sent', 'INVOICING.INVOICE.CANCELLED': 'Invoice cancelled', 'INVOICING.INVOICE.VOIDED': 'Invoice voided' };
    return labels[type] || 'Status updated';
  }

  function renderActivity(invoices = []) {
    const events = invoices.flatMap((invoice) => (invoice.events || []).map((event) => ({ ...event, customer: invoice.customer?.name, total: invoice.total, currency: invoice.currency }))).sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 4);
    $('#activity-list').innerHTML = events.length ? events.map((event) => {
      const paid = event.type === 'INVOICING.INVOICE.PAID';
      const reminder = event.type === 'INVOICING.INVOICE.REMINDER_SENT';
      const proof = event.verified ? 'verified webhook' : event.source === 'simulated' ? 'simulated webhook' : event.source === 'paypal' ? 'PayPal event' : 'audit event';
      return `<div class="activity-item"><span class="activity-icon ${paid ? 'green' : reminder ? 'amber' : ''}">${paid ? '✓' : reminder ? '!' : '↗'}</span><div><strong>${escapeHtml(eventLabel(event.type))}</strong><p>${escapeHtml(event.customer || 'Client')} · ${escapeHtml(money(event.total, event.currency))} · ${escapeHtml(proof)}</p></div><span class="activity-time">${escapeHtml(relativeTime(event.at))}</span></div>`;
    }).join('') : `<div class="empty-state compact-empty"><span class="empty-icon">⌁</span><strong>No activity yet</strong><p>Payment events will appear here.</p></div>`;
  }

  function daysUntilDue(dueDate) {
    if (!dueDate) return null;
    return Math.floor((Date.parse(`${dueDate}T00:00:00`) - Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00`)) / 86400000);
  }

  function fallbackInsights(invoices) {
    const insights = invoices.map((invoice) => {
      const days = daysUntilDue(invoice.dueDate);
      let risk = 'LOW'; let urgency = 'LOW'; let priority = 20; let action = 'MONITOR_PAYMENT'; let reason = 'Payment pending';
      if (invoice.status === 'DRAFT') { risk = 'MEDIUM'; urgency = 'HIGH'; priority = 90; action = 'SEND_INVOICE'; reason = 'Draft has not been sent'; }
      else if (invoice.status === 'SENT' && days === null) { risk = 'MEDIUM'; urgency = 'MEDIUM'; priority = 55; action = 'ADD_DUE_DATE'; reason = 'No due date is set'; }
      else if (invoice.status === 'SENT' && days < 0) { risk = days <= -7 ? 'CRITICAL' : 'HIGH'; urgency = risk; priority = risk === 'CRITICAL' ? 100 : 95; action = 'REMIND_INVOICE'; reason = `${Math.abs(days)} days overdue`; }
      else if (invoice.status === 'SENT' && days <= 7) { risk = days <= 3 ? 'HIGH' : 'MEDIUM'; urgency = risk; priority = days <= 3 ? 85 : 65; action = 'REMIND_INVOICE'; reason = `Due in ${days} days`; }
      return { invoiceId: invoice.id, customer: invoice.customer, status: invoice.status, amount: invoice.total, currency: invoice.currency, dueDate: invoice.dueDate, daysUntilDue: days, risk, urgency, confidence: .72, reasonCodes: [reason], nextAction: { type: action, action, priority, invoiceId: invoice.id, reasonCodes: [reason] } };
    });
    const recommendations = insights.slice().sort((a, b) => b.nextAction.priority - a.nextAction.priority);
    const projectedCashPosition = {};
    [7, 14, 30].forEach((horizon) => { projectedCashPosition[String(horizon)] = insights.filter((item) => item.status === 'SENT' && item.daysUntilDue !== null && item.daysUntilDue <= horizon).reduce((totals, item) => ({ ...totals, [item.currency]: (totals[item.currency] || 0) + Number(item.amount || 0) }), {}); });
    return { asOf: new Date().toISOString(), invoices: insights, recommendations, projectedCashPosition, projections: [], nextAction: recommendations[0]?.nextAction || null };
  }

  function reasonText(insight) {
    const codes = insight.reasonCodes || [];
    const map = { OVERDUE_7_PLUS_DAYS: '7+ days overdue', OVERDUE: 'Past the due date', DUE_WITHIN_3_DAYS: 'Due within 3 days', DUE_WITHIN_7_DAYS: 'Due within 7 days', DRAFT_NOT_SENT: 'Draft is waiting to be sent', NO_DUE_DATE: 'Missing a due date', PAYMENT_PENDING: 'Payment is still pending', PAID_IN_FULL: 'Paid in full' };
    return codes.map((code) => map[code] || code.replaceAll('_', ' ').toLowerCase()).find((label) => !label.startsWith('status ')) || 'Payment needs a closer look';
  }

  function actionLabel(insight) {
    const labels = { REMIND_INVOICE: 'Send reminder', SEND_INVOICE: 'Review draft', ADD_DUE_DATE: 'Add due date', MONITOR_PAYMENT: 'Open details' };
    return labels[insight.nextAction?.action] || 'Open details';
  }

  function renderQueue(insights) {
    const list = $('#queue-list');
    const recommendations = insights?.recommendations || [];
    if (!recommendations.length) {
      list.innerHTML = `<div class="empty-state"><span class="empty-icon">✦</span><strong>Nothing needs your attention</strong><p>Copilot will surface the next signal here.</p></div>`;
      return;
    }
    list.innerHTML = recommendations.slice(0, 4).map((insight, index) => {
      const customer = insight.customer?.name || 'Unnamed client';
      const risk = String(insight.risk || 'LOW').toLowerCase();
      const confidence = Math.round(Number(insight.confidence || 0) * 100);
      return `<div class="queue-item" data-invoice-id="${escapeHtml(insight.invoiceId)}" tabindex="0" role="button" aria-label="Open Copilot recommendation for ${escapeHtml(customer)}"><span class="queue-rank ${escapeHtml(risk)}">${String(index + 1).padStart(2, '0')}</span><div class="queue-main"><strong>${escapeHtml(customer)}</strong><div class="queue-reason">${escapeHtml(reasonText(insight))}</div><div class="queue-meta"><span class="risk-label risk-${escapeHtml(risk)}">${escapeHtml(insight.risk || 'LOW')} RISK</span><span class="confidence-tiny">${escapeHtml(confidence)}% confidence</span></div></div><div class="queue-side"><strong>${escapeHtml(money(insight.amount, insight.currency))}</strong><small>${escapeHtml(insight.dueDate ? date(insight.dueDate) : 'No due date')}</small><button class="queue-action" data-queue-action="${escapeHtml(insight.invoiceId)}" type="button">${escapeHtml(actionLabel(insight))} ↗</button></div></div>`;
    }).join('');
    $$('.queue-item', list).forEach((item) => item.addEventListener('click', (event) => {
      const action = event.target.closest('[data-queue-action]');
      if (action) { event.stopPropagation(); if (actionLabel(recommendations.find((item) => item.invoiceId === action.dataset.queueAction)) === 'Send reminder') sendReminder(action.dataset.queueAction); else openInvoiceDrawer(action.dataset.queueAction); return; }
      openInvoiceDrawer(item.dataset.invoiceId);
    }));
    $$('.queue-item', list).forEach((item) => item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openInvoiceDrawer(item.dataset.invoiceId); }
    }));
  }

  function renderForecast(insights) {
    const positions = insights?.projectedCashPosition || {};
    const values = [7, 14, 30].map((horizon) => Number(positions[String(horizon)]?.USD || 0));
    const max = Math.max(...values, 1);
    $('#forecast-bars').innerHTML = values.map((value, index) => `<div class="forecast-bar-group"><div class="forecast-bar" style="height:${Math.max(value ? 10 : 3, Math.round((value / max) * 100))}%"><span>${escapeHtml(money(value))}</span></div></div>`).join('');
    const top = insights?.recommendations?.[0];
    const risk = top?.risk || 'LOW';
    const tone = risk === 'CRITICAL' || risk === 'HIGH' ? 'needs a nudge' : risk === 'MEDIUM' ? 'worth watching' : 'steady';
    $('#forecast-tone').textContent = tone;
    $('#forecast-summary').textContent = values[2] ? `${money(values[2])} is scheduled or expected to arrive within 30 days, based on open invoices.` : 'No dated incoming cash is on the books yet. A clear due date makes the forecast stronger.';
    $('#forecast-action').textContent = top ? `${actionLabel(top)} for ${top.customer?.name || 'your next invoice'}` : 'No action is waiting for approval';
    $('#forecast-action-detail').textContent = top ? `${reasonText(top)} · ${Math.round(Number(top.confidence || 0) * 100)}% Copilot confidence` : 'Your queue is clear for now.';
    $('#forecast-confidence').textContent = `AI SIGNAL · ${top ? Math.round(Number(top.confidence || 0) * 100) : 99}%`;
    const outstanding = Number(state.data?.summary?.totalOutstanding || 0);
    const runway = values[2] ? '30-day view' : outstanding ? 'Receivables only' : 'No open cash';
    $('#runway-value').textContent = runway;
    $('#runway-copy').textContent = values[2] ? 'expected incoming cash' : 'Add due dates to unlock a forecast';
    $('#runway-amount').textContent = money(outstanding);
    $('#runway-progress').style.width = `${Math.min(100, Math.max(8, Math.round((values[2] / Math.max(outstanding + values[2], 1)) * 100)))}%`;
  }

  function renderInsights(insights) { state.insights = insights; renderMetrics(state.data?.summary); renderQueue(insights); renderForecast(insights); renderInvoices(state.data?.invoices || []); }

  async function refreshData({ silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    const refreshButton = $('#refresh-insights');
    refreshButton.disabled = true;
    refreshButton.classList.add('is-busy'); refreshButton.setAttribute('aria-busy', 'true');
    if (!silent) setBanner('Syncing invoices and Copilot signal…');
    try {
      state.data = await api('/api/state');
      renderMetrics(state.data.summary); renderInvoices(state.data.invoices); renderActivity(state.data.invoices); renderConnection(state.data.adapter);
      try {
        const insights = await api('/api/insights');
        renderInsights(insights); setBanner(`Signal refreshed · ${new Date(insights.asOf || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`, '');
      } catch (error) {
        renderInsights(fallbackInsights(state.data.invoices || [])); setBanner('Copilot signal is in offline mode · showing a local risk read', 'fallback');
        if (!silent) showToast(`Insights unavailable — ${error.message}`);
      }
    } catch (error) {
      setBanner(`Could not load your invoices · ${error.message}`, 'error');
      $('#invoice-rows').innerHTML = `<tr><td colspan="5"><div class="empty-state"><span class="empty-icon">!</span><strong>Couldn’t load invoices</strong><p>Check the local server, then retry the signal.</p></div></td></tr>`;
      $('#queue-list').innerHTML = `<div class="empty-state"><span class="empty-icon">!</span><strong>Signal unavailable</strong><p>Retry when the local server is ready.</p></div>`;
    } finally { state.loading = false; refreshButton.disabled = false; refreshButton.classList.remove('is-busy'); refreshButton.removeAttribute('aria-busy'); }
  }

  function openInvoiceDrawer(invoiceId) {
    const invoice = state.data?.invoices?.find((item) => item.id === invoiceId);
    if (!invoice) { showToast('That invoice is no longer available.'); return; }
    state.lastFocus = document.activeElement;
    const insight = state.insights?.invoices?.find((item) => item.invoiceId === invoice.id);
     const events = (invoice.events || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const canRemind = invoice.status === 'SENT';
     $('#drawer-content').innerHTML = `<div class="drawer-summary"><div class="drawer-summary-top"><div><strong>${escapeHtml(money(invoice.total, invoice.currency))}</strong><div class="drawer-customer">${escapeHtml(invoice.customer?.name || 'Unnamed client')}<small>${escapeHtml(invoice.customer?.email || 'No email')}</small></div></div>${statusPill(invoice.status)}</div>${canRemind ? `<div class="drawer-action"><button class="button button-primary" id="drawer-remind" data-invoice-id="${escapeHtml(invoice.id)}" type="button">Send gentle reminder</button></div>` : ''}</div><div class="detail-grid"><div><span>Due date</span><strong>${escapeHtml(date(invoice.dueDate))}</strong></div><div><span>Reminder history</span><strong>${escapeHtml(String(invoice.reminderCount || 0))} sent</strong></div><div><span>Subtotal</span><strong>${escapeHtml(money(invoice.subtotal, invoice.currency))}</strong></div><div><span>Tax</span><strong>${escapeHtml(money(invoice.tax, invoice.currency))}</strong></div></div><h3 class="drawer-section-title">LIFECYCLE TIMELINE</h3><div class="timeline">${events.length ? events.map((event) => { const proof = event.verified ? 'Verified PayPal webhook' : event.source === 'simulated' ? 'Demo-safe simulated webhook' : event.source === 'paypal' ? 'PayPal event' : 'App audit event'; return `<div class="timeline-item ${event.type === 'INVOICING.INVOICE.PAID' ? 'paid' : event.type === 'INVOICING.INVOICE.REMINDER_SENT' ? 'reminder' : ''}"><strong>${escapeHtml(eventLabel(event.type))}</strong><p>${escapeHtml(dateTime(event.at))}${event.eventId ? ` · event ${escapeHtml(event.eventId)}` : ''}</p><small class="timeline-proof">${escapeHtml(proof)}</small></div>`; }).join('') : '<div class="empty-state"><strong>No events recorded</strong><p>This invoice has not entered the PayPal lifecycle yet.</p></div>'}</div><div class="drawer-proof"><span>✓</span><span>Human-approved actions are recorded on this invoice.</span></div>`;
    $('#detail-backdrop').hidden = false; document.body.style.overflow = 'hidden'; $('#close-drawer').focus();
    $('#drawer-remind')?.addEventListener('click', () => sendReminder(invoice.id));
  }

  function dateTime(value) { const parsed = new Date(value); return Number.isNaN(parsed.getTime()) ? 'Time unavailable' : parsed.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }); }
  function closeDrawer() { $('#detail-backdrop').hidden = true; document.body.style.overflow = ''; state.lastFocus?.focus?.(); }

  function openTour() { state.tourFocus = document.activeElement; $('#tour-backdrop').hidden = false; document.body.style.overflow = 'hidden'; $('#close-tour').focus(); }
  function closeTour() { $('#tour-backdrop').hidden = true; document.body.style.overflow = ''; state.tourFocus?.focus?.(); }
  function trapFocus(container, event) {
    const focusable = $$('button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])', container).filter((element) => element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  async function sendReminder(invoiceId) {
    const invoice = state.data?.invoices?.find((item) => item.id === invoiceId);
    if (!invoice || invoice.status !== 'SENT') { showToast('Only sent invoices can receive a reminder.'); return; }
    if (!window.confirm(`Send a gentle reminder to ${invoice.customer?.name || 'this client'} for ${money(invoice.total, invoice.currency)}?`)) return;
    const button = $('#drawer-remind'); if (button) { button.disabled = true; button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true'); button.textContent = 'Sending…'; }
    try { await api(`/api/invoices/${encodeURIComponent(invoiceId)}/remind`, { method: 'POST', body: '{}' }); await refreshData({ silent: true }); openInvoiceDrawer(invoiceId); showToast(state.mode === 'sandbox' ? 'Reminder sent through PayPal Sandbox and added to the audit trail.' : 'Reminder recorded through the mock adapter and added to the audit trail.'); }
    catch (error) { if (button) { button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); button.textContent = 'Send gentle reminder'; } showToast(`Reminder could not be sent · ${error.message}`); }
  }

  function openModal(draft) {
    state.draft = draft; state.items = (draft.items || []).map((item) => ({ ...item })); state.lastFocus = document.activeElement;
    const form = $('#invoice-form'); form.customerName.value = draft.customer?.name || ''; form.customerEmail.value = draft.customer?.email || ''; form.dueDate.value = draft.dueDate || ''; form.taxRate.value = draft.taxRate ?? 0; form.notes.value = draft.notes || '';
    $('#extraction-summary').textContent = `I found ${state.items.length} line item${state.items.length === 1 ? '' : 's'} for ${draft.customer?.name || 'your customer'} and calculated ${money(draft.total)}.`;
    renderFormItems(); $('#modal-backdrop').hidden = false; document.body.style.overflow = 'hidden'; setTimeout(() => form.customerName.focus(), 0);
  }
  function closeModal() { $('#modal-backdrop').hidden = true; document.body.style.overflow = ''; state.lastFocus?.focus?.(); }
  function renderFormItems() {
    $('#form-items').innerHTML = state.items.map((item, index) => `<div class="item-row" data-item-index="${index}"><label>Description<input data-field="description" value="${escapeHtml(item.description)}" required></label><label>Qty<input data-field="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity)}" required></label><label>Unit price<input data-field="unitPrice" type="number" min="0" step="0.01" value="${escapeHtml(item.unitPrice)}" required></label><label>Amount<input value="${escapeHtml(money(Number(item.quantity) * Number(item.unitPrice)))}" disabled></label><button type="button" class="remove-item" data-remove-item="${index}" aria-label="Remove line ${index + 1}">×</button></div>`).join('');
    $$('#form-items input[data-field]').forEach((input) => input.addEventListener('input', (event) => { const item = state.items[Number(event.target.closest('[data-item-index]').dataset.itemIndex)]; item[event.target.dataset.field] = event.target.dataset.field === 'description' ? event.target.value : Number(event.target.value); updateFormTotals(); }));
    $$('[data-remove-item]').forEach((button) => button.addEventListener('click', () => { state.items.splice(Number(button.dataset.removeItem), 1); renderFormItems(); })); updateFormTotals();
  }
  function updateFormTotals() { const subtotal = state.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0); const tax = subtotal * (Number($('#invoice-form').taxRate.value || 0) / 100); $('#form-subtotal').textContent = money(subtotal); $('#form-tax').textContent = money(tax); $('#form-total').textContent = money(subtotal + tax); $$('#form-items .item-row').forEach((row, index) => { const amount = row.querySelector('input[disabled]'); if (amount) amount.value = money(Number(state.items[index]?.quantity || 0) * Number(state.items[index]?.unitPrice || 0)); }); }

  async function parsePrompt(text) { if (!text.trim()) { showToast('Tell me what needs to get paid first.'); return; } const button = $('#parse-button'); button.disabled = true; button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true'); button.textContent = 'Drafting…'; try { const result = await api('/api/parse-invoice', { method: 'POST', body: JSON.stringify({ text }) }); openModal(result.invoice); } catch (error) { showToast(`Couldn’t draft invoice · ${error.message}`); } finally { button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); button.textContent = '↗'; } }
  async function submitDraft(event) { event.preventDefault(); const form = event.currentTarget; const payload = { customer: { name: form.customerName.value.trim(), email: form.customerEmail.value.trim() }, dueDate: form.dueDate.value || null, taxRate: Number(form.taxRate.value || 0), items: state.items.map((item) => ({ description: String(item.description || '').trim(), quantity: Number(item.quantity), unitPrice: Number(item.unitPrice) })), notes: form.notes.value.trim() || null }; const submit = form.querySelector('button[type="submit"]'); submit.disabled = true; submit.classList.add('is-busy'); submit.setAttribute('aria-busy', 'true'); submit.textContent = 'Sending…'; try { const created = await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) }); await api(`/api/invoices/${encodeURIComponent(created.invoice.id)}/send`, { method: 'POST', body: '{}' }); closeModal(); await refreshData({ silent: true }); showToast(state.mode === 'sandbox' ? 'Invoice approved and sent through PayPal Sandbox.' : 'Invoice approved and sent through the mock adapter.'); } catch (error) { showToast(`Couldn’t send invoice · ${error.message}`); } finally { submit.disabled = false; submit.classList.remove('is-busy'); submit.removeAttribute('aria-busy'); submit.innerHTML = '<span>✓</span> Approve &amp; send with PayPal'; } }

  async function simulatePaid() { const invoice = state.data?.invoices?.find((item) => item.status === 'SENT'); if (!invoice) { showToast('No sent invoice is waiting for a payment event.'); return; } const button = $('#simulate-button'); button.disabled = true; button.classList.add('is-busy'); try { await api('/api/webhooks/simulate', { method: 'POST', body: JSON.stringify({ eventType: 'INVOICING.INVOICE.PAID', invoiceId: invoice.id }) }); await refreshData({ silent: true }); showToast(`${invoice.customer?.name || 'Client'} paid ${money(invoice.total, invoice.currency)} — simulated webhook recorded.`); } catch (error) { showToast(`Demo webhook failed · ${error.message}`); } finally { button.disabled = false; button.classList.remove('is-busy'); } }
  function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 4000); }

  $('#open-draft').addEventListener('click', () => { $('#prompt-input').focus(); $('#copilot').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('#parse-button').addEventListener('click', () => parsePrompt($('#prompt-input').value));
  $('#prompt-input').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') parsePrompt(event.target.value); });
  $$('.suggestion').forEach((suggestion) => suggestion.addEventListener('click', () => { $('#prompt-input').value = suggestion.dataset.prompt; $('#prompt-input').focus(); }));
  $('#close-modal').addEventListener('click', closeModal); $('#cancel-modal').addEventListener('click', closeModal); $('#close-drawer').addEventListener('click', closeDrawer); $('#detail-backdrop').addEventListener('click', (event) => { if (event.target.id === 'detail-backdrop') closeDrawer(); }); $('#modal-backdrop').addEventListener('click', (event) => { if (event.target.id === 'modal-backdrop') closeModal(); }); $('#open-tour').addEventListener('click', (event) => { event.preventDefault(); openTour(); }); $('#open-tour-inline').addEventListener('click', openTour); $('#close-tour').addEventListener('click', closeTour); $('#close-tour-cta').addEventListener('click', closeTour); $('#tour-backdrop').addEventListener('click', (event) => { if (event.target.id === 'tour-backdrop') closeTour(); });
  $('#invoice-form').addEventListener('submit', submitDraft); $('#invoice-form').taxRate.addEventListener('input', updateFormTotals); $('#add-item').addEventListener('click', () => { state.items.push({ description: 'New service', quantity: 1, unitPrice: 0 }); renderFormItems(); }); $('#simulate-button').addEventListener('click', simulatePaid); $('#refresh-insights').addEventListener('click', () => refreshData()); $('#view-all').addEventListener('click', () => $('#invoices').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape') { if (!$('#tour-backdrop').hidden) closeTour(); else if (!$('#modal-backdrop').hidden) closeModal(); else if (!$('#detail-backdrop').hidden) closeDrawer(); } if (event.key === 'Tab') { if (!$('#tour-backdrop').hidden) trapFocus($('#tour-panel'), event); else if (!$('#modal-backdrop').hidden) trapFocus($('.draft-modal'), event); else if (!$('#detail-backdrop').hidden) trapFocus($('#invoice-drawer'), event); } });
  refreshData();
})();
