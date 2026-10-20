# PayPal Cashflow Copilot

**Say what needs to get paid. Review it. Let PayPal make it real.**

Cashflow Copilot is an offline-first, trust-first AI accounts-receivable operator for freelancers and small businesses. It turns natural language into a reviewable invoice, sends it through PayPal's Invoicing API, and reacts to invoice events with an explainable next step.

The repository includes a polished demo UI, a deterministic parser for offline judging, a PayPal Sandbox adapter, a Postman sponsor collection, and a reproducible test/Docker path. See [`docs/IDEATION.md`](docs/IDEATION.md) for the evidence-backed hackathon thesis and judge narrative.

## Setup

Use Node.js 22 (the repository pins it in `.nvmrc`). There are no runtime dependencies.

```sh
npm ci
```

Copy `.env.example` to `.env` when running with a local environment loader, or export variables directly. Mock mode is used unless both `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` are set.

## Run the demo

```sh
npm start
```

Open <http://localhost:3000>. The server listens on `http://localhost:3000` (override with `PORT`). The UI is intentionally usable without credentials: it starts with seeded, synthetic data and uses the mock adapter.

For the winning-path demo:

1. Click the Copilot suggestion or enter an invoice request.
2. Review/edit the extracted recipient, items, tax, and due date.
3. Click **Approve & send with PayPal**.
4. Click **Simulate a paid invoice** to replay a `INVOICING.INVOICE.PAID` event.

The human approval gate is intentional. AI prepares and explains a financial action; the user approves it; PayPal processes it.

## API

- `GET /api/state` — seeded invoices, summary totals, and active adapter.
- `POST /api/parse-invoice` with `{ "text": "Invoice for ... 2 hours at $150/hour" }` — deterministic offline parsing.
- `POST /api/invoices` — validate and create an in-memory draft.
- `POST /api/invoices/:id/send` — create/send through mock PayPal or the sandbox REST adapter.
- `POST /api/webhooks/simulate` with `{ "eventType": "INVOICING.INVOICE.PAID", "invoiceId": "..." }` — apply a supported invoice event.

The sandbox adapter uses PayPal OAuth at `/v1/oauth2/token` and Invoicing API endpoints at `/v2/invoicing/invoices`. Secrets are read from environment variables and are never included in application logs or API responses. `OPENAI_API_KEY` is reserved for an optional future parser hook; the current parser makes no network calls.

## Test and check

Both commands are offline and need no services:

```sh
npm test
npm run check
```

`npm test` is the single offline test command required for this project. It covers parsing, cent-safe totals, strict validation, PayPal mock behavior, webhook transitions, and HTTP routes.

## Docker

```sh
docker build -t paypal-cashflow-copilot .
docker run --rm -p 3000:3000 paypal-cashflow-copilot
```

To use PayPal sandbox, pass both credentials at runtime with `-e PAYPAL_CLIENT_ID=... -e PAYPAL_CLIENT_SECRET=...`; do not put them in the image or source tree.

## PayPal Sandbox mode

Create a PayPal Developer app and export both credentials. The server obtains an OAuth 2.0 token and uses the documented Invoicing v2 endpoints to create/send invoices:

```sh
PAYPAL_CLIENT_ID=... PAYPAL_CLIENT_SECRET=... npm start
```

If either credential is absent, mock mode is selected. See [`postman/PayPal-Cashflow-Copilot.postman_collection.json`](postman/PayPal-Cashflow-Copilot.postman_collection.json) for an inspectable Postman collection covering the local app plus direct PayPal Sandbox references. Never commit `.env` or secrets.

## Deploy

The container listens on `$PORT` (default `3000`) and can be deployed to any container host that supports Node 22. For a hosted hackathon demo, set `PORT`, `PAYPAL_CLIENT_ID`, and `PAYPAL_CLIENT_SECRET` as platform secrets, then expose the container's HTTP port. The in-memory store is a prototype boundary; production should add durable storage and webhook signature verification before handling real customer data.
