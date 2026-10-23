# Architecture: Cashflow Copilot

This document is the implementation map behind the README diagrams.

## Runtime topology

```mermaid
flowchart TB
    browser[Browser UI<br/>public/index.html + app.js + styles.css]
    server[Node.js HTTP server<br/>src/server.js]
    domain[Domain core<br/>src/core.js]
    ai[AI provider resolver]
    invoices[InvoiceStore<br/>in-memory prototype state]
    paypal[PayPal adapter]
    provider[OpenAI / xAI / Gemini / Ollama]
    sandbox[PayPal Sandbox REST APIs]
    webhook[Verified webhook endpoint]

    browser <-->|JSON HTTP| server
    server --> domain
    domain --> ai
    ai --> provider
    ai --> domain
    domain --> invoices
    invoices --> paypal
    paypal --> sandbox
    sandbox --> webhook
    webhook --> domain
```

## Intent-to-invoice sequence

```mermaid
sequenceDiagram
    actor Merchant
    participant UI as Browser UI
    participant API as Node API
    participant Resolver as AI resolver
    participant Provider as Selected provider
    participant Store as InvoiceStore
    participant PayPal as PayPal adapter

    Merchant->>UI: Describe work and payment terms
    UI->>API: POST /api/parse-invoice
    API->>Resolver: Resolve explicit/auto provider
    Resolver->>Provider: Structured extraction request
    Provider-->>Resolver: JSON invoice proposal
    Resolver-->>API: Validated invoice + provenance
    API-->>UI: Editable draft + provider metadata
    Merchant->>UI: Review and approve
    UI->>API: POST /api/invoices
    API->>Store: Recalculate totals and save DRAFT
    UI->>API: POST /api/invoices/:id/send
    API->>PayPal: Create/send invoice
    PayPal-->>API: PayPal invoice id
    API->>Store: Transition DRAFT → SENT
    API-->>UI: Timeline + adapter status
```

## Verified event sequence

```mermaid
sequenceDiagram
    participant PayPal as PayPal Sandbox
    participant API as POST /api/webhooks/paypal
    participant Verify as PayPal verification API
    participant Store as InvoiceStore
    participant UI as Dashboard

    PayPal->>API: Event payload + signature headers
    API->>Verify: POST /v1/notifications/verify-webhook-signature
    Verify-->>API: SUCCESS / failure
    alt verified
        API->>Store: Apply idempotent lifecycle event
        Store-->>API: Updated invoice + event proof
        API-->>UI: Forecast and queue refresh
    else rejected
        API-->>PayPal: 401 without changing state
    end
```

## Design boundaries

| Boundary | Responsibility | Deliberate constraint |
| --- | --- | --- |
| Browser | Review, approval, provenance, feedback | Never receives secrets |
| HTTP server | Routing, JSON contracts, headers, errors | No framework/runtime dependency |
| Domain core | Validation, totals, lifecycle, provider routing | Recalculates all financial values |
| AI resolver | Select provider and validate structured output | Every failure falls back deterministically |
| PayPal adapter | OAuth, invoice actions, webhook verification | Sandbox by default when configured |
| InvoiceStore | Prototype state and audit timeline | In-memory; durable storage is a deployment requirement |

## Observability for a judge

- `GET /api/health` shows adapter mode and AI provider/model status without secrets.
- Parse responses include `ai.provider`, `ai.model`, `ai.mode`, and fallback reason.
- Invoice timelines distinguish app audit events, simulated webhooks, PayPal events, and verified PayPal webhooks.
- The UI always labels mock/synthetic/demo-safe behavior explicitly.
