# Final handoff

Status: **submission-ready code and documentation**, with a small number of
owner-only steps that require PayPal credentials, a hosted URL, and a recorded
video.

## What is implemented

- Natural-language invoice extraction with a deterministic offline fallback and
  OpenAI-compatible provider support, strict JSON validation, and visible provenance.
- PayPal Invoicing v2 create/send/read/remind/cancel, with per-item tax allocation
  so PayPal totals match the app.
- PayPal Orders v2 checkout: hosted customer pay page, order create/reuse,
  capture, and idempotent payment recording.
- Verified PayPal webhook ingestion with certificate-host allowlisting,
  duplicate event ids, stale-event protection, and refund support.
- Agent planner with five allowlisted financial tools, a 15-minute plan TTL,
  per-step approval, and deterministic fallback. Model output is validated
  against real invoice ids.
- Collections policy as data, with named rules and numeric inputs attached to
  every recommendation.
- Payer-aware forecast (`due date + median payer lateness`) with a committed,
  reproducible backtest (70.4% MAE improvement).
- SHA-256 hash-chained audit trail with on-demand verification.
- Optional atomic JSON persistence.
- Dashboard with AG Grid ledger, Copilot chat, queue, forecast, evidence panel,
  invoice drawer, audit timeline, and a customer pay page.
- Security: CSP, frame denial, nosniff, no-referrer, same-origin enforcement,
  per-IP rate limits, optional demo reset token, secret-free health.
- 59 offline tests, 16 golden evaluation cases, syntax checks, OpenAPI 3.1
  contract, APIMatic build directory and vendored PayPal context plugin,
  Render Blueprint, Dockerfile, Postman collection.

## What only the owner can do

1. Create a PayPal Developer Sandbox app and run
   `npm run sandbox:check` with the credentials. Commit the generated JSON under
   `docs/sandbox-evidence/`.
2. Run one real invoice create/send/remind and one real checkout capture against
   sandbox. Screenshot the dashboard for the video.
3. Create a webhook subscription pointing at the public HTTPS origin, set
   `PAYPAL_WEBHOOK_ID`, and confirm a verified event appears exactly once.
4. Deploy to Render (or another host) and confirm `/api/health`.
5. Record the under-three-minute video using `docs/DEMO_SCRIPT.md`, upload it
   publicly to YouTube, and paste the URL into Devpost.
6. Fill the Devpost form using `docs/SUBMISSION.md`, select the sponsor tools,
   and submit before **November 12, 2026, 12:00 pm PT**.
7. Keep the demo, credentials, and video live until **December 21, 2026**.

## Pre-submission checklist

### Build and tests

- [ ] Node 22+ installed.
- [ ] `npm ci` succeeds.
- [ ] `npm test` → 59 passing.
- [ ] `npm run eval` → 16/16.
- [ ] `npm run check` → clean.
- [ ] `npm run backtest` → writes the report with 70.4% improvement.
- [ ] `docker build -t cashflow-copilot .` succeeds (optional).

### Product

- [ ] `npm start` opens the dashboard with a visible mock/sandbox banner.
- [ ] The two exact demo prompts parse correctly.
- [ ] Chat plan returns steps and executes only approved ones.
- [ ] Draft → send → reminder → payment link → capture works.
- [ ] Verify audit chain returns valid; drawer shows event hashes.
- [ ] Reset demo reseeds four invoices relative to today.
- [ ] Mobile layout at 390 px is usable.

### PayPal

- [ ] Sandbox credentials select the sandbox adapter.
- [ ] Real create/send/read/remind succeeds.
- [ ] Sandbox evidence JSON committed.
- [ ] Webhook subscription verified; event appears once.
- [ ] Checkout redirects to PayPal and capture marks PAID.
- [ ] Forged/invalid webhook is rejected without state change.

### Repository

- [ ] Public GitHub repo.
- [ ] MIT license visible in the About sidebar.
- [ ] README quick start works from a clean clone.
- [ ] No secrets in the repo or git history (`git log -p | grep -i secret`).
- [ ] No `.env`, `data/`, or temporary screenshots committed.
- [ ] `docs/assets/dashboard.png` and `pay-page.png` render.

### Submission

- [ ] Hosted demo URL works in a clean browser.
- [ ] Video is public, under 3:00, and shows the product working.
- [ ] Devpost text uses `docs/SUBMISSION.md`.
- [ ] Sponsor tools selected.
- [ ] Teammates invited and accepted.
- [ ] Deadline confirmed on the live Devpost page.

## Local verification log

The repository was verified on Node 24.21.0 with `npm install`-free execution:

```text
59 tests passed
16/16 golden evaluation cases passed
npm run check passed
npm run backtest: 70.4% MAE improvement
OpenAPI 3.1: valid (Redocly, 0 errors, 18 style warnings)
Docker: not run in this environment (manual step)
Real PayPal sandbox: not run in this environment (manual step)
```

## What not to claim

- A live sandbox run before `docs/sandbox-evidence/` contains one.
- "Production ready." The default store is in memory and rate limits are per process.
- "Fully autonomous." The agent proposes; the merchant approves every step.
- "AP2 compliant." The trust loop is structurally aligned; AP2 is not implemented.
- "Verified webhook" for an event created by `/api/webhooks/simulate`.

## Final commands

```sh
npm run verify
npm run backtest
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm run sandbox:check
npm start
```
