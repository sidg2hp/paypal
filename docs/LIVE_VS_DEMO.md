# Live vs demo: the claim boundary

This project is designed so a judge can run it with **zero credentials** and still
see the full product loop, while never being misled about what is real.

The UI always shows the active adapter (`MOCK MODE` or `SANDBOX MODE`), the
source of the data, and the provenance of every event. This document is the
long-form version of those labels.

## The two modes

| | Demo mode (default) | PayPal Sandbox mode |
| --- | --- | --- |
| Trigger | No `PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` | Both credentials set |
| Adapter | `MockPayPalAdapter` | `PayPalSandboxAdapter` |
| Invoice create/send/remind/cancel | In-process mock | PayPal Invoicing v2 REST |
| Checkout | Mock order + mock capture | PayPal Orders v2 REST, buyer approves on PayPal |
| Payment events | `POST /api/webhooks/simulate` (labelled simulated) | PayPal webhook, signature verified before state change |
| Data | Seeded synthetic invoices, relative to today | Seeded synthetic invoices until you create your own |
| Secrets required | None | PayPal client id + secret; webhook id for webhooks |
| Money moves | No | Yes, sandbox money only |

## What is verified by automated tests

These claims are pinned by `npm test` (58 tests, offline):

- Natural-language parsing for the exact demo prompts and eight other goldens.
- Cent-safe totals and strict invoice validation.
- Per-item PayPal tax allocation, so the PayPal invoice total equals the app total.
- Mock create/send/remind/cancel and checkout capture.
- PayPal endpoint paths, OAuth shape, and certificate-host allowlist with injected fetch.
- Webhook duplicate, stale, refund, and unsupported-event handling.
- Signature-gated webhook ingestion and a forged certificate URL rejection.
- Policy rules: cooldown, minimum amount, reminder limit, send cap.
- Payer-aware forecast and backtest.
- SHA-256 audit-chain verification and tamper detection.
- File persistence round-trip.
- HTTP security headers, same-origin enforcement, 404/405, rate limiting, and pay-page serving.

## What is **not** verified in this repository

These require the owner's PayPal account and public deployment. Do not claim them
until the evidence exists:

- A real PayPal Sandbox invoice create/send/read/remind run.
- A real PayPal Checkout approval and capture.
- A real PayPal webhook delivery with signature verification.
- A live AI provider response in the recording (the deterministic fallback is what runs by default).

Use [`scripts/sandbox-check.js`](../scripts/sandbox-check.js) to produce real
invoicing evidence and commit it under [`docs/sandbox-evidence/`](sandbox-evidence/).
Capture a screenshot of the PayPal Developer Dashboard and the verification
response for the video's "depth" beat.

## Exact points to state in the video / write-up

Say:

> "In this recording the app is in sandbox mode for invoice actions; the payment
> event you see is a verified PayPal webhook" (only if it is), or
> "In this recording the app is in demo mode; the payment event is a clearly
> labelled simulation. The sandbox path is implemented and tested, and here is
> the evidence file from a real sandbox run."

Do not say:

- "Fully production ready." It is a prototype with in-memory state by default.
- "Verified by PayPal" when the event came from `/api/webhooks/simulate`.
- "Autonomous agent that pays invoices." The agent proposes; the human approves.
- "Real customer data" — the demo data is synthetic and the repo contains no customer data.

## Why this boundary exists

The hackathon asks for a working prototype, and judges explicitly reward honest,
runnable evidence. The product's trust story only works if the labels are true:
if a simulated event were presented as live, the "verified outcome" claim would
collapse. The mode banner, event source labels, and this table are part of the
design, not a disclaimer bolted on at the end.
