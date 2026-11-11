# PayPal Sandbox setup and evidence

This is the complete path from a fresh PayPal Developer account to a real,
committed sandbox evidence run.

## 1. Create the developer app

1. Sign in at <https://developer.paypal.com/dashboard/>.
2. Open **Apps & Credentials** and make sure **Sandbox** is selected.
3. Create an app (for example `cashflow-copilot`).
4. Copy the **Client ID** and **Secret**. These are sandbox-only.

## 2. Run the app against sandbox

```sh
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm start
```

Check the mode is live:

```sh
curl -s http://localhost:3000/api/health | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const j=JSON.parse(d);console.log(j.mode,j.adapter,j.capabilities.checkout)})"
# sandbox paypal-sandbox true
```

The sidebar, banner, and `/api/health` should all say sandbox. If they still say
mock, one of the two credentials is missing.

## 3. Create and send a real sandbox invoice

In the UI:

1. **Draft an invoice** → enter a sandbox buyer email.
2. Review the extracted fields and totals.
3. **Approve & send with PayPal**.
4. Open the invoice drawer and confirm the PayPal invoice id is present.

Or use the collection: [`postman/PayPal-Cashflow-Copilot.postman_collection.json`](../postman/PayPal-Cashflow-Copilot.postman_collection.json),
folder **2. PayPal Sandbox Invoicing v2**.

## 4. Generate committed evidence

```sh
PAYPAL_CLIENT_ID=... \
PAYPAL_CLIENT_SECRET=... \
SANDBOX_TEST_EMAIL=sb-buyer@business.example.com \
npm run sandbox:check
```

The script:

1. Creates a draft through the app.
2. Sends it through PayPal Invoicing v2.
3. Reads it back with `GET /v2/invoicing/invoices/{id}` and records the remote status/total.
4. Sends a reminder.
5. Verifies the local hash chain.
6. Writes `docs/sandbox-evidence/<timestamp>.json` with `PayPal-Debug-Id` values.

Review the file, then commit it. It contains no secrets or headers.

## 5. Real webhooks

PayPal cannot call `localhost`. You need a public HTTPS origin:

- Deploy to Render (see [`DEPLOY.md`](DEPLOY.md)), or
- Use a tunnel for a local run.

Then:

1. Developer Dashboard → your app → **Webhooks** → **Add webhook**.
2. URL: `https://YOUR_HOST/api/webhooks/paypal`.
3. Subscribe to:
   - `INVOICING.INVOICE.SENT`
   - `INVOICING.INVOICE.PAID`
   - `INVOICING.INVOICE.CANCELLED`
   - `INVOICING.INVOICE.VOIDED`
   - `INVOICING.INVOICE.REFUNDED`
   - `PAYMENT.CAPTURE.COMPLETED`
4. Copy the **Webhook ID** into `PAYPAL_WEBHOOK_ID`.
5. Trigger a real event (send an invoice, or pay it with a sandbox buyer account).
6. Confirm the invoice timeline shows **Verified PayPal webhook** and an event id.

The verifier calls PayPal's `/v1/notifications/verify-webhook-signature` and
restricts the certificate URL to `*.paypal.com`, `*.paypalobjects.com`, and
`*.paypal.cn` over HTTPS.

## 6. Real checkout

1. Send an invoice.
2. Open the drawer → **Create payment link**.
3. Open the hosted pay page.
4. In sandbox mode the button redirects to PayPal; approve with a sandbox personal account.
5. On return the app captures the order and moves the invoice to PAID.

If the capture fails, check:

- The buyer actually approved the order.
- `PUBLIC_BASE_URL` matches the origin PayPal redirects back to.
- The order has not already been captured (duplicate captures return `duplicate: true`).

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Still `mock` mode | One credential missing, or env not exported into the server process |
| `PayPal authentication failed` | Credentials do not match the environment, or the secret is masked/truncated |
| `PayPal request failed (422)` | Invalid invoice payload (check the recipient email and item amounts) |
| `PayPal request failed (404)` | Invoice id belongs to a different environment |
| Webhook 401 | Missing `PAYPAL-*` headers, wrong `PAYPAL_WEBHOOK_ID`, or verification failed |
| Webhook accepted but no state change | Event is a duplicate or stale for the current lifecycle status |
| Checkout capture fails | Buyer never approved, or the order expired (PayPal orders expire) |

