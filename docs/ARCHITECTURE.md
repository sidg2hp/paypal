# Architecture

This is the implementation map behind the README diagrams.

## Runtime topology

```mermaid
flowchart TB
    browser[Merchant browser<br/>command center + AG Grid ledger]
    paypage[Customer<br/>hosted pay page]
    server[Node.js HTTP server<br/>src/server.js]
    core[Domain core<br/>src/core.js]
    agent[Agent planner<br/>src/agent.js]
    policy[Policy engine<br/>src/policy.js]
    forecast[Payer-aware forecast<br/>src/forecast.js]
    audit[Hash-chained audit<br/>src/audit.js]
    store[InvoiceStore<br/>optional JSON persistence]
    paypal[PayPal adapter]
    provider[OpenAI / xAI / Gemini / Ollama]

    browser --> server
    paypage --> server
    server --> core
    server --> agent
    agent --> core
    agent --> provider
    core --> policy
    core --> forecast
    core --> audit
    core --> store
    store --> paypal
```

## Request flow: intent to PayPal action

```mermaid
sequenceDiagram
    actor Merchant
    participant UI as Browser UI
    participant API as Node API
    participant Agent as Agent planner
    participant Policy as Policy engine
    participant Store as InvoiceStore
    participant PayPal as PayPal adapter

    Merchant->>UI: "Who should I chase today?"
    UI->>API: POST /api/copilot/plan
    API->>Agent: plan(message)
    Agent->>Store: insights()
    Store->>Policy: apply policy to each recommendation
    Policy-->>Store: rule id + inputs + allowed
    Store-->>Agent: ranked insights + forecast
    Agent-->>API: answer + proposed steps (nothing executed)
    API-->>UI: plan with 15-minute TTL
    Merchant->>UI: approve selected step ids
    UI->>API: POST /api/copilot/execute
    API->>Agent: execute(planId, approvedStepIds)
    Agent->>Store: remindInvoice / sendInvoice / ...
    Store->>PayPal: Invoicing v2 call
    PayPal-->>Store: result
    Store->>Store: append hash-chained event
    Store-->>Agent: updated invoice
    Agent-->>API: per-step results
    API-->>UI: updated state
```

## Request flow: customer checkout

```mermaid
sequenceDiagram
    actor Customer
    participant Pay as Hosted pay page
    participant API as Node API
    participant Store as InvoiceStore
    participant PayPal as Orders v2

    Customer->>Pay: open /pay/{token}
    Pay->>API: GET /api/pay/{token}
    API-->>Pay: public invoice projection (no PayPal ids)
    Customer->>Pay: Pay with PayPal
    Pay->>API: POST /api/pay/{token}/order
    API->>Store: ensurePaymentOrder
    Store->>PayPal: POST /v2/checkout/orders
    PayPal-->>API: order id + approve URL
    Pay-->>Customer: redirect to PayPal
    Customer->>PayPal: approve
    PayPal-->>Pay: return to /pay/{token}?status=return
    Pay->>API: POST /api/pay/{token}/capture
    API->>PayPal: POST /v2/checkout/orders/{id}/capture
    PayPal-->>API: COMPLETED + capture id
    API->>Store: status PAID + PAYMENT.CAPTURE.COMPLETED event
    API-->>Pay: paid receipt
```

## Request flow: verified webhook

```mermaid
sequenceDiagram
    participant PayPal as PayPal
    participant API as POST /api/webhooks/paypal
    participant Verify as PayPal verification API
    participant Store as InvoiceStore

    PayPal->>API: event + PayPal-* signature headers
    API->>API: require headers + webhook id + sandbox adapter
    API->>Verify: POST /v1/notifications/verify-webhook-signature
    Verify-->>API: SUCCESS / failure
    alt verified
        API->>Store: apply idempotent lifecycle event
        Store-->>API: updated invoice + hash-chained event
        API-->>PayPal: 200
    else rejected
        API-->>PayPal: 401, no state change
    end
```

## Module boundaries

| Module | Responsibility | Deliberate constraint |
| --- | --- | --- |
| Browser | Review, approval, provenance, feedback | Never receives secrets or PayPal ids on the public pay page |
| `src/server.js` | Routing, JSON contracts, security headers, same-origin checks, rate limits, pay page | No framework or runtime dependency |
| `src/core.js` | Validation, cent-safe totals, lifecycle, adapters, insights integration | Recalculates every financial value server-side |
| `src/agent.js` | Intent classification, LLM planning, allowlisted execution | Model output is validated; unknown tools/ids dropped; plans expire |
| `src/policy.js` | Collections rules as data | Every decision carries rule id and numeric inputs |
| `src/forecast.js` | Payer statistics and expected payment date | Pure functions, reusable by the backtest |
| `src/audit.js` | SHA-256 chain | Every event includes `prevHash` and `hash` |
| `src/persistence.js` | Optional durable JSON | Atomic writes, debounced, no secrets |
| PayPal adapter | OAuth, Invoicing v2, Orders v2, webhook verification | Sandbox by default; cert URL restricted to PayPal hosts |
| `InvoiceStore` | Prototype state and audit timeline | In-memory by default; durable storage is a deployment choice |

## Invoice lifecycle

```mermaid
stateDiagram-v2
    [*] --> DRAFT
    DRAFT --> SENT: merchant approves / PayPal send
    DRAFT --> CANCELLED: merchant cancels
    SENT --> PAID: verified payment or capture
    SENT --> CANCELLED: verified cancellation
    SENT --> VOID: verified void
    PAID --> REFUNDED: verified refund
    PAID --> PAID: duplicate event acknowledged
    CANCELLED --> CANCELLED: duplicate or stale event ignored
    VOID --> VOID: duplicate or stale event ignored
    REFUNDED --> REFUNDED: duplicate or stale event ignored
```

## Trust boundaries

1. **Model boundary.** The LLM sees a compact data snapshot and returns JSON. It
   never receives database handles, adapter credentials, or an execution path.
2. **Policy boundary.** Reminder and send permissions are decided outside the
   model, in `policies/collections.json`.
3. **Approval boundary.** A plan is inert until the merchant submits specific
   step ids. Drafts and reminders have their own UI confirmations.
4. **Payment boundary.** The app never sees card data. PayPal processes payment;
   the app stores invoice metadata and audit events.
5. **Event boundary.** State changes from PayPal require signature verification;
   simulated events are labelled and cannot masquerade as live.
6. **Data boundary.** The public pay projection excludes merchant-only fields
   (`paypalInvoiceId`, order ids, events, internal notes).

## Observability for a judge

- `GET /api/health` — adapter, mode, version, capabilities, AI status, no secrets.
- `GET /api/insights` — risk, reasons, policy decisions, payer-adjusted forecast.
- `GET /api/audit` — recomputed hash chain and first broken link.
- Plan responses include `ai.provider`, `ai.model`, `ai.fallback`, and `ai.reason`.
- Every UI event label distinguishes seed, simulated, PayPal, verified webhook,
  and Copilot-approved actions.

## Performance notes

- No database, no framework, no runtime dependency; startup is instant.
- Insights and payer statistics are O(invoices) and recomputed per request; the
  demo has four invoices. A production system would cache and paginate.
- Outbound AI and PayPal requests have bounded timeouts (default 10 s, max 120 s).
- Rate limits are in-memory per process; a multi-instance deployment would move
  them to a shared store.
