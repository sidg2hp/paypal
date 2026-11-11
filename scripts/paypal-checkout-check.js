'use strict';

/**
 * PayPal Checkout capability check.
 *
 * Creates a $1.00 sandbox order with intent=CAPTURE but does NOT capture it.
 * No money moves. This tells you whether the app's token can use Orders v2,
 * which is the fallback live-PayPal path if Invoicing is blocked.
 *
 * Usage:
 *   PowerShell: npm run paypal:checkout
 */

function classifyBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.includes('sandbox')) return 'sandbox';
    if (host === 'api-m.paypal.com' || host === 'api.paypal.com') return 'live';
    return 'custom';
  } catch {
    return 'invalid';
  }
}

async function main() {
  const clientId = String(process.env.PAYPAL_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '').trim();
  const baseUrl = String(process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').trim().replace(/\/+$/, '');
  const currency = String(process.env.SANDBOX_TEST_CURRENCY || 'USD').toUpperCase();

  console.log('PayPal Checkout capability check');
  console.log(`  base URL    : ${baseUrl}`);
  console.log(`  environment : ${classifyBaseUrl(baseUrl)}`);
  if (!clientId || !clientSecret) {
    console.log('\nPAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required.');
    process.exitCode = 1;
    return;
  }

  let token;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        Accept: 'application/json',
        'Accept-Language': 'en_US',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    const body = await response.json().catch(() => null);
    clearTimeout(timer);
    if (!response.ok || !body?.access_token) {
      console.log(`\nToken request failed: HTTP ${response.status} ${body?.error || ''} ${body?.error_description || ''}`.trim());
      process.exitCode = 1;
      return;
    }
    token = body.access_token;
  } catch (error) {
    console.log(`\nToken request failed: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
    process.exitCode = 1;
    return;
  }

  let response;
  let body;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    response = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `checkout-check-${Date.now()}`
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: 'Cashflow Copilot capability check (not captured)',
          amount: { currency_code: currency, value: '1.00' }
        }],
        application_context: { brand_name: 'Cashflow Copilot', user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING' }
      })
    });
    const text = await response.text();
    clearTimeout(timer);
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  } catch (error) {
    console.log(`\nOrder request failed: ${error.name === 'AbortError' ? 'timed out' : error.message}`);
    process.exitCode = 1;
    return;
  }

  const debugId = response.headers?.get?.('paypal-debug-id');
  console.log('\nOrder response');
  console.log(`  HTTP status            : ${response.status}`);
  console.log(`  PayPal-Debug-Id        : ${debugId || '(none)'}`);
  console.log(`  PayPal error           : ${body?.name || body?.error || '(none)'}`);
  console.log(`  PayPal error description: ${body?.message || body?.error_description || '(none)'}`);
  if (response.ok && body?.id) {
    console.log(`  order id               : ${body.id}`);
    console.log(`  order status           : ${body.status || 'CREATED'}`);
    console.log('\nResult: SUCCESS - Orders v2 is callable. A Checkout-only live demo is possible.');
    console.log('  This order was not captured; no money moved.');
    return;
  }
  console.log('\nResult: ORDERS CHECK FAILED');
  if (response.status === 403) {
    console.log('  The token cannot use Orders v2 either. This is an app/account capability issue.');
    console.log('  Use the debug id with PayPal support, or use a different sandbox Business account.');
  } else if (response.status === 401) {
    console.log('  The token was rejected. Re-run npm run paypal:check.');
  } else {
    console.log('  Check the PayPal error above and the app settings.');
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('paypal:checkout failed:', error.message);
  process.exitCode = 1;
});
