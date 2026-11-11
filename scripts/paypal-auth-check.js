'use strict';

/**
 * PayPal credential diagnostic.
 *
 * Reads PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET / PAYPAL_BASE_URL from the
 * environment, requests an OAuth token, and prints a safe diagnosis. It never
 * prints the client id or secret, only lengths and shape warnings.
 *
 * Usage:
 *   PowerShell:  $env:PAYPAL_CLIENT_ID='...'; $env:PAYPAL_CLIENT_SECRET='...'; npm run paypal:check
 *   bash:        PAYPAL_CLIENT_ID='...' PAYPAL_CLIENT_SECRET='...' npm run paypal:check
 */

function classifyBaseUrl(baseUrl) {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    if (host.includes('sandbox')) return { environment: 'sandbox', live: false };
    if (host === 'api-m.paypal.com' || host === 'api.paypal.com') return { environment: 'live', live: true };
    return { environment: 'custom', live: false };
  } catch {
    return { environment: 'invalid', live: false };
  }
}

async function checkInvoicing(baseUrl, accessToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${baseUrl}/v2/invoicing/invoices?page_size=1&page=1`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }
    });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return {
      ok: response.ok,
      status: response.status,
      debugId: response.headers.get('paypal-debug-id'),
      paypalError: body?.name || body?.error || null,
      description: body?.message || body?.error_description || null
    };
  } catch (error) {
    return { ok: false, network: true, message: error.name === 'AbortError' ? 'request timed out' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

function shapeWarnings(name, value) {
  const warnings = [];
  if (!value) return warnings;
  if (value !== value.trim()) warnings.push(`${name} has leading/trailing whitespace`);
  if (/^['"]|['"]$/.test(value)) warnings.push(`${name} starts or ends with a quote`);
  if (/\.\.\.|<|>|your[-_ ]|changeme|xxxx/i.test(value)) warnings.push(`${name} looks like a placeholder`);
  if (/[*•]/.test(value)) warnings.push(`${name} looks masked; click Show/Copy in the PayPal dashboard`);
  if (/[^\x20-\x7E]/.test(value)) warnings.push(`${name} contains non-ASCII characters`);
  if (/\s/.test(value)) warnings.push(`${name} contains an internal space or newline`);
  return warnings;
}

async function main() {
  const rawClientId = String(process.env.PAYPAL_CLIENT_ID || '');
  const rawClientSecret = String(process.env.PAYPAL_CLIENT_SECRET || '');
  const clientId = rawClientId.trim();
  const clientSecret = rawClientSecret.trim();
  const baseUrl = String(process.env.PAYPAL_BASE_URL || 'https://api-m.sandbox.paypal.com').trim().replace(/\/+$/, '');
  const environment = classifyBaseUrl(baseUrl);

  console.log('PayPal credential check');
  console.log(`  base URL      : ${baseUrl}`);
  console.log(`  environment   : ${environment.environment}`);
  console.log(`  client id     : ${clientId ? `set (${clientId.length} chars)` : 'MISSING'}`);
  console.log(`  client secret : ${clientSecret ? `set (${clientSecret.length} chars)` : 'MISSING'}`);
  console.log(`  webhook id    : ${process.env.PAYPAL_WEBHOOK_ID ? 'set' : 'not set (fine for auth; required for verified webhooks)'}`);

  const warnings = [
    ...shapeWarnings('PAYPAL_CLIENT_ID', rawClientId),
    ...shapeWarnings('PAYPAL_CLIENT_SECRET', rawClientSecret)
  ];
  if (environment.environment === 'invalid') warnings.push('PAYPAL_BASE_URL is not a valid URL');
  if (environment.live) warnings.push('PAYPAL_BASE_URL points at LIVE PayPal; this project is designed for sandbox');
  if (warnings.length) {
    console.log('\nWarnings');
    for (const warning of warnings) console.log(`  ! ${warning}`);
  }

  if (!clientId || !clientSecret) {
    console.log('\nSet both PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, then re-run.');
    console.log("PowerShell (single quotes prevent $ interpolation):");
    console.log("  $env:PAYPAL_CLIENT_ID = 'your-sandbox-client-id'");
    console.log("  $env:PAYPAL_CLIENT_SECRET = 'your-sandbox-secret'");
    process.exitCode = 1;
    return;
  }

  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  let response;
  let text;
  try {
    response = await fetch(`${baseUrl}/v1/oauth2/token`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Basic ${authorization}`,
        Accept: 'application/json',
        'Accept-Language': 'en_US',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: 'grant_type=client_credentials'
    });
    text = await response.text();
  } catch (error) {
    clearTimeout(timer);
    console.log('\nResult: NETWORK/TLS FAILURE');
    console.log(`  ${error.name === 'AbortError' ? 'request timed out' : error.message}`);
    console.log('  Check internet access, a corporate proxy, or a firewall blocking api-m.sandbox.paypal.com.');
    process.exitCode = 1;
    return;
  }
  clearTimeout(timer);

  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const debugId = response.headers.get('paypal-debug-id');
  const paypalError = body?.error || body?.name || null;
  const description = body?.error_description || body?.message || null;

  console.log('\nToken endpoint response');
  console.log(`  HTTP status            : ${response.status}`);
  console.log(`  PayPal-Debug-Id        : ${debugId || '(none)'}`);
  console.log(`  PayPal error           : ${paypalError || '(none)'}`);
  console.log(`  PayPal error description: ${description || '(none)'}`);

  if (response.ok && body?.access_token) {
    console.log(`  access token           : received (${String(body.access_token).length} chars, expires in ${body.expires_in || '?'}s)`);
    const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [];
    const invoicingScope = 'https://uri.paypal.com/services/invoicing';
    const hasInvoicingScope = scopes.includes(invoicingScope);
    console.log(`  scopes                 : ${scopes.length || 'not returned by PayPal'}`);
    if (scopes.length) console.log(`  Invoicing scope        : ${hasInvoicingScope ? 'PRESENT' : 'MISSING'}`);

    console.log('\nInvoicing API check (GET /v2/invoicing/invoices?page_size=1)');
    const invoicing = await checkInvoicing(baseUrl, body.access_token);
    if (invoicing.network) {
      console.log(`  network failure        : ${invoicing.message}`);
      console.log('\nResult: TOKEN OK, INVOICING CHECK FAILED');
      console.log('  Authentication succeeded, but the capability check could not reach PayPal.');
      process.exitCode = 1;
      return;
    }
    console.log(`  HTTP status            : ${invoicing.status}`);
    console.log(`  PayPal-Debug-Id        : ${invoicing.debugId || '(none)'}`);
    console.log(`  PayPal error           : ${invoicing.paypalError || '(none)'}`);
    console.log(`  PayPal error description: ${invoicing.description || '(none)'}`);

    if (invoicing.ok) {
      console.log('\nResult: SUCCESS - authentication works and the Invoicing API is callable.');
      if (environment.environment === 'sandbox') console.log('  The app should switch to SANDBOX MODE after a restart.');
      return;
    }

    console.log('\nResult: AUTHENTICATION OK, INVOICING PERMISSION FAILED');
    if (invoicing.status === 403 || invoicing.paypalError === 'NOT_AUTHORIZED') {
      if (hasInvoicingScope) {
        console.log('  The token contains the Invoicing scope, but PayPal still refused the call.');
        console.log('  Most likely causes:');
        console.log('  1. The app is a Platform/Partner app, not a Merchant REST app.');
        console.log('     Create a standard Merchant app under Apps & Credentials.');
        console.log('  2. The sandbox merchant account is not a confirmed Business account.');
        console.log('     Open Accounts -> Sandbox, create/confirm a Business account, and use an app');
        console.log('     linked to a merchant that can invoice.');
        console.log('  3. The account or country is not eligible for Invoicing.');
        console.log('     Check the Invoicing eligibility list or contact PayPal support with the debug id.');
      } else if (scopes.length) {
        console.log('  The OAuth token does NOT include https://uri.paypal.com/services/invoicing.');
        console.log('  The app authenticated, but its enabled products/scopes do not include Invoicing.');
        console.log('  1. Open Apps & Credentials -> your app -> Features / Products / Scopes.');
        console.log('  2. Enable Invoicing for the Sandbox environment (and Checkout if you use Orders v2).');
        console.log('  3. If there is no Invoicing toggle, create a new Sandbox Merchant REST app.');
        console.log('  4. Restart the server so a fresh token is requested, then retry.');
        console.log('  5. If Sandbox Accounts shows ONLY a Personal account, that is the cause:');
        console.log('     Invoicing requires a sandbox BUSINESS merchant. Create a Business account,');
        console.log('     then create a new app and use its credentials.');
      } else {
        console.log('  PayPal did not return a scope list, so the cause is likely app type or account eligibility.');
        console.log('  Create a standard Sandbox Merchant REST app linked to a confirmed Business account.');
      }
      console.log('  Then rerun this check. The debug id above is the value to give PayPal support.');
    } else if (invoicing.status === 401) {
      console.log('  The access token was rejected on the API call even though the token request succeeded.');
      console.log('  Regenerate the app credentials and retry.');
    } else {
      console.log('  Compare the PayPal error above with the app settings and the Invoicing API docs.');
    }
    process.exitCode = 1;
    return;
  }

  console.log('\nResult: AUTHENTICATION FAILED');
  if (response.status === 401 || paypalError === 'invalid_client') {
    console.log('  The credentials were rejected by this PayPal environment. Most likely causes:');
    console.log('  1. Live credentials were copied while the app calls sandbox (or the reverse).');
    console.log('     Open Apps & Credentials and confirm the SANDBOX tab is selected before copying.');
    console.log('  2. The secret was copied while masked, truncated, or contains a newline.');
    console.log('     Click Show/Copy next to the secret, or regenerate it and update the env var.');
    console.log('  3. PAYPAL_BASE_URL points at a different environment than the credentials.');
    console.log('     Unset PAYPAL_BASE_URL to use the sandbox default.');
    console.log('  4. The credentials belong to a deleted or disabled app.');
    console.log('     Create a new Sandbox REST app and use its client id + secret.');
    console.log('  5. PowerShell expanded a $ inside the secret.');
    console.log("     Use single quotes: $env:PAYPAL_CLIENT_SECRET = '...'");
  } else if (response.status === 400) {
    console.log('  PayPal rejected the request shape. Do not wrap values in quotes and do not paste labels.');
  } else if (response.status === 403) {
    console.log('  The app or account is restricted. Check the app status in the PayPal Developer Dashboard.');
  } else {
    console.log('  Compare the exact PayPal error above with the PayPal Developer Dashboard app settings.');
  }
  console.log('  Then restart the server (env changes are read at process start) and run this check again.');
  process.exitCode = 1;
}

main().catch((error) => {
  console.error('paypal:check failed:', error.message);
  process.exitCode = 1;
});
