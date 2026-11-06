# Competitive review

## Honest verdict

Cashflow Copilot is a **credible finalist-level submission** with a defensible
wedge, not an automatic win. The AR/invoicing cluster in this hackathon is the
most contested one, and several public submissions already have working sandbox
runs, hundreds of tests, and hosted demos.

What this project has that most do not:

1. A **quantified forecast** with a committed backtest and two baselines, not a
   chart with a confidence label.
2. **Policy as data** with the exact rule id and numeric inputs attached to every
   recommendation.
3. A **hash-chained audit trail** the judge can verify from the UI or API.
4. **Two-sided PayPal**: Invoicing for the merchant, Orders/Checkout for the
   customer, meeting at a verified capture.
5. A **real approval gate** for agent actions, with server-side validation of
   model-proposed tools and invoice ids.

What it does not have yet:

- A committed **real sandbox evidence** file (the script exists; the credentials
  are the owner's).
- A hosted demo that has been recorded end-to-end.
- A recorded video.

Those are owner-only steps, documented in [`FINAL_HANDOFF.md`](FINAL_HANDOFF.md).

## Direct competition observed

These are public submissions found while researching the hackathon. They are
listed to keep the positioning honest, not to disparage them.

| Project | What it does | Why it is strong | Our response |
| --- | --- | --- | --- |
| [Chaser](https://devpost.com/software/chaser-bc5tv6) | AR agent for PayPal sellers with a reconciliation benchmark, promise-to-pay, disputes, write-off policy | Real sandbox run, labelled 71-transaction benchmark, explicit live-vs-demo table | We add payer-aware **payment-date forecasting** and a **hash-chained audit**; both are measurable |
| [Kioku × PayPal](https://devpost.com/software/kioku-x-paypal) | Bills from a sentence, reminders, "who owes me?", model-claim verification, 248 tests | Very high test count and a resettable hosted demo | We match the approval/verification story and add checkout + forecast evidence |
| [ClearDue](https://devpost.com/software/cleardue-kqj2ht) | Dispute resolution on existing PayPal invoices with source-linked evidence | Real sandbox money movement (£1,250 → £1,000 → paid) | Different job: collection before dispute. Our checkout closes the payment loop |
| [OFFSET](https://devpost.com/software/offset-jrg3p6) | Circular debt netting for SMB supply chains | Genuinely novel, property-tested net positions | We do not compete on netting; we compete on the single-merchant collection loop |
| [ScopePay](https://devpost.com/software/scopepay) | Scope-vs-request change orders → PayPal invoice | Clean single workflow, verified sandbox PAID | Broader AR loop and a forecast, not just change orders |
| [Reckon](https://devpost.com/software/reckon-0wn2bd) | Almost the same pitch, written in future tense with no verified run | — | **Cautionary example:** evidence beats narrative. We ship the runnable build and tests |

## Judging alignment

The five criteria are equally weighted, with ties broken by Technological
Implementation first.

| Criterion | Our strongest evidence | Remaining gap |
| --- | --- | --- |
| Technological implementation | Invoicing v2 + Orders v2 + verified webhooks, 58 tests, agent allowlist, audit chain, OpenAPI contract | Real sandbox evidence file |
| Design | Command center, AG Grid ledger, plan cards, invoice control room, hosted pay page, mobile layout | Recorded walkthrough |
| Potential impact | Named user (small studio), quantified forecast error, time saved on chasing | A real merchant quote or pilot |
| Innovation | Payer-aware forecast + policy ledger + verifiable audit for an AR agent | Crowded cluster; needs a crisp first sentence |
| Presentation | Scripted 2:40 video, live-vs-demo table, reproducible numbers | The video itself |

## Remaining risks

1. **Evidence gap.** A judge may see "mock demo" and discount the PayPal claims.
   Mitigation: run `npm run sandbox:check`, commit the evidence, and record the
   sandbox path.
2. **Crowded cluster.** "AI AR for freelancers" is the most contested idea.
   Mitigation: lead with the forecast number and the approval/audit guarantees,
   not "AI invoice generator."
3. **No React / AG Studio.** The AG Grid sponsor prize is oriented toward AG
   Studio. Mitigation: the Community grid is a real, visible integration; we do
   not claim an AG Studio entry.
4. **Prototype boundaries.** In-memory state, per-process rate limits, synthetic
   seed data. Mitigation: disclosed in the README, optional persistence, and a
   clear production roadmap.
5. **Video dependency.** Judges are not required to run the project. Mitigation:
   record early, upload early, and keep the first 15 seconds on the money moment.

## Suggested score estimate

Assuming the sandbox evidence and video are completed and the hosted demo is
warm:

| Dimension | Estimate | Why |
| --- | ---: | --- |
| Technological implementation | 8.5/10 | Three PayPal surfaces, verified events, agent validation, tests, audit |
| Design | 9/10 | Coherent product, not a technical demo; real customer page |
| Potential impact | 8/10 | Specific user, quantified error reduction, clear workflow |
| Innovation | 8/10 | Forecast + policy + verifiable audit; not a generic invoice generator |
| Presentation | 8.5/10 | Scripted, honest, evidence-first |
| **Overall** | **~8.4/10** | Finalist-level; placement depends on the field and the video |

## The one-sentence position

> Cashflow Copilot is the AR agent that predicts when you will actually get paid,
> explains the one action that moves cash this week, and cannot move money
> without your approval — with a hash-chained receipt for every step.

Do not pitch it as "an AI invoice generator."
