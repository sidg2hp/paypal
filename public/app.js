(() => {
  'use strict';

  const state = { data: null, draft: null, items: [] };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const money = (value, currency = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(Number(value || 0));
  const date = (value) => value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00`)) : 'No due date';

  async function api(path, options = {}) {
    const response = await fetch(path, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error?.message || 'Something went wrong');
    return payload;
  }

  function initials(name) { return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase(); }
  function statusPill(status) {
    const label = status === 'SENT' ? 'Sent' : status === 'PAID' ? 'Paid' : status === 'DRAFT' ? 'Draft' : status[0] + status.slice(1).toLowerCase();
    return `<span class="status-pill status-${status.toLowerCase()}">${label}</span>`;
  }

  function renderMetrics(summary) {
    $('#metric-outstanding').textContent = money(summary.totalOutstanding);
    $('#metric-paid').textContent = money(summary.totalPaid);
    $('#metric-open').textContent = String((summary.byStatus.SENT || 0) + (summary.byStatus.DRAFT || 0));
  }

  function renderInvoices(invoices) {
    const rows = $('#invoice-rows');
    rows.innerHTML = invoices.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((invoice, index) => `
      <tr data-invoice-id="${invoice.id}">
        <td><div class="client-cell"><span class="client-avatar ${index % 3 === 1 ? 'purple' : index % 3 === 2 ? 'green' : ''}">${initials(invoice.customer.name)}</span><div><strong>${escapeHtml(invoice.customer.name)}</strong><small>${escapeHtml(invoice.customer.email)}</small></div></div></td>
        <td class="amount">${money(invoice.total, invoice.currency)}</td>
        <td class="due ${invoice.status === 'SENT' ? 'soon' : ''}">${date(invoice.dueDate)}</td>
        <td>${statusPill(invoice.status)}</td>
        <td><button class="row-menu" data-row-action="${invoice.id}" aria-label="Invoice actions">•••</button></td>
      </tr>`).join('');
    $$('.row-menu').forEach((button) => button.addEventListener('click', () => showToast('Invoice actions are review-first — choose an action from the Copilot.')));
  }

  function renderActivity(invoices) {
    const events = invoices.flatMap((invoice) => (invoice.events || []).map((event) => ({ ...event, customer: invoice.customer.name, total: invoice.total, status: invoice.status }))).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 4);
    $('#activity-list').innerHTML = events.map((event, index) => {
      const paid = event.type.endsWith('PAID');
      const sent = event.type.endsWith('SENT');
      return `<div class="activity-item"><span class="activity-icon ${paid ? 'green' : sent ? '' : 'amber'}">${paid ? '✓' : sent ? '↗' : '!'}</span><div><strong>${paid ? 'Payment received' : sent ? 'Invoice sent' : 'Status updated'}</strong><p>${escapeHtml(event.customer)} · ${money(event.total)}</p></div><span class="activity-time">${relativeTime(event.at)}</span></div>`;
    }).join('');
  }

  function relativeTime(value) {
    const days = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 86400000));
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    return `${days}d ago`;
  }

  function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character])); }

  async function refresh() {
    state.data = await api('/api/state');
    renderMetrics(state.data.summary);
    renderInvoices(state.data.invoices);
    renderActivity(state.data.invoices);
    $('#adapter-label').textContent = `${state.data.adapter.toUpperCase()} ADAPTER`;
  }

  function openModal(draft) {
    state.draft = draft;
    state.items = draft.items.map((item) => ({ ...item }));
    const form = $('#invoice-form');
    form.customerName.value = draft.customer.name || '';
    form.customerEmail.value = draft.customer.email || '';
    form.dueDate.value = draft.dueDate || '';
    form.taxRate.value = draft.taxRate ?? 0;
    form.notes.value = draft.notes || '';
    $('#extraction-summary').textContent = `I found ${draft.items.length} line item${draft.items.length === 1 ? '' : 's'} for ${draft.customer.name || 'your customer'} and calculated ${money(draft.total)}.`;
    renderFormItems();
    $('#modal-backdrop').hidden = false;
    document.body.style.overflow = 'hidden';
    setTimeout(() => form.customerName.focus(), 0);
  }

  function closeModal() { $('#modal-backdrop').hidden = true; document.body.style.overflow = ''; }

  function renderFormItems() {
    $('#form-items').innerHTML = state.items.map((item, index) => `<div class="item-row" data-item-index="${index}"><label>Description<input data-field="description" value="${escapeHtml(item.description)}" required></label><label>Qty<input data-field="quantity" type="number" min="0.01" step="0.01" value="${item.quantity}" required></label><label>Unit price<input data-field="unitPrice" type="number" min="0" step="0.01" value="${item.unitPrice}" required></label><label>Amount<input value="${money(Number(item.quantity) * Number(item.unitPrice))}" disabled></label><button type="button" class="remove-item" data-remove-item="${index}" aria-label="Remove line">×</button></div>`).join('');
    $$('#form-items input[data-field]').forEach((input) => input.addEventListener('input', (event) => {
      const row = event.target.closest('[data-item-index]');
      const item = state.items[Number(row.dataset.itemIndex)];
      item[event.target.dataset.field] = event.target.dataset.field === 'description' ? event.target.value : Number(event.target.value);
      updateFormTotals();
    }));
    $$('[data-remove-item]').forEach((button) => button.addEventListener('click', () => { state.items.splice(Number(button.dataset.removeItem), 1); renderFormItems(); updateFormTotals(); }));
    updateFormTotals();
  }

  function updateFormTotals() {
    const subtotal = state.items.reduce((sum, item) => sum + Number(item.quantity || 0) * Number(item.unitPrice || 0), 0);
    const tax = subtotal * (Number($('#invoice-form').taxRate.value || 0) / 100);
    $('#form-subtotal').textContent = money(subtotal);
    $('#form-tax').textContent = money(tax);
    $('#form-total').textContent = money(subtotal + tax);
    $$('#form-items .item-row').forEach((row, index) => { const amount = row.querySelector('input[disabled]'); if (amount) amount.value = money(Number(state.items[index]?.quantity || 0) * Number(state.items[index]?.unitPrice || 0)); });
  }

  async function parsePrompt(text) {
    if (!text.trim()) { showToast('Tell me what needs to get paid first.'); return; }
    const button = $('#parse-button');
    button.disabled = true; button.textContent = '…';
    try { const result = await api('/api/parse-invoice', { method: 'POST', body: JSON.stringify({ text }) }); openModal(result.invoice); }
    catch (error) { showToast(error.message); }
    finally { button.disabled = false; button.textContent = '↗'; }
  }

  async function submitDraft(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const payload = {
      customer: { name: form.customerName.value.trim(), email: form.customerEmail.value.trim() },
      dueDate: form.dueDate.value || null,
      taxRate: Number(form.taxRate.value || 0),
      items: state.items.map((item) => ({ description: item.description.trim(), quantity: Number(item.quantity), unitPrice: Number(item.unitPrice) })),
      notes: form.notes.value.trim() || null
    };
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true; submit.textContent = 'Sending…';
    try {
      const created = await api('/api/invoices', { method: 'POST', body: JSON.stringify(payload) });
      await api(`/api/invoices/${created.invoice.id}/send`, { method: 'POST', body: '{}' });
      closeModal(); await refresh(); showToast('Invoice approved and sent through PayPal.');
    } catch (error) { showToast(error.message); }
    finally { submit.disabled = false; submit.innerHTML = '<span>✓</span> Approve & send with PayPal'; }
  }

  async function simulatePaid() {
    const invoice = state.data?.invoices.find((item) => item.status === 'SENT');
    if (!invoice) { showToast('No sent invoice is waiting for a payment event.'); return; }
    try { await api('/api/webhooks/simulate', { method: 'POST', body: JSON.stringify({ eventType: 'INVOICING.INVOICE.PAID', invoiceId: invoice.id }) }); await refresh(); showToast(`${invoice.customer.name} paid ${money(invoice.total)} — cashflow updated.`); }
    catch (error) { showToast(error.message); }
  }

  function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 3500); }

  $('#open-draft').addEventListener('click', () => { $('#prompt-input').focus(); document.querySelector('#copilot').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
  $('#parse-button').addEventListener('click', () => parsePrompt($('#prompt-input').value));
  $('#prompt-input').addEventListener('keydown', (event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') parsePrompt(event.target.value); });
  $$('.suggestion').forEach((suggestion) => suggestion.addEventListener('click', () => { $('#prompt-input').value = suggestion.dataset.prompt; $('#prompt-input').focus(); }));
  $('#close-modal').addEventListener('click', closeModal); $('#cancel-modal').addEventListener('click', closeModal);
  $('#modal-backdrop').addEventListener('click', (event) => { if (event.target.id === 'modal-backdrop') closeModal(); });
  $('#invoice-form').addEventListener('submit', submitDraft); $('#invoice-form').taxRate.addEventListener('input', updateFormTotals);
  $('#add-item').addEventListener('click', () => { state.items.push({ description: 'New service', quantity: 1, unitPrice: 0 }); renderFormItems(); });
  $('#simulate-button').addEventListener('click', simulatePaid);
  $$('.inline-action').forEach((button) => button.addEventListener('click', () => showToast('Reminder prepared — sending reminders is the next Copilot action.')));
  $('#view-all').addEventListener('click', () => document.querySelector('#invoices').scrollIntoView({ behavior: 'smooth', block: 'start' }));
  refresh().catch((error) => showToast(error.message));
})();
