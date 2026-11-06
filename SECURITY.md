# Security policy

## Reporting a vulnerability

This is a hackathon prototype, not a production service. If you find a security
issue, please open a private security advisory on the GitHub repository rather
than a public issue. Do not include live credentials, customer data, or PayPal
access tokens in a report.

## Supported versions

| Version | Supported |
| --- | --- |
| `1.x` (current) | Yes |
| `< 1.0` | No |

## Security controls in the app

### Secrets

- PayPal and AI credentials are read from environment variables only.
- `/api/health` returns provider/model status but never a key, token, or secret.
- Logs contain an error code or name, never a request body or provider response.
- `scripts/sandbox-check.js` records `PayPal-Debug-Id` values but no credentials or headers.
- `.env`, `data/`, and temporary files are gitignored.

### Money and state

- All totals are recalculated server-side in integer cents; client- and
  model-supplied totals are ignored.
- Lifecycle transitions are monotonic; duplicate sends are locked; stale webhook
  events cannot regress a terminal invoice.
- Payment capture and webhook recording are idempotent.
- The public pay projection excludes PayPal ids, order ids, and the audit trail.

### Agent boundary

- The planner can only propose five tools: `remind_invoice`, `send_invoice`,
  `cancel_invoice`, `create_payment_link`, `draft_invoice`.
- Model-proposed invoice ids must exist in the store; unknown tools are dropped.
- Plans expire after 15 minutes and execute only explicitly approved step ids.
- Policy decisions are made outside the model.

### HTTP

- CSP with `script-src 'self'`; `style-src` allows inline styles because AG Grid
  injects theme CSS at runtime.
- `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `Permissions-Policy`, COOP/CORP.
- Same-origin enforcement on mutating requests (Origin and `Sec-Fetch-Site`).
- Per-IP rate limits for reads, writes, payment routes, and webhooks.
- Request bodies are capped at 1 MB and must be valid JSON.
- Static file serving resolves paths and rejects traversal.
- Optional bearer token (`DEMO_RESET_SECRET`) protects the demo reset route.

### PayPal webhooks

- The five `PayPal-*` signature headers and `PAYPAL_WEBHOOK_ID` are required.
- Verification is delegated to PayPal's
  `/v1/notifications/verify-webhook-signature`.
- The certificate URL must be HTTPS on `*.paypal.com`, `*.paypalobjects.com`, or
  `*.paypal.cn`; otherwise verification is rejected before the outbound request.
- Event ids are deduplicated; unsupported events are acknowledged without a
  state change; stale events are recorded as ignored.

### Storage

- Optional JSON persistence writes atomically (temporary file + rename) and is
  debounced.
- No secrets are written to the data file.
- In-memory state is the default and is clearly disclosed.

## Known limitations (prototype boundaries)

- No user accounts, roles, or multi-tenancy. Anyone who can reach the demo can
  create demo invoices and send mock actions.
- Rate limits are per process and in-memory; a multi-instance deployment needs a
  shared limiter.
- The demo seeds synthetic data; do not put real customer data in a public demo.
- No CSRF token beyond same-origin/fetch-metadata checks; a production app should
  use a session-bound token.
- No audit-log signing or external timestamping; the hash chain is tamper-evident
  within the app's own store, not a third-party-attested log.
- PayPal Sandbox only; production PayPal onboarding, KYC, and compliance are out
  of scope.
- AI output is validated, but the planner's natural-language answer is not a
  licensed financial advisor's advice.

## Production checklist

If this prototype were moved toward production:

- [ ] Add authenticated merchant accounts and role-based access.
- [ ] Move state to a transactional database with migrations.
- [ ] Use a shared rate limiter and CSRF tokens.
- [ ] Add structured audit export and external log retention.
- [ ] Add webhook replay protection backed by durable event storage.
- [ ] Review PayPal production onboarding, data-retention, and tax requirements.
- [ ] Add dependency and container scanning (there are no runtime dependencies,
  but the vendored AG Grid bundle and base image should be scanned).
- [ ] Perform an independent security review.
