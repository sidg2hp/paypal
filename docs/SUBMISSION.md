# Devpost submission pack

Everything below is ready to paste into the Devpost form. Replace the two
placeholder URLs (hosted demo and video) only after they exist and are public.

**Deadline:** November 12, 2026, 12:00 pm PT (November 13, 01:30 IST). The
submission locks after that; do not edit the repo or video until winners are
announced on December 21, 2026.

## Fields

**Project name**

> Cashflow Copilot

**Elevator pitch (short)**

> The AI accounts-receivable operator for PayPal. It predicts when each invoice
> will actually be paid, proposes the one action that moves cash this week, and
> executes it through PayPal only after you approve. Every step is explainable,
> policy-gated, and hash-chained.

**Repository**

> https://github.com/sidg2hp/paypal

**Hosted demo**

> `TODO: paste the Render URL` — set `DEMO_RESET_SECRET` before sharing.

**Video**

> `TODO: paste the public YouTube URL` (under 3 minutes)

**Built with**

> PayPal Invoicing v2, PayPal Orders v2 (Checkout), PayPal Webhooks v1,
> Node.js 22, vanilla JavaScript, AG Grid Community, APIMatic (OpenAPI 3.1 +
> PayPal Server SDK Context Plugin), Render, Postman, OpenAI-compatible LLMs
> (OpenAI / xAI / Gemini / local Ollama), SHA-256.

**Tools used (AI)**

> Cashflow Copilot uses an LLM as a **planner and extractor**, not as an
> unconstrained actor.
>
> - **Extraction:** an OpenAI-compatible chat-completions model turns a sentence
>   into strict invoice JSON. The response is schema-validated; every total is
>   recalculated server-side in integer cents. Any provider error, timeout, or
>   malformed response falls back to a deterministic parser.
> - **Planning:** the agent receives a compact snapshot of invoices, payer
>   history, and policy, and returns JSON with an answer plus proposed actions.
>   Only five tools are allowed, every invoice id must exist, and nothing
>   executes until the merchant approves specific step ids.
> - **Providers:** OpenAI, xAI/Grok, Gemini/Google, or local Ollama. Selection is
>   explicit or automatic (configured cloud key first, then a bounded local
>   Ollama probe), with the provider/model/fallback shown in the UI.
> - **Measured quality:** `npm run eval` runs 16 golden parser/planner cases
>   offline; 16/16 pass. The deterministic fallback is what runs in the no-key
>   demo, and the UI labels it honestly.

## About the project (paste as-is)

### The problem

Small businesses do not fail because they cannot write an invoice. They lose
momentum because they do not know **which payment deserves attention next** —
and because the tools that could act on that signal are either dashboards that
stop at a chart or agents that are not accountable enough to trust with money.

Cashflow Copilot is an accounts-receivable operator for freelancers and small
studios. It turns intent into a reviewable PayPal action, predicts when cash will
actually arrive, and closes the loop with verified payment events.

### What it does

1. **Intent → validated draft.** "Invoice Acme Design Co for 2 brand review
   sessions at $125 each, tax 8%, due in 15 days" becomes an editable invoice
   with customer, line items, tax, currency, due date, and a server-calculated
   total. The AI proposes; the server does the arithmetic.
2. **Risk → ranked next action.** Every open invoice gets risk, urgency,
   confidence, reason codes, and a plain-English explanation. A collections
   policy in `policies/collections.json` decides whether a reminder is allowed,
   on hold, or escalated — and the exact rule id and numeric inputs travel with
   the recommendation.
3. **Payer-aware forecast.** The forecast is not "due date plus hope." It is
   `due date + median observed lateness for that payer`, with a portfolio
   fallback and a visible confidence. On a deterministic synthetic backtest,
   this cuts mean absolute error for payment-date prediction by **70.4%** versus
   a due-date baseline (2.36 vs 7.98 days).
4. **Approval before execution.** The agent returns a plan, not an action. The
   merchant ticks the steps they approve; only those step ids execute. Drafts
   and reminders require an explicit UI action.
5. **PayPal execution.** Invoicing v2 creates/sends/reminds/cancels. Orders v2
   creates a hosted checkout the customer can pay. Tax is allocated per item so
   the PayPal invoice total equals the app total.
6. **Verified close.** PayPal webhooks are verified through PayPal's
   `/v1/notifications/verify-webhook-signature` before any state change, with
   certificate-host allowlisting, duplicate event ids, and stale-event
   protection. Every timeline event is SHA-256 hash-chained; `GET /api/audit`
   recomputes the chain and reports the first broken link.

