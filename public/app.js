(() => {
  'use strict';

  const state = {
    data: null,
    insights: null,
    audit: null,
    meta: null,
    draft: null,
    items: [],
    lastFocus: null,
    loading: false,
    mode: 'mock',
    tourFocus: null,
    chatBusy: false,
    ledgerApi: null,
    plans: new Map()
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const money = (value, currency = 'USD') => {
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0));
    } catch {
      return `${currency} ${Number(value || 0).toFixed(2)}`;
    }
  };
  const date = (value) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00`)) : 'No due date';
  const dateShort = (value) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(`${value}T00:00:00`)) : '—';
  const dateTime = (value) => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'Time unavailable' : parsed.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  };
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const initials = (name) => String(name || '?').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();

  async function api(path, options = {}) {
    const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || `Request failed (${response.status})`;
      const debugId = payload.error?.details?.debugId;
      throw new Error(debugId ? `${message} [PayPal debug ${debugId}]` : message);
    }
    return payload;
  }

  function statusPill(status) {
    const normalized = String(status || 'UNKNOWN').toUpperCase();
    const labels = { SENT: 'Sent', PAID: 'Paid', DRAFT: 'Draft', CANCELLED: 'Cancelled', VOID: 'Void', REFUNDED: 'Refunded' };
    return `<span class="status-pill status-${escapeHtml(normalized.toLowerCase())}">${escapeHtml(labels[normalized] || normalized)}</span>`;
  }

  function setBanner(message, tone = '') {
    $('#data-banner').className = `data-banner ${tone}`.trim();
    $('#data-banner-text').textContent = message;
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove('show'), 4200);
  }

  function renderConnection(meta) {
    const isLive = meta?.mode === 'sandbox';
    state.mode = isLive ? 'sandbox' : 'mock';
    state.meta = meta || state.meta;
    $('#connection-title').textContent = isLive ? 'PayPal Sandbox' : 'PayPal demo';
    $('#adapter-status').textContent = isLive ? 'Connected · sandbox API' : 'Connected · mock adapter';
    $('#adapter-label').textContent = isLive ? 'SANDBOX API' : 'MOCK · SYNTHETIC DATA';
    $('#mode-chip').innerHTML = `<span class="pulse-dot"></span> ${isLive ? 'SANDBOX MODE' : 'MOCK MODE'}`;
    $('#footer-mode').textContent = isLive ? 'Sandbox mode · PayPal API' : 'Demo mode · synthetic data';
    $('#banner-source').textContent = isLive ? 'Source: PayPal Sandbox' : 'Source: mock adapter';
    $('#activity-mode').textContent = isLive ? 'SANDBOX FEED' : 'DEMO FEED';
    $('#tour-mode').innerHTML = `<span class="signal-dot"></span><strong>${isLive ? 'Sandbox provenance:' : 'Demo provenance:'}</strong> ${isLive ? 'Invoice and checkout actions use PayPal Sandbox; webhook signatures are verified by PayPal before state changes.' : 'Invoices, checkout, and payment events are synthetic; no production PayPal action is performed.'}`;
    $('#today-label').textContent = new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date()).toUpperCase();
    const ai = meta?.ai;
    if (ai) {
      const label = ai.selectedProvider === 'deterministic' ? 'Rules fallback' : `${ai.selectedProvider}${ai.model ? ` · ${ai.model}` : ''}`;
      $('#provider-status').textContent = `AI planner: ${label}`;
      $('#provider-detail').textContent = ai.fallback && ai.reason ? ai.reason : 'Provider provenance is attached to every plan and draft.';
    }
  }

  function renderMetrics() {
    const summary = state.data?.summary || {};
    $('#metric-outstanding').textContent = money(summary.totalOutstanding);
    $('#metric-paid').textContent = money(summary.totalPaid);
    $('#metric-expected').textContent = money(summary.projected30);
    $('#metric-outstanding-count').textContent = String(summary.sentCount ?? summary.openCount ?? 0);
    $('#nav-invoice-count').textContent = String(summary.invoiceCount ?? 0);
    $('#metric-risk').textContent = money(summary.overdueTotal);
    $('#metric-risk-count').textContent = `${summary.overdueCount ?? 0} overdue`;
    const health = Number(summary.healthScore ?? 0);
    $('#health-chip').className = `health-pill ${health >= 80 ? 'good' : health >= 60 ? 'watch' : 'risk'}`;
    $('#health-label').textContent = `${health}/100 · ${summary.healthLabel || '—'}`;
    $('#health-note').textContent = `${summary.overdueCount || 0} overdue · ${summary.draftCount || 0} draft · ${summary.dueWithin7Count || 0} due in 7 days`;
    const riskWidth = summary.outstandingTotal ? Math.min(100, Math.round(((summary.overdueTotal || 0) / summary.outstandingTotal) * 100)) : 0;
    $('#risk-bar').style.width = `${Math.max(2, riskWidth)}%`;
    const expectedRatio = summary.outstandingTotal ? Math.min(1, (summary.projected30 || 0) / summary.outstandingTotal) : 0;
    $('#expected-bar').style.width = `${Math.max(4, Math.round(expectedRatio * 100))}%`;
    const open = Number(summary.openCount || 0);
    const risk = Number(summary.overdueCount || 0);
    $('#mini-status').innerHTML = Array.from({ length: Math.min(Math.max(open, 1), 4) }, (_, index) => `<span class="mini-dot ${index < risk ? 'amber' : 'blue'}"></span>`).join('');
  }

  function renderInvoices() {
    const invoices = state.data?.invoices || [];
    const rows = invoices.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map((invoice, index) => {
      const insight = state.insights?.invoices?.find((item) => item.invoiceId === invoice.id);
      const avatarClass = index % 3 === 1 ? 'purple' : index % 3 === 2 ? 'green' : '';
      return `<tr data-invoice-id="${escapeHtml(invoice.id)}" tabindex="0" aria-label="Open invoice for ${escapeHtml(invoice.customer?.name || 'client')}"><td><div class="client-cell"><span class="client-avatar ${avatarClass}">${escapeHtml(initials(invoice.customer?.name))}</span><div><strong>${escapeHtml(invoice.customer?.name || 'Unnamed client')}</strong><small>${escapeHtml(invoice.customer?.email || 'No email')}</small></div></div></td><td class="amount">${escapeHtml(money(invoice.total, invoice.currency))}</td><td class="due ${insight?.risk === 'CRITICAL' || insight?.risk === 'HIGH' ? 'soon' : ''}">${escapeHtml(date(invoice.dueDate))}</td><td>${statusPill(invoice.status)}</td><td><button class="row-menu" data-row-action="${escapeHtml(invoice.id)}" type="button" aria-label="Open ${escapeHtml(invoice.customer?.name || 'invoice')}">↗</button></td></tr>`;
    }).join('');
    $('#invoice-rows-compact').innerHTML = rows || `<tr><td colspan="5"><div class="empty-state"><span class="empty-icon">▤</span><strong>No invoices yet</strong><p>Use Copilot to create your first invoice.</p></div></td></tr>`;
    $$('tr[data-invoice-id]', $('#invoice-rows-compact')).forEach((row) => {
      row.addEventListener('click', (event) => { if (!event.target.closest('button')) openInvoiceDrawer(row.dataset.invoiceId); });
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openInvoiceDrawer(row.dataset.invoiceId); } });
    });
    $$('.row-menu', $('#invoice-rows-compact')).forEach((button) => button.addEventListener('click', () => openInvoiceDrawer(button.dataset.rowAction)));
  }

  function ledgerRows() {
    const invoices = state.data?.invoices || [];
    return invoices.map((invoice) => {
      const insight = state.insights?.invoices?.find((item) => item.invoiceId === invoice.id);
      return {
        id: invoice.id,
        customer: invoice.customer?.name || 'Unnamed client',
        email: invoice.customer?.email || '',
        total: invoice.total,
        currency: invoice.currency,
        dueDate: invoice.dueDate,
        expectedDate: insight?.expectedPaymentDate || null,
        risk: insight?.risk || 'LOW',
        daysOverdue: insight?.daysOverdue || 0,
        status: invoice.status,
        action: insight?.nextAction?.action || 'NO_ACTION',
        reminderCount: invoice.reminderCount || 0
      };
    });
  }

  function statusCell(params) {
    const span = document.createElement('span');
    const labels = { SENT: 'Sent', PAID: 'Paid', DRAFT: 'Draft', CANCELLED: 'Cancelled', VOID: 'Void', REFUNDED: 'Refunded' };
    span.className = `status-pill status-${String(params.value || '').toLowerCase()}`;
    span.textContent = labels[String(params.value || '').toUpperCase()] || params.value;
    return span;
  }

  function riskCell(params) {
    const span = document.createElement('span');
    span.className = `risk-label risk-${String(params.value || 'low').toLowerCase()}`;
    span.textContent = `${params.value} RISK`;
    return span;
  }

  function initLedger() {
    const container = $('#ledger-grid');
    if (!container || !window.agGrid) { $('#ledger-fallback').hidden = false; return false; }
    container.classList.add('ag-theme-quartz');
    const base = {
      rowData: [],
      getRowId: (params) => params.data.id,
      headerHeight: 38,
      rowHeight: 46,
      defaultColDef: { sortable: true, resizable: true, suppressHeaderMenuButton: true },
      columnDefs: [
        { field: 'customer', headerName: 'Client', flex: 1, minWidth: 150, cellRenderer: (params) => {
          const wrap = document.createElement('div');
          wrap.className = 'ledger-client';
          const avatar = document.createElement('span');
          avatar.className = 'client-avatar';
          avatar.textContent = initials(params.value);
          const text = document.createElement('span');
          const strong = document.createElement('strong');
          strong.textContent = params.value;
          const small = document.createElement('small');
          small.textContent = params.data.email;
          text.appendChild(strong); text.appendChild(small);
          wrap.appendChild(avatar); wrap.appendChild(text);
          return wrap;
        } },
        { field: 'total', headerName: 'Amount', width: 112, type: 'rightAligned', valueFormatter: (params) => money(params.value, params.data.currency) },
        { field: 'dueDate', headerName: 'Due', width: 92, valueFormatter: (params) => dateShort(params.value), tooltipValueGetter: (params) => params.value ? date(params.value) : '' },
        { field: 'expectedDate', headerName: 'Expected', width: 100, valueFormatter: (params) => dateShort(params.value), tooltipValueGetter: (params) => params.value ? date(params.value) : '' },
        { field: 'risk', headerName: 'Risk', width: 112, cellRenderer: riskCell },
        { field: 'status', headerName: 'Status', width: 102, cellRenderer: statusCell }
      ],
      onRowClicked: (params) => openInvoiceDrawer(params.data.id)
    };
    try {
      state.ledgerApi = window.agGrid.createGrid(container, { ...base, theme: 'legacy' });
    } catch {
      try {
        state.ledgerApi = window.agGrid.createGrid(container, base);
      } catch {
        $('#ledger-fallback').hidden = false;
        return false;
      }
    }
    return true;
  }

  function renderLedger() {
    const rows = ledgerRows();
    if (!state.ledgerApi) { initLedger(); }
    if (state.ledgerApi) {
      state.ledgerApi.setGridOption('rowData', rows);
      const container = $('#ledger-grid');
      if (container) container.style.height = `${Math.max(190, Math.min(430, 92 + rows.length * 46))}px`;
      $('#ledger-fallback').hidden = true;
    } else {
      const fallback = $('#invoice-rows');
      fallback.innerHTML = rows.map((row) => `<tr data-ledger-id="${escapeHtml(row.id)}"><td>${escapeHtml(row.customer)}</td><td>${escapeHtml(money(row.total, row.currency))}</td><td>${escapeHtml(row.dueDate ? date(row.dueDate) : '—')}</td><td>${escapeHtml(row.expectedDate ? date(row.expectedDate) : '—')}</td><td><span class="risk-label risk-${escapeHtml(row.risk.toLowerCase())}">${escapeHtml(row.risk)}</span></td><td>${statusPill(row.status)}</td></tr>`).join('') || '<tr><td colspan="6">No invoices yet.</td></tr>';
      $$('tr[data-ledger-id]').forEach((row) => row.addEventListener('click', () => openInvoiceDrawer(row.dataset.ledgerId)));
    }
  }

  function relativeTime(value) {
    const timestamp = new Date(value).getTime();
    if (!Number.isFinite(timestamp)) return 'recently';
    const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60000));
    if (minutes < 60) return minutes <= 1 ? 'just now' : `${minutes}m ago`;
    const days = Math.round(minutes / 1440);
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }

  function eventLabel(type) {
    const labels = { 'INVOICING.INVOICE.PAID': 'Payment received', 'INVOICING.INVOICE.SENT': 'Invoice sent', 'INVOICING.INVOICE.REMINDER_SENT': 'Reminder sent', 'INVOICING.INVOICE.CANCELLED': 'Invoice cancelled', 'INVOICING.INVOICE.VOIDED': 'Invoice voided', 'INVOICING.INVOICE.REFUNDED': 'Invoice refunded', 'CHECKOUT.ORDER.CREATED': 'Checkout order created', 'PAYMENT.CAPTURE.COMPLETED': 'PayPal capture completed' };
    return labels[type] || 'Status updated';
  }

  function renderActivity() {
    const invoices = state.data?.invoices || [];
    const events = invoices.flatMap((invoice) => (invoice.events || []).map((event) => ({ ...event, customer: invoice.customer?.name, total: invoice.total, currency: invoice.currency }))).sort((a, b) => String(b.at || '').localeCompare(String(a.at || ''))).slice(0, 5);
    $('#activity-list').innerHTML = events.length ? events.map((event) => {
      const paid = event.type === 'PAYMENT.CAPTURE.COMPLETED' || event.type === 'INVOICING.INVOICE.PAID';
      const reminder = event.type === 'INVOICING.INVOICE.REMINDER_SENT';
      const proof = event.source === 'seed' ? 'seed data' : event.verified ? 'verified PayPal webhook' : event.source === 'simulated' ? 'simulated webhook' : event.source === 'paypal' ? 'PayPal event' : 'app audit event';
      return `<div class="activity-item"><span class="activity-icon ${paid ? 'green' : reminder ? 'amber' : ''}">${paid ? '✓' : reminder ? '!' : '↗'}</span><div><strong>${escapeHtml(eventLabel(event.type))}</strong><p>${escapeHtml(event.customer || 'Client')} · ${escapeHtml(money(event.total, event.currency))} · ${escapeHtml(proof)}</p></div><span class="activity-time">${escapeHtml(relativeTime(event.at))}</span></div>`;
    }).join('') : `<div class="empty-state compact-empty"><span class="empty-icon">⌁</span><strong>No activity yet</strong><p>Payment events will appear here.</p></div>`;
  }

  function reasonText(insight) {
    const codes = insight.reasonCodes || [];
    const map = { OVERDUE_7_PLUS_DAYS: '7+ days overdue', OVERDUE: 'Past the due date', DUE_WITHIN_3_DAYS: 'Due within 3 days', DUE_WITHIN_7_DAYS: 'Due within 7 days', DRAFT_NOT_SENT: 'Draft waiting to be sent', NO_DUE_DATE: 'Missing a due date', PAYMENT_PENDING: 'Payment still pending', PAID_IN_FULL: 'Paid in full', REMINDER_LIMIT_REACHED: 'Policy: escalate', COOLDOWN_ACTIVE: 'Policy: cooldown', NOT_OVERDUE_ENOUGH: 'Policy: waiting', BELOW_MIN_AMOUNT: 'Policy: below minimum', SEND_LIMIT_EXCEEDED: 'Policy: send limit' };
    return codes.map((code) => map[code] || code.replaceAll('_', ' ').toLowerCase()).find((label) => !label.startsWith('status ')) || 'Payment needs a closer look';
  }

  function actionLabel(insight) {
    const labels = { REMIND_INVOICE: 'Send reminder', SEND_INVOICE: 'Review draft', ADD_DUE_DATE: 'Add due date', MONITOR_PAYMENT: 'Open details', ESCALATE: 'Escalate', REVIEW_POLICY: 'Policy hold', REVIEW_LIMIT: 'Review limit' };
    return labels[insight.nextAction?.action] || 'Open details';
  }

  function renderQueue() {
    const list = $('#queue-list');
    const recommendations = state.insights?.recommendations || [];
    if (!recommendations.length) {
      list.innerHTML = `<div class="empty-state"><span class="empty-icon">✦</span><strong>Nothing needs your attention</strong><p>Copilot will surface the next signal here.</p></div>`;
      return;
    }
    list.innerHTML = recommendations.slice(0, 4).map((insight, index) => {
      const customer = insight.customer?.name || 'Unnamed client';
      const risk = String(insight.risk || 'LOW').toLowerCase();
      const confidence = Math.round(Number(insight.confidence || 0) * 100);
      const expected = insight.expectedPaymentDate ? date(insight.expectedPaymentDate) : 'No forecast';
      const policy = insight.policy?.reminder
        ? (insight.policy.reminder.allowed
          ? '<span class="policy-chip ok">POLICY · ALLOW</span>'
          : `<span class="policy-chip" title="${escapeHtml(insight.policy.reminder.message || '')}">POLICY · ${escapeHtml(insight.policy.reminder.decision)}</span>`)
        : '';
      return `<div class="queue-item" data-invoice-id="${escapeHtml(insight.invoiceId)}" tabindex="0" role="button" aria-label="Open Copilot recommendation for ${escapeHtml(customer)}"><span class="queue-rank ${escapeHtml(risk)}">${String(index + 1).padStart(2, '0')}</span><div class="queue-main"><strong>${escapeHtml(customer)}</strong><div class="queue-reason">${escapeHtml(reasonText(insight))}</div><div class="queue-meta"><span class="risk-label risk-${escapeHtml(risk)}">${escapeHtml(insight.risk || 'LOW')} RISK</span><span class="confidence-tiny">${escapeHtml(confidence)}% confidence</span>${policy}</div></div><div class="queue-side"><strong>${escapeHtml(money(insight.amount, insight.currency))}</strong><small>${escapeHtml(insight.dueDate ? date(insight.dueDate) : 'No due date')}</small><small class="queue-expected">Expected ${escapeHtml(expected)}</small><button class="queue-action" data-queue-action="${escapeHtml(insight.invoiceId)}" type="button">${escapeHtml(actionLabel(insight))} ↗</button></div></div>`;
    }).join('');
    $$('.queue-item', list).forEach((item) => {
      item.addEventListener('click', (event) => {
        const action = event.target.closest('[data-queue-action]');
        if (action) {
          event.stopPropagation();
          const insight = recommendations.find((entry) => entry.invoiceId === action.dataset.queueAction);
          if (insight?.nextAction?.action === 'REMIND_INVOICE') sendReminder(action.dataset.queueAction);
          else openInvoiceDrawer(action.dataset.queueAction);
          return;
        }
        openInvoiceDrawer(item.dataset.invoiceId);
      });
      item.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openInvoiceDrawer(item.dataset.invoiceId); }
      });
    });
  }

  function renderForecast() {
    const insights = state.insights;
    const positions = insights?.expectedCashPosition || insights?.projectedCashPosition || {};
    const values = [7, 14, 30].map((horizon) => Number(positions[String(horizon)]?.USD || 0));
    const max = Math.max(...values, 1);
    const bars = $('#forecast-bars');
    bars.innerHTML = values.map((value) => `<div class="forecast-bar-group"><div class="forecast-bar" data-height="${Math.max(value ? 10 : 3, Math.round((value / max) * 100))}"></div></div>`).join('');
    $$('.forecast-bar', bars).forEach((bar) => { bar.style.height = `${bar.dataset.height}%`; });
    $('#forecast-values').innerHTML = values.map((value) => `<span>${escapeHtml(money(value))}</span>`).join('');
    const top = insights?.recommendations?.[0];
    const risk = top?.risk || 'LOW';
    const tone = risk === 'CRITICAL' || risk === 'HIGH' ? 'needs a nudge' : risk === 'MEDIUM' ? 'worth watching' : 'steady';
    $('#forecast-tone').textContent = tone;
    $('#forecast-summary').textContent = values[2] ? `${money(values[2])} is expected within 30 days after adjusting each open invoice by that payer's median lateness.` : 'No dated incoming cash is on the books yet. A clear due date makes the forecast stronger.';
    $('#forecast-action').textContent = top ? `${actionLabel(top)} for ${top.customer?.name || 'your next invoice'}` : 'No action is waiting for approval';
    $('#forecast-action-detail').textContent = top ? `${reasonText(top)} · ${Math.round(Number(top.confidence || 0) * 100)}% Copilot confidence${top.policy?.reminder ? ` · ${top.policy.reminder.ruleId}` : ''}` : 'Your queue is clear for now.';
    $('#forecast-confidence').textContent = `AI SIGNAL · ${top ? Math.round(Number(top.confidence || 0) * 100) : 99}%`;
    const outstanding = Number(state.data?.summary?.totalOutstanding || 0);
    $('#runway-value').textContent = values[2] ? '30-day view' : outstanding ? 'Receivables only' : 'No open cash';
    $('#runway-copy').textContent = values[2] ? 'payer-adjusted expected incoming cash' : 'Add due dates to unlock a forecast';
    $('#runway-amount').textContent = money(outstanding);
    $('#runway-progress').style.width = `${Math.min(100, Math.max(8, Math.round((values[2] / Math.max(outstanding + values[2], 1)) * 100)))}%`;
    const global = insights?.payerStats?.global;
    const payerCount = insights?.payerStats?.payers?.length || 0;
    $('#forecast-status').textContent = global?.paidCount ? `Forecast basis: ${payerCount} payer${payerCount === 1 ? '' : 's'}, ${global.paidCount} settled invoice${global.paidCount === 1 ? '' : 's'}` : 'Forecast basis: due date (no settled history yet)';
    $('#forecast-detail').textContent = global?.paidCount ? `Median payer lateness ${Math.round(global.medianLateness || 0)} days.` : 'Settle an invoice to unlock payer-aware expectations.';
  }

  function renderEvidence() {
    const audit = state.audit;
    if (audit) {
      $('#audit-status').textContent = audit.valid ? `Audit chain: verified (${audit.checkedEvents} events)` : `Audit chain: BROKEN at event ${audit.failures?.[0]?.brokenAt ?? '?'}`;
      $('#audit-detail').textContent = audit.valid ? 'SHA-256 chain over every invoice timeline' : 'Investigate the first broken link before trusting this state.';
    }
    const policy = state.data?.policy;
    if (policy) {
      $('#policy-status').textContent = `Policy: v${policy.version} · ${policy.reminders.maxReminders} reminder cap`;
      $('#policy-detail').textContent = `Cooldown ${policy.reminders.cooldownHours}h · min ${policy.reminders.minDaysOverdue} day overdue · send cap ${money(policy.sending.maxInvoiceTotal)}.`;
    }
    renderForecastEvidence();
  }

  function renderForecastEvidence() {
    const decisions = state.insights?.policyDecisions || [];
    const blocked = decisions.filter((decision) => !decision.allowed).length;
    if (decisions.length) {
      $('#policy-detail').textContent = `${decisions.length} reminder decision${decisions.length === 1 ? '' : 's'} · ${blocked} blocked by policy · rule ids are shown in the queue.`;
    }
  }

  function renderInsights() {
    renderMetrics();
    renderQueue();
    renderForecast();
    renderInvoices();
    renderLedger();
    renderEvidence();
  }

  async function refreshData({ silent = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    const refreshButton = $('#refresh-insights');
    refreshButton.disabled = true;
    refreshButton.classList.add('is-busy');
    refreshButton.setAttribute('aria-busy', 'true');
    if (!silent) setBanner('Syncing invoices, payer history, and policy decisions…');
    try {
      const data = await api('/api/state');
      state.data = data;
      state.meta = data.meta || state.meta;
      renderConnection(data.meta);
      renderMetrics();
      renderInvoices();
      renderActivity();
      renderLedger();
      try {
        const [insights, audit] = await Promise.all([api('/api/insights'), api('/api/audit')]);
        state.insights = insights;
        state.audit = audit;
        renderInsights();
        setBanner(`Signal refreshed · ${new Date(insights.asOf || Date.now()).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} · ${data.adapter === 'paypal-sandbox' ? 'PayPal sandbox' : 'mock adapter'}`, '');
      } catch (error) {
        state.insights = fallbackInsights(data.invoices || []);
        renderInsights();
        setBanner('Copilot signal is in offline mode · showing a local risk read', 'fallback');
        if (!silent) showToast(`Insights unavailable — ${error.message}`);
      }
    } catch (error) {
      setBanner(`Could not load your invoices · ${error.message}`, 'error');
      $('#invoice-rows-compact').innerHTML = `<tr><td colspan="5"><div class="empty-state"><span class="empty-icon">!</span><strong>Couldn’t load invoices</strong><p>Check the local server, then retry the signal.</p></div></td></tr>`;
      $('#queue-list').innerHTML = `<div class="empty-state"><span class="empty-icon">!</span><strong>Signal unavailable</strong><p>Retry when the local server is ready.</p></div>`;
    } finally {
      state.loading = false;
      refreshButton.disabled = false;
      refreshButton.classList.remove('is-busy');
      refreshButton.removeAttribute('aria-busy');
    }
  }

  function fallbackInsights(invoices) {
    const today = new Date().toISOString().slice(0, 10);
    const insights = invoices.map((invoice) => {
      const days = invoice.dueDate ? Math.floor((Date.parse(`${invoice.dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000) : null;
      let risk = 'LOW'; let priority = 20; let action = 'MONITOR_PAYMENT'; let reason = 'Payment pending';
      if (invoice.status === 'DRAFT') { risk = 'MEDIUM'; priority = 90; action = 'SEND_INVOICE'; reason = 'Draft has not been sent'; }
      else if (invoice.status === 'SENT' && days === null) { risk = 'MEDIUM'; priority = 55; action = 'ADD_DUE_DATE'; reason = 'No due date is set'; }
      else if (invoice.status === 'SENT' && days < 0) { risk = days <= -7 ? 'CRITICAL' : 'HIGH'; priority = risk === 'CRITICAL' ? 100 : 95; action = 'REMIND_INVOICE'; reason = `${Math.abs(days)} days overdue`; }
      else if (invoice.status === 'SENT' && days <= 7) { risk = days <= 3 ? 'HIGH' : 'MEDIUM'; priority = days <= 3 ? 85 : 65; action = 'REMIND_INVOICE'; reason = `Due in ${days} days`; }
      return { invoiceId: invoice.id, customer: invoice.customer, status: invoice.status, amount: invoice.total, currency: invoice.currency, dueDate: invoice.dueDate, daysUntilDue: days, daysOverdue: days !== null && days < 0 ? Math.abs(days) : 0, risk, urgency: risk, confidence: .72, reasonCodes: [reason], explanation: reason, expectedPaymentDate: invoice.dueDate, policy: null, nextAction: { type: action, action, priority, invoiceId: invoice.id, reasonCodes: [reason] } };
    });
    const recommendations = insights.filter((item) => !['PAID', 'CANCELLED', 'VOID', 'REFUNDED'].includes(item.status)).sort((a, b) => b.nextAction.priority - a.nextAction.priority);
    const projectedCashPosition = {};
    [7, 14, 30].forEach((horizon) => { projectedCashPosition[String(horizon)] = insights.filter((item) => item.status === 'SENT' && item.daysUntilDue !== null && item.daysUntilDue <= horizon).reduce((totals, item) => ({ ...totals, [item.currency]: (totals[item.currency] || 0) + Number(item.amount || 0) }), {}); });
    return { asOf: new Date().toISOString(), invoices: insights, recommendations, projectedCashPosition, expectedCashPosition: projectedCashPosition, payerStats: { global: { paidCount: 0, medianLateness: 0 }, payers: [] }, policyDecisions: [], nextAction: recommendations[0]?.nextAction || null };
  }

  function openInvoiceDrawer(invoiceId) {
    const invoice = state.data?.invoices?.find((item) => item.id === invoiceId);
    if (!invoice) { showToast('That invoice is no longer available.'); return; }
    state.lastFocus = document.activeElement;
    const insight = state.insights?.invoices?.find((item) => item.invoiceId === invoice.id);
    const events = (invoice.events || []).slice().sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    const canRemind = invoice.status === 'SENT';
    const canPay = invoice.status === 'SENT';
    const canSend = invoice.status === 'DRAFT';
    const canCancel = invoice.status === 'SENT' || invoice.status === 'DRAFT';
    const chain = state.audit?.invoices?.find((item) => item.invoiceId === invoice.id);
    const policyDecision = insight?.policy?.reminder;
    $('#drawer-content').innerHTML = `
      <div class="drawer-summary"><div class="drawer-summary-top"><div><strong>${escapeHtml(money(invoice.total, invoice.currency))}</strong><div class="drawer-customer">${escapeHtml(invoice.customer?.name || 'Unnamed client')}<small>${escapeHtml(invoice.customer?.email || 'No email')}</small></div></div>${statusPill(invoice.status)}</div>
      ${insight ? `<div class="drawer-insight"><span class="risk-label risk-${escapeHtml(String(insight.risk).toLowerCase())}">${escapeHtml(insight.risk)} RISK</span><p>${escapeHtml(insight.explanation)}</p><div class="drawer-meta-row"><span>Expected ${escapeHtml(insight.expectedPaymentDate ? date(insight.expectedPaymentDate) : '—')}</span><span>Basis ${escapeHtml(insight.forecastBasis || 'due_date')}</span><span>${Math.round(Number(insight.confidence) * 100)}% confidence</span></div>${policyDecision ? `<div class="policy-callout ${policyDecision.allowed ? 'ok' : 'blocked'}"><strong>${escapeHtml(policyDecision.ruleId)}</strong><span>${escapeHtml(policyDecision.message || (policyDecision.allowed ? 'Policy allows this action.' : 'Policy holds this action.'))}</span><code>${escapeHtml(JSON.stringify(policyDecision.inputs))}</code></div>` : ''}</div>` : ''}
      <div class="drawer-actions">
        ${canSend ? '<button class="button button-primary" id="drawer-send" type="button">Send invoice with PayPal</button>' : ''}
        ${canRemind ? '<button class="button button-primary" id="drawer-remind" type="button">Send gentle reminder</button>' : ''}
        ${canPay ? '<button class="button button-quiet" id="drawer-pay-link" type="button">Create payment link</button>' : ''}
        ${canCancel ? '<button class="button button-danger" id="drawer-cancel" type="button">Cancel invoice</button>' : ''}
      </div>
      <div id="drawer-link"></div>
      <div class="detail-grid"><div><span>Due date</span><strong>${escapeHtml(date(invoice.dueDate))}</strong></div><div><span>Reminder history</span><strong>${escapeHtml(String(invoice.reminderCount || 0))} sent</strong></div><div><span>Subtotal</span><strong>${escapeHtml(money(invoice.subtotal, invoice.currency))}</strong></div><div><span>Tax</span><strong>${escapeHtml(money(invoice.tax, invoice.currency))}</strong></div><div><span>PayPal invoice</span><strong>${escapeHtml(invoice.paypalInvoiceId || 'Not created')}</strong></div><div><span>Payment reference</span><strong>${escapeHtml(invoice.paymentReference || '—')}</strong></div></div>
      <h3 class="drawer-section-title">LIFECYCLE TIMELINE ${chain ? `<span class="chain-badge ${chain.valid ? 'ok' : 'bad'}">${chain.valid ? `CHAIN VERIFIED · ${chain.checked} EVENTS` : 'CHAIN BROKEN'}</span>` : ''}</h3>
      <div class="timeline">${events.length ? events.map((event) => { const proof = event.source === 'seed' ? 'Seed data' : event.verified ? 'Verified PayPal webhook' : event.source === 'simulated' ? 'Demo-safe simulated webhook' : event.source === 'paypal' ? 'PayPal event' : event.source === 'copilot' ? 'Copilot-approved action' : 'App audit event'; return `<div class="timeline-item ${event.type === 'INVOICING.INVOICE.PAID' || event.type === 'PAYMENT.CAPTURE.COMPLETED' ? 'paid' : event.type === 'INVOICING.INVOICE.REMINDER_SENT' ? 'reminder' : ''}"><strong>${escapeHtml(eventLabel(event.type))}</strong><p>${escapeHtml(dateTime(event.at))}${event.eventId ? ` · event ${escapeHtml(event.eventId)}` : ''}</p><small class="timeline-proof">${escapeHtml(proof)}${event.hash ? ` · hash ${escapeHtml(String(event.hash).slice(0, 12))}…` : ''}</small></div>`; }).join('') : '<div class="empty-state"><strong>No events recorded</strong><p>This invoice has not entered the PayPal lifecycle yet.</p></div>'}</div>
      <div class="drawer-proof"><span>✓</span><span>Human-approved actions are recorded on this invoice.</span></div>`;
    $('#detail-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    $('#close-drawer').focus();
    $('#drawer-remind')?.addEventListener('click', () => sendReminder(invoice.id));
    $('#drawer-send')?.addEventListener('click', () => sendInvoice(invoice.id));
    $('#drawer-pay-link')?.addEventListener('click', () => createPaymentLink(invoice.id));
    $('#drawer-cancel')?.addEventListener('click', () => cancelInvoice(invoice.id));
  }

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
    const button = $('#drawer-remind');
    if (button) { button.disabled = true; button.classList.add('is-busy'); button.setAttribute('aria-busy', 'true'); button.textContent = 'Sending…'; }
    try {
      await api(`/api/invoices/${encodeURIComponent(invoiceId)}/remind`, { method: 'POST', body: '{}' });
      await refreshData({ silent: true });
      openInvoiceDrawer(invoiceId);
      showToast(state.mode === 'sandbox' ? 'Reminder sent through PayPal Sandbox and added to the audit trail.' : 'Reminder recorded through the mock adapter and added to the audit trail.');
    } catch (error) {
      if (button) { button.disabled = false; button.classList.remove('is-busy'); button.removeAttribute('aria-busy'); button.textContent = 'Send gentle reminder'; }
      showToast(`Reminder could not be sent · ${error.message}`);
    }
  }

  async function sendInvoice(invoiceId) {
    if (!window.confirm('Send this draft invoice through the configured PayPal adapter?')) return;
    try {
      await api(`/api/invoices/${encodeURIComponent(invoiceId)}/send`, { method: 'POST', body: '{}' });
      await refreshData({ silent: true });
      openInvoiceDrawer(invoiceId);
      showToast('Invoice sent and recorded in the audit trail.');
    } catch (error) { showToast(`Invoice could not be sent · ${error.message}`); }
  }

  async function cancelInvoice(invoiceId) {
    if (!window.confirm('Cancel this invoice? This is final for the invoice.')) return;
    try {
      await api(`/api/invoices/${encodeURIComponent(invoiceId)}/cancel`, { method: 'POST', body: JSON.stringify({ reason: 'Cancelled by merchant from Cashflow Copilot' }) });
      await refreshData({ silent: true });
      openInvoiceDrawer(invoiceId);
      showToast('Invoice cancelled.');
    } catch (error) { showToast(`Invoice could not be cancelled · ${error.message}`); }
  }

  async function createPaymentLink(invoiceId) {
    try {
      const result = await api(`/api/invoices/${encodeURIComponent(invoiceId)}/payment-link`, { method: 'POST', body: '{}' });
      const url = new URL(result.payUrl, window.location.origin).toString();
      $('#drawer-link').innerHTML = `<div class="pay-link-box"><strong>Customer payment link</strong><code>${escapeHtml(url)}</code><div><a class="button button-primary" href="${escapeHtml(url)}" target="_blank" rel="noopener">Open checkout</a><button class="button button-quiet" id="copy-pay-link" type="button">Copy link</button></div></div>`;
      $('#copy-pay-link')?.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(url); showToast('Payment link copied.'); } catch { showToast('Copy failed — select the link manually.'); }
      });
      showToast(result.order?.mock ? 'Mock checkout link created.' : 'PayPal Checkout order created.');
    } catch (error) { showToast(`Payment link failed · ${error.message}`); }
  }

  function renderAiProvenance(ai = {}) {
    const provider = ai.provider || 'deterministic';
    const model = ai.model ? ` · ${ai.model}` : '';
    const label = provider === 'deterministic' ? 'Deterministic parser · offline mode' : `${provider}${model}`;
    $('#ai-provenance').textContent = ai.fallback ? `${label} · fallback${ai.reason ? ` — ${ai.reason}` : ''}` : label;
  }

  function openModal(draft, ai) {
    state.draft = draft;
    state.items = (draft.items || []).map((item) => ({ ...item }));
    state.lastFocus = document.activeElement;
    const form = $('#invoice-form');
    form.customerName.value = draft.customer?.name || '';
    form.customerEmail.value = draft.customer?.email || '';
    form.dueDate.value = draft.dueDate || '';
    form.taxRate.value = draft.taxRate ?? 0;
    form.notes.value = draft.notes || '';
    const currency = draft.currency || 'USD';
    if (![...form.currency.options].some((option) => option.value === currency)) {
      const option = document.createElement('option');
      option.value = currency;
      option.textContent = currency;
      form.currency.appendChild(option);
    }
    form.currency.value = currency;
    $('#extraction-summary').textContent = `I found ${state.items.length} line item${state.items.length === 1 ? '' : 's'} for ${draft.customer?.name || 'your customer'} and calculated ${money(draft.total, draft.currency)}.`;
    renderAiProvenance(ai);
    renderFormItems();
    $('#modal-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => form.customerName.focus(), 0);
  }

  function closeModal() { $('#modal-backdrop').hidden = true; document.body.style.overflow = ''; state.lastFocus?.focus?.(); }

  function currentCurrency() { return $('#invoice-form').currency.value || 'USD'; }

  function renderFormItems() {
    const currency = currentCurrency();
    $('#form-items').innerHTML = state.items.map((item, index) => `<div class="item-row" data-item-index="${index}"><label>Description<input data-field="description" value="${escapeHtml(item.description)}" required></label><label>Qty<input data-field="quantity" type="number" min="0.01" step="0.01" value="${escapeHtml(item.quantity)}" required></label><label>Unit price<input data-field="unitPrice" type="number" min="0" step="0.01" value="${escapeHtml(item.unitPrice)}" required></label><label>Amount<input value="${escapeHtml(money(Number(item.quantity) * Number(item.unitPrice), currency))}" disabled></label><button type="button" class="remove-item" data-remove-item="${index}" aria-label="Remove line ${index + 1}">×</button></div>`).join('');
    $$('#form-items input[data-field]').forEach((input) => input.addEventListener('input', (event) => {
      const item = state.items[Number(event.target.closest('[data-item-index]').dataset.itemIndex)];
      item[event.target.dataset.field] = event.target.dataset.field === 'description' ? event.target.value : Number(event.target.value);
      updateFormTotals();
    }));
    $$('[data-remove-item]').forEach((button) => button.addEventListener('click', () => { state.items.splice(Number(button.dataset.removeItem), 1); renderFormItems(); }));
    updateFormTotals();
  }

  function updateFormTotals() {
    const currency = currentCurrency();
    const subtotal = state.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
    const tax = subtotal * (Number($('#invoice-form').taxRate.value || 0) / 100);
    $('#form-subtotal').textContent = money(subtotal, currency);
    $('#form-tax').textContent = money(tax, currency);
    $('#form-total').textContent = money(subtotal + tax, currency);
    $$('#form-items .item-row').forEach((row, index) => {
      const amount = row.querySelector('input[disabled]');
      if (amount) amount.value = money(Number(state.items[index]?.quantity || 0) * Number(state.items[index]?.unitPrice || 0), currency);
    });
  }

  async function parsePrompt(text) {
    if (!text.trim()) { showToast('Tell me what needs to get paid first.'); return; }
    const button = $('#chat-send');
    button.disabled = true;
    button.classList.add('is-busy');
    try {
      const result = await api('/api/parse-invoice', { method: 'POST', body: JSON.stringify({ text }) });
      openModal(result.invoice, result.ai);
    } catch (error) {
      showToast(`Couldn’t draft invoice · ${error.message}`);
    } finally {
      button.disabled = false;
      button.classList.remove('is-busy');
    }
  }

  async function submitDraft(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      customer: { name: form.customerName.value.trim(), email: form.customerEmail.value.trim() },
      dueDate: form.dueDate.value || null,
      currency: form.currency.value,
      taxRate: Number(form.taxRate.value || 0),
      items: state.items.map((item) => ({ description: String(item.description || '').trim(), quantity: Number(item.quantity), unitPrice: Number(item.unitPrice) })),
      notes: form.notes.value.trim() || null
    };
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    submit.classList.add('is-busy');
    submit.setAttribute('aria-busy', 'true');
    submit.textContent = 'Sending…';
    try {
      const created = await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
      await api(`/api/invoices/${encodeURIComponent(created.invoice.id)}/send`, { method: 'POST', body: '{}' });
      closeModal();
      await refreshData({ silent: true });
      openInvoiceDrawer(created.invoice.id);
      showToast(state.mode === 'sandbox' ? 'Invoice approved and sent through PayPal Sandbox.' : 'Invoice approved and sent through the mock adapter.');
    } catch (error) {
      showToast(`Couldn’t send invoice · ${error.message}`);
    } finally {
      submit.disabled = false;
      submit.classList.remove('is-busy');
      submit.removeAttribute('aria-busy');
      submit.innerHTML = '<span>✓</span> Approve &amp; send with PayPal';
    }
  }

  function appendChat(role, content, extra = '') {
    const thread = $('#chat-thread');
    const message = document.createElement('div');
    message.className = `chat-message ${role}`;
    message.innerHTML = role === 'assistant'
      ? `<div class="chat-avatar">✦</div><div class="chat-bubble"><p>${content}</p>${extra}</div>`
      : `<div class="chat-bubble"><p>${content}</p></div><div class="chat-avatar user">JM</div>`;
    thread.appendChild(message);
    thread.scrollTop = thread.scrollHeight;
    return message;
  }

  function renderPlan(plan, messageEl) {
    const bubble = $('.chat-bubble', messageEl);
    if (!plan.steps?.length) return;
    const steps = plan.steps.map((step) => `<label class="plan-step" data-step-id="${escapeHtml(step.id)}"><input type="checkbox" checked value="${escapeHtml(step.id)}"><span><strong>${escapeHtml(step.summary)}</strong><small>${escapeHtml(step.execution === 'client' ? 'Opens the review modal' : 'Requires your approval before PayPal runs')}</small></span></label>`).join('');
    bubble.insertAdjacentHTML('beforeend', `<div class="plan-card"><div class="plan-head"><span>PROPOSED PLAN</span><span class="plan-ai">${escapeHtml(plan.ai?.provider === 'deterministic' ? 'rules + policy' : `${plan.ai.provider}${plan.ai.model ? ` · ${plan.ai.model}` : ''}`)}</span></div><div class="plan-steps">${steps}</div><div class="plan-actions"><button class="button button-primary plan-run" type="button">Approve selected</button><button class="button button-quiet plan-dismiss" type="button">Not now</button></div></div>`);
    $('.plan-dismiss', bubble).addEventListener('click', () => { $('.plan-card', bubble)?.remove(); });
    $('.plan-run', bubble).addEventListener('click', async () => {
      const selected = $$('input:checked', bubble).map((input) => input.value);
      if (!selected.length) { showToast('Select at least one action to approve.'); return; }
      const run = $('.plan-run', bubble);
      run.disabled = true;
      run.textContent = 'Running…';
      try {
        const result = await api('/api/copilot/execute', { method: 'POST', body: JSON.stringify({ planId: plan.id, stepIds: selected }) });
        const executed = result.results.filter((entry) => entry.status === 'executed').length;
        const failed = result.results.filter((entry) => entry.status === 'failed');
        const client = result.results.filter((entry) => entry.status === 'client_action');
        for (const entry of client) {
          const step = plan.steps.find((item) => item.id === entry.stepId);
          if (step?.payload?.invoice) openModal(step.payload.invoice, plan.ai);
        }
        $('.plan-card', bubble)?.remove();
        appendChat('assistant', `Approved and executed ${executed} action${executed === 1 ? '' : 's'}.${failed.length ? ` ${failed.length} failed: ${escapeHtml(failed.map((entry) => entry.message).join('; '))}.` : ''}`, '<div class="plan-result"><span>✓</span> Every executed step is in the hash-chained audit trail.</div>');
        await refreshData({ silent: true });
      } catch (error) {
        run.disabled = false;
        run.textContent = 'Approve selected';
        showToast(`Plan failed · ${error.message}`);
      }
    });
  }

  async function askCopilot(rawMessage) {
    const text = String(rawMessage || '').trim();
    if (!text || state.chatBusy) return;
    state.chatBusy = true;
    $('#chat-input').value = '';
    appendChat('user', escapeHtml(text));
    const typing = appendChat('assistant', '<span class="typing"><i></i><i></i><i></i></span>');
    $('#chat-send').disabled = true;
    $('#chat-send').classList.add('is-busy');
    try {
      // Invoice-like requests go straight to the extraction path so the AI
      // provenance and editable review modal are preserved.
      if (/(invoice|bill)\b/i.test(text) && /\d/.test(text) && !/(send|remind|chase|forecast|cash|who)\b/i.test(text)) {
        typing.remove();
        await parsePrompt(text);
        appendChat('assistant', 'I opened the editable draft. Check the amounts, due date, and currency — then approve to send it through PayPal.');
      } else {
        const plan = await api('/api/copilot/plan', { method: 'POST', body: JSON.stringify({ message: text }) });
        typing.remove();
        const messageEl = appendChat('assistant', escapeHtml(plan.answer));
        renderPlan(plan, messageEl);
      }
    } catch (error) {
      typing.remove();
      appendChat('assistant', `I hit an error: ${escapeHtml(error.message)}. Nothing was sent.`);
    } finally {
      state.chatBusy = false;
      $('#chat-send').disabled = false;
      $('#chat-send').classList.remove('is-busy');
    }
  }

  async function simulatePaid() {
    const invoice = state.data?.invoices?.find((item) => item.status === 'SENT');
    if (!invoice) { showToast('No sent invoice is waiting for a payment event.'); return; }
    const button = $('#simulate-button');
    button.disabled = true;
    button.classList.add('is-busy');
    try {
      await api('/api/webhooks/simulate', { method: 'POST', body: JSON.stringify({ eventType: 'INVOICING.INVOICE.PAID', invoiceId: invoice.id }) });
      await refreshData({ silent: true });
      showToast(`${invoice.customer?.name || 'Client'} paid ${money(invoice.total, invoice.currency)} — simulated webhook recorded.`);
    } catch (error) { showToast(`Demo webhook failed · ${error.message}`); } finally { button.disabled = false; button.classList.remove('is-busy'); }
  }

  async function verifyAudit() {
    try {
      const audit = await api('/api/audit');
      state.audit = audit;
      renderEvidence();
      showToast(audit.valid ? `Audit verified: ${audit.checkedEvents} events, ${audit.invoiceCount} invoices.` : `Audit chain broken at event ${audit.failures?.[0]?.brokenAt}.`);
    } catch (error) { showToast(`Audit check failed · ${error.message}`); }
  }

  async function resetDemo() {
    if (!window.confirm('Reset the demo to freshly seeded invoices?')) return;
    try {
      await api('/api/demo/reset', { method: 'POST', body: '{}' });
      await refreshData();
      showToast('Demo reset to a fresh seeded ledger.');
    } catch (error) { showToast(`Reset failed · ${error.message}`); }
  }

  function bindEvents() {
    $('#open-draft').addEventListener('click', () => { $('#copilot').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#chat-input').focus(); });
    $('#chat-send').addEventListener('click', () => askCopilot($('#chat-input').value));
    $('#chat-input').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') askCopilot(event.target.value); });
    $$('.chat-suggestion').forEach((suggestion) => suggestion.addEventListener('click', () => askCopilot(suggestion.dataset.prompt)));
    $('#close-modal').addEventListener('click', closeModal);
    $('#cancel-modal').addEventListener('click', closeModal);
    $('#close-drawer').addEventListener('click', closeDrawer);
    $('#detail-backdrop').addEventListener('click', (event) => { if (event.target.id === 'detail-backdrop') closeDrawer(); });
    $('#modal-backdrop').addEventListener('click', (event) => { if (event.target.id === 'modal-backdrop') closeModal(); });
    $('#open-tour').addEventListener('click', (event) => { event.preventDefault(); openTour(); });
    $('#open-tour-inline').addEventListener('click', openTour);
    $('#close-tour').addEventListener('click', closeTour);
    $('#close-tour-cta').addEventListener('click', closeTour);
    $('#tour-backdrop').addEventListener('click', (event) => { if (event.target.id === 'tour-backdrop') closeTour(); });
    $('#invoice-form').addEventListener('submit', submitDraft);
    $('#invoice-form').taxRate.addEventListener('input', updateFormTotals);
    $('#invoice-form').currency.addEventListener('change', renderFormItems);
    $('#add-item').addEventListener('click', () => { state.items.push({ description: 'New service', quantity: 1, unitPrice: 0 }); renderFormItems(); });
    $('#simulate-button').addEventListener('click', simulatePaid);
    $('#refresh-insights').addEventListener('click', () => refreshData());
    $('#verify-audit').addEventListener('click', verifyAudit);
    $('#reset-demo').addEventListener('click', resetDemo);
    $('#view-all').addEventListener('click', () => $('#ledger').scrollIntoView({ behavior: 'smooth', block: 'start' }));
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!$('#tour-backdrop').hidden) closeTour();
        else if (!$('#modal-backdrop').hidden) closeModal();
        else if (!$('#detail-backdrop').hidden) closeDrawer();
      }
      if (event.key === 'Tab') {
        if (!$('#tour-backdrop').hidden) trapFocus($('#tour-panel'), event);
        else if (!$('#modal-backdrop').hidden) trapFocus($('.draft-modal'), event);
        else if (!$('#detail-backdrop').hidden) trapFocus($('#invoice-drawer'), event);
      }
    });
  }

  bindEvents();
  refreshData();
})();
