# Agentic commerce alignment

PayPal's agentic-commerce work is built around a simple idea: an AI agent can
prepare a purchase, but the human must be able to see what is being agreed to and
approve it. Cashflow Copilot applies that same structure to accounts receivable.

> This document is a **design alignment**, not a claim that the app implements
> PayPal's AP2 protocol or verifiable credentials. The app uses PayPal Invoicing
> and Checkout today; AP2 is the vocabulary the trust loop maps onto.

## The mapping

| Agentic-commerce concept | Cashflow Copilot implementation |
| --- | --- |
| **Intent** — what the user wants | `POST /api/copilot/plan` takes a natural-language request and returns an `intent` plus an answer grounded in the merchant's actual invoices. |
| **Cart Mandate** — the exact, itemized thing being agreed to | The editable invoice: customer, line items, quantity, unit price, tax, currency, due date, and a server-recalculated total. The AI cannot send a total it invented. |
| **Payment Mandate** — the human's authorization for a specific payment action | The approval gate. A plan contains steps; `POST /api/copilot/execute` only runs the step ids the merchant selected. Drafts and reminders require an explicit UI action. |
| **Verifiable execution** — proof the action happened | PayPal webhook signature verification for state changes, plus a SHA-256 hash chain over every invoice event. `GET /api/audit` recomputes the chain and reports the first broken link. |
| **Agent-to-merchant boundary** — the agent never holds the money | The server holds no card data. PayPal processes the payment. The app stores invoice metadata and audit events, not payment credentials. |

## Why this framing is honest

The hackathon rewards projects that explore "new ways people, businesses, and AI
agents can interact with money and payments." The interesting problem is not
"can an LLM write an invoice" — it is "can an agent take a consequential financial
action without becoming an unaccountable black box?"

Cashflow Copilot's answer has four parts:

1. **A narrow tool allowlist.** The planner can only propose `remind_invoice`,
   `send_invoice`, `cancel_invoice`, `create_payment_link`, and `draft_invoice`.
   Unknown tools and invented invoice ids are dropped before the merchant sees them.
2. **Policy outside the model.** Collections rules live in
   `policies/collections.json`. A recommendation carries the named rule, the
   numeric inputs, and whether it was allowed. The model cannot talk its way past
   a reminder limit or a send cap.
3. **Per-step approval.** A plan is a proposal with a 15-minute TTL. Execution
   takes an explicit list of approved step ids and records every executed step in
   the audit chain.
4. **Evidence the merchant can check.** The invoice drawer shows the expected
   payment date and its basis, the policy decision, the event source (seed,
   simulated, PayPal, verified PayPal webhook), and the event hash.

## What a future AP2 integration would add

- **Signed mandates** instead of server-side plan ids, so approval travels with
  the request across systems.
- **Agent identity** for the merchant's copilot, so PayPal can distinguish a
  human-initiated action from an agent-initiated one.
- **Machine-verifiable receipts** for the audit chain, so a third party can verify
  the merchant's records without trusting the app's database.
- **Agentic checkout** where the buyer's agent negotiates and pays, with the
  merchant's copilot reconciling the resulting payment automatically.

The existing seams — a validated invoice object, an approval gate, a verifiable
event log, and a payment adapter boundary — are the right places to add those.

## References

- PayPal Agent Payments Protocol (AP2): <https://developer.paypal.com/community/blog/PayPal-Agent-Payments-Protocol/>
- PayPal WebMCP / agent-ready guidance: <https://developer.paypal.com/community/blog/WebMCP_PayPal_Agent_Ready>
- PayPal agentic commerce overview: <https://docs.paypal.ai/growth/agentic-commerce/overview>
- PayPal Invoicing v2: <https://developer.paypal.com/api/invoicing/v2/>
- PayPal Webhooks v1: <https://developer.paypal.com/api/webhooks/v1/>
- PayPal Orders v2: <https://developer.paypal.com/api/rest/>

## Narrative for the submission

> Cashflow Copilot is a working example of an agent with a bounded financial
> mandate. It can prepare, explain, and (after approval) execute a PayPal action,
> but it cannot invent a recipient or move money silently. The hash-chained audit
> trail is the "receipt" the merchant can verify. That is the same trust shape
> PayPal's agentic-commerce work is standardizing — applied to the money a small
> business is already owed.
