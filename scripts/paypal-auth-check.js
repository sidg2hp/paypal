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
    console.log('\nResult: SUCCESS - these credentials can obtain a PayPal token.');
    if (environment.environment === 'sandbox') console.log('  The app should now switch to SANDBOX MODE after a restart.');
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