### Why it is different

The AR/invoicing cluster in this hackathon is crowded with "AI writes an
invoice" demos. This project owns the harder half:

- **A quantified forecast**, not a chart. The backtest is committed and
  reproducible.
- **Policy as data**, not a prompt. Every recommendation carries the rule that
  allowed or blocked it.
- **Two-sided PayPal**: the merchant uses Invoicing, the customer uses Checkout,
  and both meet at a verified capture.
- **A verifiable audit trail**, not a log line.
- **A real approval gate**: the model can propose, never execute.

### Architecture

- Node.js 22 HTTP server with **zero runtime dependencies**.
- `src/core.js` — validation, cent-safe totals, PayPal adapters, lifecycle.
- `src/agent.js` — deterministic and LLM planners, allowlisted step execution.
- `src/policy.js` — collections policy as data.
- `src/forecast.js` — payer statistics, expected payment date, backtest.
- `src/audit.js` — SHA-256 chain.
- `src/persistence.js` — optional atomic JSON persistence.
- `src/server.js` — routing, CSP/security headers, same-origin checks, rate limits.
- `public/` — command center, AG Grid ledger, hosted pay page.

### Evidence

- `npm test` — 59 offline tests.
- `npm run eval` — 16/16 golden parser/planner cases.
- `npm run backtest` — 70.4% MAE improvement (committed report).
- `npm run check` — syntax checks across every source file.
- `npm run sandbox:check` — produces real PayPal Sandbox evidence with
  `PayPal-Debug-Id` values (run before submission and commit the JSON).
- OpenAPI 3.1 contract in `openapi/`, validated with Redocly; APIMatic build
  directory and the official PayPal context plugin vendored for inspection.

### Honest boundaries

- Demo mode uses a mock PayPal adapter and is labelled as such everywhere.
- The default store is in memory; optional JSON persistence is documented.
- A real sandbox run is a documented manual step; the repo does not claim one
  until `docs/sandbox-evidence/` contains it.
- Cash forecasting is decision support, not financial advice.

### What's next

Signed agent mandates (AP2-aligned), durable storage, reminder scheduling,
dispute evidence, and outbound automations (Slack/Zapier) on the same audit
event stream.

## Suggested images for the Devpost gallery

Upload these in this order:

1. `docs/assets/dashboard.png` — the command center, forecast, queue, and AG Grid ledger.
2. `docs/assets/copilot-plan.png` — an agent plan with per-step approval.
3. `docs/assets/pay-page.png` — the customer-facing PayPal checkout page.
4. `docs/assets/audit-drawer.png` — the invoice control room with the verified hash chain.

Keep the mode banner visible in every screenshot; do not crop it out.

## Sponsor prizes to select on the form

- **AG Grid** — the receivables ledger is a real AG Grid with custom renderers.
- **APIMatic** — OpenAPI 3.1 contract + PayPal Server SDK Context Plugin.
- **Render** — one-click Blueprint with a health check.
- **Postman** — runnable collection for the local API and PayPal.

Prize stacking allows one Grand Prize or Honorable Mention plus one sponsor
prize, so selecting these does not reduce the overall prize eligibility.

## Pass/fail checklist (Stage One)

- [ ] Public GitHub repository with all source, assets, and instructions.
- [ ] Open-source license visible in the **About** sidebar of the repo (MIT).
- [ ] Functional demo: hosted URL **or** complete setup/run instructions (both provided).
- [ ] Working build, not a mockup: `npm start` runs the full loop offline.
- [ ] Public YouTube video, **under 3 minutes**, shows the project working.
- [ ] Text description explains features and functionality (above).
- [ ] Tools section identifies the AI models/services and how they are used (above).
- [ ] Meaningful use of PayPal and AI (Invoicing v2, Orders v2, Webhooks v1, LLM planner/extractor).
- [ ] No third-party trademarks or copyrighted music without permission.
- [ ] If teammates: invited **and** accepted on Devpost.
- [ ] Sponsor tools selected on the form.
- [ ] Demo, test credentials, and trials kept active until **December 21, 2026**.
- [ ] Repo and video frozen after submission until winners are announced.

## Final pre-submit commands

```sh
npm run verify
npm run backtest
npm run sandbox:check   # with sandbox credentials; commit the evidence JSON
docker build -t cashflow-copilot .   # optional
```

Then open the hosted URL in a clean browser, confirm the mode banner, reset the
demo, and record the video against the hosted URL.
