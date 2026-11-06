# Product thesis

## The problem

For a freelancer or small studio, accounts receivable is not an invoicing problem.
It is an attention problem:

- Which invoice is actually late versus merely not paid yet?
- Which client habitually pays 12 days after the due date?
- Which reminder is allowed by my own policy, and which is nagging?
- Did the payment actually arrive, or did I mark it paid because a client said so?

Existing tools answer one slice: invoicing software sends invoices, dashboards
show totals, and generic AI chat can write text. None of them owns the loop from
**intent → validated action → PayPal execution → verified outcome**, with the
human in the middle.

## The product

Cashflow Copilot is an accounts-receivable operator for a small merchant:

1. The merchant describes work in natural language.
2. An AI extractor produces a validated, editable invoice proposal; the server
   recalculates all totals.
3. The merchant approves and PayPal Invoicing sends it.
4. The copilot ranks the invoices that need attention, explains why, applies the
   merchant's collections policy, and predicts when each one will actually be paid
   from that payer's history.
5. The merchant approves specific actions; the agent executes only those.
6. PayPal webhooks and checkout captures close the loop; every event is
   hash-chained.

The customer side is a hosted page where the invoice can be paid with PayPal
Checkout, so the product is two-sided rather than merchant-only.

## Why this is the right wedge

| Direction | Why not |
| --- | --- |
| Conversational shopping | Buyer-side agentic commerce is exciting but the hackathon's PayPal access for agentic checkout is onboarding-gated, and the demo risk is high |
| Fraud detection | Needs labeled data and real transaction streams; a short build cannot produce credible evidence |
| Split payments / marketplace payouts | High partner-onboarding and multi-account setup risk |
| **Accounts receivable** | Real pain, PayPal Invoicing is available today, events are verifiable, and the workflow is demoable end-to-end in under three minutes |

The differentiator is not "AI writes an invoice." It is **a bounded financial
agent with a measurable forecast and a verifiable audit trail**.

## Design principles

1. **The model proposes; the human approves.** No invoice, reminder, cancellation,
   or payment link is created without an explicit action.
2. **Money arithmetic is code, not model output.** Every total is recalculated in
   integer cents on the server.
3. **Policy is data.** Reminder limits, cooldowns, and send caps live in a JSON
   file the merchant can read and change.
4. **Every claim has a source.** Event provenance distinguishes seed, simulated,
   PayPal, verified webhook, and Copilot-approved actions.
5. **Evidence over adjectives.** Tests, a committed backtest, an OpenAPI
   contract, and a live-vs-demo table.
6. **The demo must run with zero credentials.** The deterministic path is a
   first-class product, not a fallback afterthought.

## What is deliberately out of scope

- Multi-tenant auth and roles (a prototype boundary, disclosed).
- Production durable storage (optional JSON persistence is provided).
- Tax filing, accounting reconciliation, and bank feeds.
- Fully autonomous collection without approval.
- AP2/verifiable-credential implementation (the trust loop is aligned; the
  protocol is not implemented).

## Success criteria (met)

- [x] Runs offline with no keys and a credible seeded merchant dashboard.
- [x] Natural language becomes a validated, editable invoice.
- [x] Send/remind/cancel through mock and PayPal Sandbox adapters.
- [x] Verified webhook path with idempotency and stale-event protection.
- [x] Explainable risk, policy decisions, and payer-adjusted forecast.
- [x] Agent plan with per-step approval and allowlisted tools.
- [x] Hosted customer pay page with PayPal Checkout.
- [x] Hash-chained audit trail.
- [x] 58 offline tests, 16 golden evaluation cases, a reproducible backtest.
- [x] OpenAPI contract, APIMatic build directory, Render Blueprint, Dockerfile,
      Postman collection.
