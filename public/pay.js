(() => {
  'use strict';

  const token = window.location.pathname.split('/').filter(Boolean).pop() || '';
  const $ = (selector) => document.querySelector(selector);
  const money = (value, currency = 'USD') => {
    try { return new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(Number(value || 0)); } catch { return `${currency} ${Number(value || 0).toFixed(2)}`; }
  };
  const date = (value) => value ? new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(`${value}T00:00:00`)) : 'No due date';
  const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
  const orderKey = `paypal_order_${token}`;

  function toast(message) {
    const node = $('#toast');
    node.textContent = message;
    node.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('show'), 4200);
  }

  async function api(path, options = {}) {
    const response = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...options });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = payload.error?.message || `Request failed (${response.status})`;
      const debugId = payload.error?.details?.debugId;
      throw new Error(debugId ? `${message} [PayPal debug ${debugId}]` : message);
    }
    return payload;
  }

  function statusPill(status) {
    const labels = { SENT: 'Awaiting payment', PAID: 'Paid', DRAFT: 'Draft', CANCELLED: 'Cancelled', VOID: 'Void', REFUNDED: 'Refunded' };
    return `<span class="status-pill status-${escapeHtml(String(status).toLowerCase())}">${escapeHtml(labels[status] || status)}</span>`;
  }

  function render(data) {
    const invoice = data.invoice;
    const merchant = data.merchant;
    const mock = Boolean(data.checkout?.mock);
    document.title = `Invoice ${invoice.id} — ${merchant.name}`;
    $('#pay-mode').textContent = mock ? 'Mock checkout · no money moves' : 'PayPal Sandbox checkout';
    const items = invoice.items.map((item) => `<tr><td><strong>${escapeHtml(item.description)}</strong><small>${escapeHtml(item.quantity)} × ${escapeHtml(money(item.unitPrice, invoice.currency))}</small></td><td>${escapeHtml(money(item.amount, invoice.currency))}</td></tr>`).join('');
    const paid = invoice.status === 'PAID';
    const payable = invoice.status === 'SENT';
    $('#pay-loading').hidden = true;
    $('#pay-content').hidden = false;
    $('#pay-content').innerHTML = `
      <div class="pay-top">
        <div><p class="eyebrow">INVOICE ${escapeHtml(invoice.id)}</p><h1>${escapeHtml(merchant.name)}</h1><p class="pay-due">Due ${escapeHtml(date(invoice.dueDate))}</p></div>
        ${statusPill(invoice.status)}
      </div>
      <div class="pay-parties"><div><span>Billed to</span><strong>${escapeHtml(invoice.customer.name)}</strong></div><div><span>Amount due</span><strong class="pay-amount">${escapeHtml(money(invoice.total, invoice.currency))}</strong></div></div>
      <table class="pay-items"><thead><tr><th>Item</th><th>Amount</th></tr></thead><tbody>${items}</tbody></table>
      <div class="pay-totals"><div><span>Subtotal</span><strong>${escapeHtml(money(invoice.subtotal, invoice.currency))}</strong></div><div><span>Tax (${escapeHtml(invoice.taxRate)}%)</span><strong>${escapeHtml(money(invoice.tax, invoice.currency))}</strong></div><div class="pay-total"><span>Total</span><strong>${escapeHtml(money(invoice.total, invoice.currency))}</strong></div></div>
      ${invoice.notes ? `<p class="pay-notes">${escapeHtml(invoice.notes)}</p>` : ''}
      ${paid ? `<div class="pay-success"><span>✓</span><div><strong>Payment confirmed</strong><p>${escapeHtml(invoice.paymentReference ? `PayPal reference ${invoice.paymentReference}` : 'This invoice has been paid.')} You can close this page.</p></div></div>` : ''}
      ${!paid && !payable ? `<div class="pay-blocked"><strong>This invoice cannot be paid right now.</strong><p>Its status is ${escapeHtml(invoice.status)}. Contact the merchant if you believe this is a mistake.</p></div>` : ''}
      ${payable ? `<div class="pay-actions"><button class="button pay-button" id="pay-button" type="button"><span class="pay-wordmark">PayPal</span><span>${mock ? 'Simulate PayPal checkout' : 'Pay with PayPal'}</span></button><p id="pay-hint">${mock ? 'Demo mode: this creates a real checkout order object in the mock adapter and marks the invoice paid. No money moves.' : 'You will be redirected to PayPal to approve the payment. The merchant is notified only after PayPal confirms the capture.'}</p></div>` : ''}
      <div class="pay-trust"><div><strong>Human approved</strong><span>The merchant reviewed this invoice before sending it.</span></div><div><strong>Verified outcome</strong><span>Payment status changes only after PayPal confirms it.</span></div></div>`;
    $('#pay-button')?.addEventListener('click', startPayment);
  }

  async function load() {
    try {
      const data = await api(`/api/pay/${encodeURIComponent(token)}`);
      render(data);
      const returned = new URLSearchParams(window.location.search).get('status');
      if (returned === 'return' && data.invoice.status === 'SENT' && sessionStorage.getItem(orderKey)) {
        await capture();
      }
      if (returned === 'cancel') toast('Payment cancelled. You can try again when you are ready.');
    } catch (error) {
      $('#pay-loading').hidden = true;
      $('#pay-content').hidden = false;
      $('#pay-content').innerHTML = `<div class="pay-error"><span>!</span><div><strong>This payment link is not available</strong><p>${escapeHtml(error.message)}. Ask the merchant for a fresh link.</p></div></div>`;
    }
  }

  async function startPayment() {
    const button = $('#pay-button');
    if (button) { button.disabled = true; button.classList.add('is-busy'); }
    try {
      const { order } = await api(`/api/pay/${encodeURIComponent(token)}/order`, { method: 'POST', body: '{}' });
      if (order?.id) sessionStorage.setItem(orderKey, order.id);
      if (order?.mock) {
        await capture();
        return;
      }
      if (order?.approveUrl) {
        window.location.href = order.approveUrl;
        return;
      }
      throw new Error('PayPal did not return an approval link');
    } catch (error) {
      toast(`Checkout could not start · ${error.message}`);
      if (button) { button.disabled = false; button.classList.remove('is-busy'); }
    }
  }

  async function capture() {
    const orderId = sessionStorage.getItem(orderKey);
    if (!orderId) { toast('No PayPal order is attached to this session.'); return; }
    try {
      const result = await api(`/api/pay/${encodeURIComponent(token)}/capture`, { method: 'POST', body: JSON.stringify({ orderId }) });
      sessionStorage.removeItem(orderKey);
      toast(result.duplicate ? 'This payment was already recorded.' : 'Payment confirmed.');
      await load();
    } catch (error) {
      toast(`Payment could not be confirmed · ${error.message}`);
    }
  }

  load();
})();
