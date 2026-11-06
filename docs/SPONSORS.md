# Sponsor integrations

The hackathon offers optional sponsor tools. This project integrates four where
they genuinely improve the product and runnable demo, and deliberately declines
the rest. Sponsor prizes require selecting the tool on the Devpost form — being in
the repository is not enough.

## Integrated

### AG Grid (Community, MIT)

**What:** the receivables ledger is a real AG Grid, not a screenshot.

- Vendored `ag-grid-community@36.3.0` (`public/vendor/ag-grid/`) so the demo works offline and the repo stays dependency-free at runtime.
- Custom cell renderers for the client cell (avatar + name + email), status pill, and risk badge.
- Stable `getRowId`, sortable/resizable columns, row click opens the full audit drawer.
- Responsive height based on row count; a plain HTML table remains as a fallback if the vendored bundle fails to load.

**Why it is a good fit:** accounts receivable is a table problem. A judge can
sort by expected payment date, scan risk, and open a row without learning a new UI.

**Evidence:** `public/app.js` (`initLedger`, `renderLedger`), `public/vendor/ag-grid/LICENSE.txt`.

**Honest note:** the AG Grid sponsor prize is oriented toward AG Studio (the
React studio product). This app is deliberately framework-free, so it uses the
MIT Community grid rather than pulling in a React trial dependency. The
integration is real and visible; it is not an AG Studio entry.

### APIMatic

**What:** an OpenAPI 3.1 contract, an APIMatic build directory, and PayPal's
official Server SDK Context Plugin.

- `openapi/openapi.yaml` and `openapi/openapi.json` describe all 19 routes, schemas, errors, and PayPal webhook headers.
- `openapi/APIMATIC-BUILD.json` makes the folder an APIMatic build directory.
- The official context plugin was installed with `npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview`; its TypeScript skills are vendored under `docs/apimatic/paypal-context-plugin/` with MIT attribution.
- The spec passes Redocly lint with zero validation errors (18 style warnings).

**Why it is a good fit:** the app calls a real external API with real money
semantics. A machine-readable contract prevents drift between the UI, tests, and
Postman collection.

**Evidence:** [`docs/APIMATIC.md`](APIMATIC.md), `openapi/`.

### Render

**What:** a Blueprint that deploys the demo with one click.

- `render.yaml`: Node runtime, free plan, `healthCheckPath: /api/health`, proxy-aware settings, optional secrets, commented persistent-disk upgrade.
- The app starts in mock mode with no secrets, so the hosted demo is interactive immediately.
- Deployment guidance includes cold-start and ephemeral-filesystem realities.

**Why it is a good fit:** judges need a runnable demo. A one-click blueprint
removes the "works on my machine" risk.

**Evidence:** [`render.yaml`](../render.yaml), [`docs/DEPLOY.md`](DEPLOY.md).

### Postman

**What:** a runnable collection covering the local app, PayPal Invoicing v2, and
Orders v2 checkout.

- Folder 1 exercises the local API (health, state, insights, policy, audit, parse, create, send, payment link, copilot plan, webhook simulation, reset).
- Folder 2 calls PayPal Sandbox directly with OAuth, create, send, read, and remind.
- Folder 3 creates and captures a checkout order.
- Test scripts assert status codes, the tax-inclusive total, the audit chain, and that no PayPal ids leak to the public pay projection.

**Evidence:** `postman/PayPal-Cashflow-Copilot.postman_collection.json`.

## Evaluated and declined

These are deliberate product decisions, not oversights.

| Sponsor | Why not integrated |
| --- | --- |
| **Bryntum** | A Gantt/Scheduler/Calendar is a scheduling UI, not the core AR loop. The Community tier is ESM-only and needs a bundler/import map plus a large CSS payload; the added demo value did not justify the fragility in the remaining time. The forecast already communicates timing. |
| **Channel3** | A product catalog API is for commerce discovery. This app bills services, not catalog SKUs. Forcing product search into an invoice tool would be a checkbox, not an improvement. |
| **Elastic** | Hybrid/vector search is compelling for a large historical ledger, but the demo has four invoices. The deterministic insights already answer "what should I do next?" without a cluster dependency. |
| **Kernel / Astropods** | Browser and agent-runtime infrastructure. The app's agent is a server-side planner with an allowlist; it does not need to browse the open web or run autonomous tasks. |
| **Zapier** | A useful future outbound automation (e.g., notify Slack when an invoice is paid), but it does not improve the judged core loop. The webhook/audit events are the seam where it would attach. |

## Submission form note

If submitting for a sponsor prize, select **AG Grid**, **APIMatic**, and
**Render** (and Postman if the form lists it) on the Devpost submission form.
Prize stacking allows one Grand Prize or Honorable Mention plus one sponsor prize.
