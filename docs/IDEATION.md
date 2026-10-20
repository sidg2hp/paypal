# Cashflow Copilot: hackathon thesis

## Recommendation

Build **Cashflow Copilot**, a trust-first AI accounts-receivable operator for freelancers and small businesses:

> “Say what needs to get paid. Review it. Let PayPal make it real.”

The first workflow turns a natural-language request into an editable PayPal invoice, sends it after explicit approval, and reacts to payment events with a next-best action. This is a sharper version of the PDF's “AI Invoice & Expense Manager” than a generic invoice writer: the product owns the complete **intent → review → PayPal action → event → follow-up** loop.

## Why this beats a generic shopping chatbot

| Direction | Technical implementation | Demo reliability | Differentiation | Main risk |
| --- | ---: | ---: | ---: | --- |
| Conversational shopping | High | Medium | High | Agentic-commerce access and checkout approval dependencies |
| Fraud alert bot | High | Low | Medium | No credible labeled data or real-time signals in a short build |
| Split-payment agent | Very high | Low | High | Partner onboarding and multi-party account setup |
| **Cashflow Copilot** | **High** | **High** | **High when event-driven** | Invoicing permissions and sandbox email behavior |

The winning wedge is not “AI writes an invoice.” It is **AI proposes a safe financial action, PayPal executes it, and the copilot explains what changed**. The human review gate is a product feature: it prevents hallucinated amounts, recipients, or dates from becoming financial actions.

## Evidence used

- The supplied hackathon brief emphasizes meaningful PayPal technology + AI, a working prototype, open-source code, documentation, live/demo readiness, and judging across technical implementation, design, impact, innovation, and presentation.
- PayPal REST APIs use OAuth 2.0 and provide sandbox accounts: <https://developer.paypal.com/api/rest/>
- Invoices v2 provides create draft, send, remind, cancel, record payment, QR code, search, and recurring-invoice endpoints: <https://developer.paypal.com/api/invoicing/v2/>
- PayPal Webhooks supports registration, signature verification, event lookup, and simulated events: <https://developer.paypal.com/api/webhooks/v1/>
- PayPal's 2026 agentic-commerce documentation says access requires an onboarding request, so it is a future extension rather than a critical MVP dependency: <https://docs.paypal.ai/growth/agentic-commerce/overview>
- PayPal's WebMCP guidance reinforces that agents can prepare discovery/cart/checkout while buyers stay in control of sign-in, funding choice, review, and approval: <https://developer.paypal.com/community/blog/WebMCP_PayPal_Agent_Ready>

## MVP acceptance criteria

1. A judge can open the app with no credentials and see a credible merchant dashboard with seeded data.
2. A judge can type an invoice request and receive structured customer, line items, due date, tax, and total.
3. The draft is editable and cannot be sent without an explicit review/approval action.
4. Send creates a PayPal invoice through the mock adapter offline, or the sandbox Invoicing API when credentials are configured.
5. A payment webhook can be simulated and the dashboard updates from SENT to PAID with a clear explanation.
6. The demo exposes a ready-to-import Postman collection for PayPal OAuth, invoice create/send, and webhook simulation.
7. `npm test`, `npm run check`, and `docker build` are reproducible without a network dependency for the test path.

## Three-minute judge narrative

1. Start with two overdue-looking signals: “$575 outstanding” and “1 invoice needs attention.”
2. Say: “Invoice Acme Design Co for two brand review sessions at $125 each, 8% tax, due in 15 days.”
3. Show the AI extraction and calculation explanation; edit the due date if desired.
4. Click **Approve & send with PayPal**. The activity rail shows `POST /v2/invoicing/invoices` and `/send` in sandbox/mock mode.
5. Simulate `INVOICING.INVOICE.PAID`. The invoice flips to PAID and the copilot says: “Close the loop: mark the work complete and move $270 into your cash buffer.”
6. End on the trust boundary: the AI can prepare and explain; the human approves the financial action; PayPal owns payment processing.

## Sponsor strategy

Use **Postman** as a practical sponsor integration, not a logo: the repository ships a runnable collection with environment variables and example requests for the PayPal API surface. The collection makes the integration inspectable for judges and doubles as the team's API test harness. If the active sponsor list changes, Postman remains optional and the product still works without it.

## Post-MVP extensions

- PayPal Webhook signature verification and live event registration.
- Invoice reminders and “who needs attention this week?” prioritization.
- OpenAI-compatible structured extraction behind the existing offline parser seam.
- PayPal QR-code invoice sharing and recurring invoices.
- Agentic-commerce handoff once merchant access is available; never bypass buyer approval.
