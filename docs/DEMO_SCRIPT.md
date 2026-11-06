# Demo video script (under 3 minutes)

Target **2:40**. Judges are not required to watch past 3:00, so the close must
land before 2:50. Record 1080p, use a clean browser profile, hide bookmarks, and
warm the hosted URL before recording.

## Before you record

- [ ] `npm run verify` passes.
- [ ] The hosted demo (or localhost) is in the intended mode. For the strongest video, use **PayPal Sandbox** and a sandbox buyer account.
- [ ] `npm run sandbox:check` has produced a real evidence file; keep the PayPal Developer Dashboard open in a second tab.
- [ ] Reset the demo so the queue shows the seeded story.
- [ ] Close notifications, email, and personal tabs.
- [ ] Zoom the browser to ~110% so text is readable at 1080p.
- [ ] Record system audio only; no copyrighted music.
- [ ] Have a sandbox invoice ready to pay for the cold open.

## Shot list

### 0:00–0:15 — Cold open: the money moment

**On screen:** the invoice drawer or the hosted pay page, clicking through a
PayPal sandbox payment; the invoice flips to **PAID** and the forecast bar moves.
No logo, no "hi, I'm."

**Voiceover:**

> Freelancers lose cash to invoices that are already late. This is the AI
> operator that tells you which one to chase — and only moves money after you
> approve. It runs on PayPal.

### 0:15–0:35 — Who it is for

**On screen:** the command center. Point at outstanding, the overdue count, the
30-day forecast, and the queue.

**Voiceover:**

> This is a three-person design studio with fourteen open invoices. The command
> center ranks what needs attention, explains why, and shows what is actually
> expected to arrive.

### 0:35–1:10 — Intent to reviewable PayPal action

**On screen:** click **Draft an invoice from a sentence**. Let the chat answer
appear, then open the review modal. Change one number, point at the recalculated
total and the currency field.

**Voiceover:**

> A sentence becomes a validated draft. The model extracted the customer, the
> line items, the tax, and the due date. Every total is recalculated server-side
> in cents — the model never does the arithmetic. I can edit anything before it
> becomes a PayPal invoice.

### 1:10–1:35 — Agentic plan with an approval gate

**On screen:** ask **"Who should I chase today?"** Show the plan card with two
steps and checkboxes. Untick one, click **Approve selected**. Show the toast and
the new timeline event.

**Voiceover:**

> The agent can propose five actions and nothing else. It cannot invent an
> invoice id, and it cannot execute. I approve exactly the steps I want. The
> policy engine decides whether a reminder is even allowed, and shows the rule.

### 1:35–2:05 — PayPal depth

**On screen:** switch to the PayPal Developer Dashboard tab. Show the sandbox
invoice created by the app (id and amount). Back to the app: open the drawer,
show the PayPal invoice id, then create a payment link and open the hosted pay
page. Keep the PayPal approval screen on camera when the payment happens.

**Voiceover:**

> The invoice is real in PayPal Sandbox. Tax is allocated per item so PayPal's
> total matches the app. The customer gets a hosted PayPal checkout. The invoice
> only becomes paid after PayPal confirms the capture — not when the button is
> clicked.

### 2:05–2:30 — The depth beat: evidence, not adjectives

**On screen:** split or quick cuts:

1. `npm run backtest` output: `2.36 d` vs `7.98 d`, 70.4% better.
2. `GET /api/audit` or the **Verify audit chain** button showing the chain valid.
3. A rejected webhook signature or the policy rule `REMINDER_LIMIT_REACHED` in the drawer.

**Voiceover:**

> The forecast is not a chart. It is due date plus each payer's median lateness —
> 70% lower error than a due-date baseline in the committed backtest. Every
> timeline event is hash-chained, and every recommendation carries the policy
> rule that allowed it. That is the difference between a demo and something a
> business could operate.

### 2:30–2:45 — Impact and close

**On screen:** back to the queue, then the repo URL and hosted demo URL on a
clean end card.

**Voiceover:**

> Cashflow Copilot turns a sentence into a reviewable PayPal action, then turns
> verified payment events into a calm, explainable collection plan. Open source,
> runs offline, and the PayPal sandbox path is two environment variables away.
> Repo and demo are in the description.

## What to avoid

- A trailer with music and no product. The judging criterion is "does the video
  clearly demonstrate the project working end-to-end."
- Explaining architecture for the first 30 seconds.
- Dead air on loading spinners, `npm install`, or setup.
- Claiming "verified webhooks" while showing a simulated event. The UI labels
  the source; say the same thing the UI says.
- Vertical phone footage of a desktop app, tiny text, or overrunning 3:00.
- Copyrighted music or unlicensed PayPal marks.

## Upload

- YouTube, **Public** (not unlisted).
- Title: `Cashflow Copilot — AI accounts receivable on PayPal`.
- Description: one-paragraph summary, repo link, hosted demo link, and the
  live-vs-demo note.
- Upload early: processing can take hours, and the Devpost submission locks at
  the deadline.
