# Final handoff: Cashflow Copilot

## Product position

Cashflow Copilot is not an AI invoice generator. It is a **human-controlled cashflow operator** for independent businesses:

1. A merchant describes the work that needs to get paid.
2. AI turns that intent into an editable, validated proposal.
3. The merchant approves the action.
4. PayPal sends the invoice or reminder.
5. PayPal events are verified before they change state.
6. The Copilot explains the next highest-impact cashflow action.

The product's strongest submission story is the visible closed loop: **Signal → Approve → PayPal → Verify**.

## What is implemented

- PayPal Invoicing v2 create, send, and remind adapters.
- OAuth 2.0 token acquisition for PayPal Sandbox.
- Strict invoice validation and cent-safe totals.
- Monotonic lifecycle: `DRAFT → SENT → PAID/CANCELLED/VOID`.
- Duplicate-send protection and stale webhook protection.
- Idempotent simulated and verified webhook events.
- PayPal signature verification route.
- Explainable risk, urgency, confidence, reason codes, and 7/14/30-day projections.
- OpenAI-compatible structured extraction with deterministic fallback.
- 10-second bounded outbound requests with configurable maximum of 120 seconds.
- Secret-free `/api/health` endpoint.
- Senior-style command-center UX with provenance labels, trust loop, queue, forecast, detail drawer, timeline, focus management, and reduced-motion support.
- Postman collection for local, PayPal Sandbox, and verified webhook flows.

## Final demo script (under 3 minutes)

### 0:00–0:20 — Problem

“Small businesses do not need another text generator. They need to know which payment deserves attention next.”

Point at the Copilot queue and the overdue Acme invoice.

### 0:20–1:05 — AI intent to reviewable action

Enter:

```text
Invoice Acme Design Co <accounts@acme.example> for 2 brand review sessions at $125 each, tax 8%, due in 15 days
```

Show the extracted fields, calculated total, editable line items, and the approval gate. Say:

“The model can propose. It cannot silently send.”

### 1:05–1:35 — PayPal action

Approve the invoice. Show the mode label:

- `SANDBOX MODE · PayPal API` when credentials are configured, or
- `MOCK MODE · SYNTHETIC DATA` when running the resilient offline demo.

Never describe mock mode as a live PayPal transaction.

### 1:35–2:10 — Signal to action

Open the invoice control room, show the lifecycle timeline, risk reason, confidence, and reminder action. Send a reminder only after confirmation.

### 2:10–2:45 — Close the loop

Use **Replay demo payment webhook** only when the live webhook is not configured. It is explicitly labeled simulated. In the live Sandbox version, show the verified event marker and event ID.

End with:

“Cashflow Copilot turns a sentence into a reviewable PayPal action, then turns verified payment events into a calm, explainable collection plan.”

## Manual blockers before submission

These cannot be completed safely without the owner's credentials and deployment choices:

1. Create a PayPal Developer Sandbox REST app.
2. Configure `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` as deployment secrets.
3. Create sandbox business and payer accounts.
4. Run a real Sandbox invoice create/send/remind flow.
5. Deploy to public HTTPS.
6. Create a PayPal webhook subscription pointing to `/api/webhooks/paypal`.
7. Set `PAYPAL_WEBHOOK_ID`.
8. Configure `OPENAI_API_KEY`, or an OpenAI-compatible provider through `OPENAI_BASE_URL` and `OPENAI_MODEL`.
9. Record the final video and submit the public URL/write-up on Devpost.
10. Re-check the live rules, sponsor list, deadline, and required deliverables immediately before submission.

## Local verification

The repository's Node shim currently points at Node 22, which is not installed in the worker. The equivalent checks were run with the installed Node 24 binary:

```text
14 tests passed
npm run check passed
git diff --check passed
Postman collection JSON parsed successfully
Runtime HTTP smoke test passed
```

Docker was not available in the worker, so `docker build` remains a manual check.