### `PayPal authentication failed` (401 `invalid_client`)

This is an OAuth failure, not an invoice failure. The app never reached the
invoice endpoint. Diagnose it with:

```sh
npm run paypal:check
```

It prints the HTTP status, PayPal error code/description, and
`PayPal-Debug-Id` without printing the credentials. Then check:

1. **Wrong dashboard tab.** Apps & Credentials has separate **Sandbox** and
   **Live** tabs. The app defaults to `https://api-m.sandbox.paypal.com`.
   Live credentials produce `invalid_client`. Copy from the Sandbox tab.
2. **Masked secret.** Click **Show** before copying. Masked dots are not a valid
   secret even though the string is non-empty.
3. **`PAYPAL_BASE_URL` mismatch.** Unset it to use the sandbox default, or set it
   to the same environment as the credentials.
4. **PowerShell interpolation.** Double quotes expand `$` inside a secret. Use:
   ```powershell
   $env:PAYPAL_CLIENT_ID = '...'
   $env:PAYPAL_CLIENT_SECRET = '...'
   ```
5. **Whitespace/quotes.** Remove labels, angle brackets, surrounding quotes, and
   internal newlines. The adapter trims leading/trailing whitespace only.
6. **Secret rotated or app deleted.** Regenerate the secret or create a new
   Sandbox REST app.
7. **Server not restarted.** Environment variables are read at process start.

Confirm the resulting mode with:

```sh
curl -s http://localhost:3000/api/health
```

Look for `"mode": "sandbox"` and `"paypal": { "environment": "sandbox" }`.

### `PayPal request failed (403 NOT_AUTHORIZED)`

Authentication worked, but PayPal refused the Invoicing call. The token's
`scope` list is the authoritative answer. `npm run paypal:check` now requests a
token and makes a read-only Invoicing call, then prints:

- whether `https://uri.paypal.com/services/invoicing` is present,
- the Invoicing HTTP status and `PayPal-Debug-Id`.

If the scope is **MISSING**:

1. Apps & Credentials -> your app -> Features / Products / Scopes.
2. Enable **Invoicing** for the Sandbox environment.
3. If there is no Invoicing toggle, the app type is wrong (for example a
   Platform/Partner app). Create a standard **Merchant** REST app.
4. If **Sandbox Accounts** shows only a **Personal** account, that is the cause:
   Invoicing requires a sandbox **Business** merchant. Create a Business account,
   then create a new app and use its credentials.
5. Activate Invoicing on the Business merchant: log into
   <https://www.sandbox.paypal.com> with the business account, open **Invoicing**
   (or **Tools -> Invoicing**), and complete any setup/terms prompt.
6. Restart the server so a fresh token is requested.

If the scope is **PRESENT** but the call is still 403:

1. Confirm the sandbox merchant is a confirmed **Business** account.
2. Confirm the app is linked to a merchant that can invoice.
3. Check whether the account/country is eligible for Invoicing.
4. Create a fresh Sandbox Merchant app and Business account.
5. If it still fails, open a support case with the `PayPal-Debug-Id`; do not
   send the client secret.

Do not confuse this with `PayPal authentication failed`: that is a 401 on the
token endpoint. A 403 on `/v2/invoicing/invoices` is a permission/capability
problem.

## What to commit

- `docs/sandbox-evidence/*.json` from a successful run.
- A screenshot of the PayPal Developer Dashboard invoice list for the video.
- Do **not** commit `.env`, client ids, secrets, access tokens, or headers.

## What not to claim

A mocked unit test is not a live run. The README's live-vs-demo table is the
claim boundary; keep it accurate.
