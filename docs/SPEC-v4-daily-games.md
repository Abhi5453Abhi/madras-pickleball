
# Madras Pickleball — Daily Games, feature plan v2 (11 Sep 2026)

> Host hosts, players join, they play, then they are charged. The money cycle runs without anyone chasing it — but "fully automated" is three different things, and only one of them is genuinely automatic.


## 1. Findings about automatic charging


### Charging them right after the game is not legal on a standing mandate

[verified] RBI's e-mandate framework sets a **floor of 24 hours** between the pre-debit notice reaching the payer and the debit. NPCI restricts auto-debit execution to off-peak windows, reported as roughly **1–5pm and 9:30pm–10am**. Cashfree's charge call takes a date, not a time.

[confirm] The exact notice period enforced on our account. Cashfree's FAQ describes a gap of about 25 hours; whether that is their own rule, our acquirer's, or a conservative reading of the 24-hour floor is a question for them. **Nothing in this plan treats 25 hours as an external requirement** — the engine takes the notice period as a setting, and we set it to whichever is larger once they answer.

**Either way the honest promise is the same: play tonight, charged the next day, the player does nothing.** For the venue that is a non-issue — the money still arrives without anyone chasing it.


### UPI Reserve Pay does support multiple debits per block — v1 was wrong about that

v1 said NPCI allows only one capture per block. That is true of **UPI One-Time Mandate** and still is. It is not true of UPI generally. NPCI enabled **Single Block Multiple Debits** in 2024 and rebranded it **UPI Reserve Pay** in October 2025. Cashfree ships it today: block once, debit repeatedly until the block is exhausted, _and no pre-debit notice is needed per debit_ because the original authorisation covers them all. It is genuinely the closest thing to what you asked for.

**It is technically capable of what you described.** It stays out of the primary plan for practical reasons, not technical ones. **Payer app support is limited** — it currently works from Paytm, Navi and BHIM; PhonePe and Google Pay are not yet live as payer apps, and between them that is most of your players. **It needs merchant enablement** on the account plus a category review, and the rollout is visibly aimed at quick-commerce and brokerages. **The block is capped at ₹10,000**, so it must be re-authorised whenever it is exhausted — how often depends on the block size and how often someone plays (a ₹2,000 block at ₹300 a session is six or seven sessions, purely as an illustration). And **a refund does not replenish the reserved limit**: refunding a rained-off session returns the money to the player but leaves that much less headroom in their block, which is a discrepancy you would have to explain every time it happens.

Worth revisiting. PhonePe and Google Pay support is the thing to watch.


### Payment links are not free, and the per-debit fee is not a single number

v1 said links cost ₹0 because UPI is zero-MDR. **Zero MDR is a rule about the rail, not about the gateway.** Cashfree's own platform fee of 1.95% applies to UPI the same as to cards. Links are free today only because of a new-merchant promotion — 0% up to ₹20 lakh of cumulative volume, ending 31 March 2027 — and at your volume that cap is used up in a bit over three months.

The mandate fee is also two numbers, not one: **₹5 per debit below ₹1,000 and ₹15 at or above it**, plus ₹7.50 once per mandate registered. And the promotion **explicitly excludes subscriptions and e-mandates**, so the mandate path gets none of the discount.


### Settlement is not T+1, and the app must not assume any cycle

v1 said Cashfree settles T+1. The contractual default is **T+2 bank working days**; T+1 is currently a campaign perk, not a right. The cycle is a per-merchant setting decided by bank approval, business category and risk — not a constant, and there appears to be no API to read it.

So the app treats settlement as **asynchronous with unknown latency**: subscribe to settlement webhooks, match payouts to charges by payment and settlement id, and **read the actual fee and tax from the settlement record** rather than computing them from an assumed rate card. That last point quietly removes most of the cost-model risk — you stop guessing what Cashfree charged and start reading it.

Settlement runs on bank working days, so a Friday charge can be three or four calendar days from money-in-bank, longer across a long weekend. Any screen showing an expected payout date says _estimate_.


## 2. The cycle, end to end

- **Once** — Host sets the session to repeat — Every Tuesday 7–9pm creates itself.
- **Any time** — Player joins — name and phone — No login, no payment step, no account. Two fields.
- **Three hours before** — They confirm, or lose the spot — JOINED becomes CONFIRMED. No answer by an hour before and the spot goes to the waitlist automatically. This is a real state change, not a reminder.
- **First time only** — They turn on auto-pay — One OTP to verify the phone, one UPI PIN. Capped per charge, cancellable from their own UPI app. Offered after two clean link payments — never at signup.
- **7–9pm** — They play — —
- **At the end** — **Host taps who turned up** — Or taps “all here” and un-taps the one who didn't. **The only human step in the whole cycle.**
- **+45 min** — Charges lock — Everyone sees “₹300 for tonight, ₹900 this week”. Until this moment attendance is freely editable and no charge exists.
- **Their sweep day** — One notice for the accumulated balance — Charges are reserved first, then notified. The notice names the exact amount and the date it will be taken. They can block that one debit without cancelling anything.
- **Next lawful window** — One debit, one receipt — Computed, not assumed — the engine finds the earliest date that satisfies the notice period and lands in a permitted execution window.
- **Later** — Settlement lands — Asynchronous, T+2 working days by default. The app reads the actual amount and fee from the settlement record and reconciles.

## 3. Rails and cost

| Rail | Player effort | Charge lands | Call |
|---|---|---|---|
| UPI Autopay — swept per player, weekly | None after one-time setup | Next lawful window, roughly a day later | **Primary** |
| Payment link after the game | One tap per session | When they tap | **The fallback, and the whole of the first few months** |
| UPI Autopay — per session | None | Next day | Right idea, wrong grain — 12× the fee for the same outcome |
| UPI Reserve Pay (block, multi-debit) | PIN per block, re-authorised when the block is exhausted | Seconds | Technically capable — held back by app support, merchant enablement and the ₹10,000 cap |

| Component | Links only | Mandate per session | Mandate weekly | Basis |
|---|---|---|---|---|
| Platform fee 1.95% | ₹11,700 after promo · ₹0 during | [confirm] — may apply on top | [confirm] — may apply on top | 1.95% is published; whether it applies to mandate debits is the key unknown |
| Promotion | 0% to ₹20L cumulative, ends 31 Mar 2027 | Excluded | Excluded | [published] — subscriptions carved out |
| Per-debit fee | — | 2,000 × ₹5 = ₹10,000 | 160 × ₹15 = ₹2,400 | [published] — ₹5 under ₹1,000, ₹15 at or above |
| Mandate registration | — | ~₹750 | ~₹30 | [published] ₹7.50 each · [assumption] how many new mandates a month |
| Failed-debit fee | — | unknown | unknown | [confirm] — not published anywhere |
| Link delivery (SMS/WhatsApp) | unknown | — | — | [confirm] — not published anywhere |
| GST 18% | applies | applies | applies | [published] — not waived by the promotion |
| Range, per month | ₹0 → ₹13,800 | ₹12,700 → ₹26,500 | ₹2,900 → ₹16,700 | [assumption] ~2,000 charges at ₹300 · the spread is the platform-fee question |

## 4. The money model — domain objects

- **Charge** — What one player owes, for a stated reason. Immutable once locked — the amount, the reason and the timestamp never change again. Every charge carries an _origin_: a **session charge** raised from a participation that was present, or a **policy charge** such as an optional no-show fee.
  - NOT: Not a balance, and never edited. A correction is a new row. A policy charge is never a session charge wearing a different label — they are separate origins so one can be waived or switched off without disturbing the other.
- **Charge adjustment** — A signed row that changes what is owed — a discount, a waiver, a correction after the fact.
  - NOT: Not a payment. No money moved.
- **Payment** — Money that actually arrived, by some method, from some initiator.
  - NOT: Not an allocation. A payment knows nothing about which charges it covers.
- **Charge application** — The join that carries money from a payment to a charge. This is where partial and multiple payments become expressible.
  - NOT: Not optional — without it, one payment covering three sessions has nowhere to live.
- **Credit** — Value granted without money arriving — goodwill, a correction, a rained-off session.
  - NOT: Not a payment. It settles a charge but never appears in the bank.
- **Refund** — Money sent back out, against a specific payment.
  - NOT: Not a negative payment. It has its own lifecycle and its own provider id.
- **Collection attempt** — One try at getting money — a link, or a mandate debit. Carries the provider ids, the attempt number and the outcome.
  - NOT: Not a payment. Most attempts never become one.
- **Reservation** — A durable claim on a charge, held from before the external call until the provider confirms what happened.
  - NOT: Not a lock. It survives transactions, processes and restarts, and it is visible to every reader.
- **Mandate** — A stored authorisation to debit, with its own lifecycle at the bank — it can die without us touching it.
  - NOT: Not a payment method on a player. One player can have several over time.
- **Webhook event** — Every message the provider sends, verified or not, stored before it is interpreted.
  - NOT: Not a trigger. It is a durable inbox that the reconciler drains.

### Three rules that hold everywhere

- **Money is integer paise** — No floats anywhere, ever. Currency fixed to INR by a constraint.
- **Nothing is deleted or back-dated** — A trigger raises on delete for every money table. Corrections are new rows with a sign.
- **No external call inside an open transaction** — On Vercel with a pooled connection this is fatal under trivial load — and it is what forces the write-ahead ordering in the reservation design.

### The five invariants (database constraints)

```sql
CHECK (applied_paise <= amount_paise + adjust_paise)          -- can't over-settle a charge
CHECK (allocated_paise + refunded_paise <= amount_paise)     -- can't spend a payment twice
UNIQUE (charge_id) WHERE released_at IS NULL                 -- can't double-collect a charge
UNIQUE (participation_id) WHERE origin = 'participation'     -- can't double-bill a game
UNIQUE (provider, provider_event_id)                         -- can't double-process a webhook
```

### Worked example — over-billed Priya Rs 300

- **The charge stays** — ₹300, locked, untouched. It is what we said she owed on the night.
- **An adjustment appears** — −₹300, reason “attendance corrected”, with the actor and the timestamp.
- **Her balance moves** — Derived, not stored — the sum of charges plus adjustments minus applications. It cannot disagree with the rows.
- **If she had already paid** — A credit or a refund is issued against the payment, and which one depends on who caused the error: the venue's mistake refunds to source, the player's overpayment stays as credit.

## 5. State machines


### Participation

States: `joined`, `confirmed`, `waitlisted`, `withdrawn`, `checked_in`, `played`, `absent`
Happy path: `joined` -> `confirmed` -> `checked_in` -> `played`
- **Gate**: The confirmation gate is a real transition, not a notification. `joined → confirmed` happens when they tap; no tap by the deadline means `joined → withdrawn` and the top of the waitlist is promoted in the same transaction.
- **Illegal**: `waitlisted → checked_in` without promotion; `withdrawn → played`. A walk-in is a new participation created already `checked_in`, never a resurrected withdrawal.
- **Billing**: `checked_in` and `played` produce the normal session charge, once, after the session locks. **`absent` produces no session charge** — they did not play, so they do not owe the session fee. If the optional no-show policy is switched on, an absence produces a _separate policy charge_ with its own origin; it is never the session charge under another name, and it can be waived, priced or disabled without touching session billing at all.
- **Guests**: A guest is a participant in their own right, with their own participation row and their own attendance. The **payer** is the inviter — the guest's charge is raised against the inviter's account by default, reassignable in one tap. Keeping participant and payer separate is what stops a guest's game landing in the inviter's attendance history or counting toward their stats.
- **One place for attendance**: Attendance is folded into participation rather than modelled separately — a separate attendance object gives two places to disagree about whether someone was there.

### Charge

States: `draft`, `locked`, `settled`, `waived`, `written_off`
Happy path: `draft` -> `locked` -> `settled`
- **Immutability**: `locked` freezes the amount forever. `settled` is derived from applications reaching the total, not set by hand.
- **Illegal**: Any edit to a locked amount. Any transition out of `settled` — a refund creates new rows, it does not un-settle.

### Payment

States: `initiated`, `succeeded`, `failed`, `reversed`
Happy path: `initiated` -> `succeeded`
- **Allocation**: A succeeded payment is allocated to charges oldest-first, skipping any that are reserved. Anything left over is `unallocated` and visible, never silently absorbed.
- **Illegal**: `succeeded → failed`. Out-of-order webhooks are handled by refusing backward transitions, not by trusting arrival order.

### Collection attempt

States: `created`, `reserved`, `notified`, `awaiting_window`, `submitting`, `submitted`, `succeeded`, `failed`, `unknown`
Happy path: `created` -> `reserved` -> `notified` -> `submitting` -> `submitted` -> `succeeded`
- **Write-ahead**: `submitting` is committed _before_ the API call, with the provider id already chosen. That commit is what makes a lost response recoverable — you can ask the provider about an id you know you sent.
- **Unknown**: A lost response goes to `unknown` with the reservation still held, and is resolved by a probe or, failing that, by a named human. The full procedure is under _Concurrency_ above — who probes, when, what each answer does, and who may resolve it.

### Mandate

States: `pending`, `active`, `paused`, `revoked`, `expired`, `dead`
Happy path: `pending` -> `active`
- **No warning**: Players revoke from their own UPI app and nothing tells you. A pre-flight status check runs immediately before every submission — cheap, and the only reliable guard, because revocation webhooks lag.
- **Illegal**: Debiting anything not `active`. Submitting against a known-dead mandate is a guaranteed decline that damages your success ratio with the acquirer for nothing.

### Sweep run

States: `scheduled`, `notifying`, `notified`, `awaiting_window`, `submitting`, `in_flight`, `retry_scheduled`, `notice_expired`, `succeeded`, `failed_exhausted`, `cancelled_settled`, `cancelled_mandate_invalid`, `abandoned`, `manual_review`
Happy path: `scheduled` -> `notified` -> `in_flight` -> `succeeded`
- **One at a time**: A player has at most one sweep in a non-terminal state, and a charge belongs to at most one non-terminal sweep. Both are unique indexes.
- **Notice binds**: The notice binds to an amount and a date. Past that date it is void — debiting on a stale notice is an unnotified debit. A retry that falls outside the notified date needs a fresh notice, not a blind re-send.
- **Never upward**: The debit is never more than the notified amount. Less is fine — if they paid a link in the gap, submit the smaller remainder. New charges accrued after the notice go to the next sweep.

## 6. Concurrency: the sweep race

```
t0   sweep    reads outstanding          Rs 900
t1   player   pays Rs 900 by link; webhook applies it; balance -> Rs 0
t2   sweep    submits debit                Rs 900     <- collected twice
```
```
  player  --1:N-->  charge              what is owed; immutable once locked
  player  --1:N-->  sweep               a decision to collect a set of charges
  sweep   --1:N-->  collection attempt  one try - a link, or a mandate debit
  attempt --1:N-->  reservation         one row per charge that attempt holds

  a reservation names exactly one (attempt, charge) pair
```

### Guarantees and what enforces them

- **One charge cannot have two live reservations** — `UNIQUE (charge_id) WHERE released_at IS NULL` on the reservation table. A second reserver is refused by the database, not by a check someone might forget to write.
- **One collection attempt cannot reserve the same charge twice** — `UNIQUE (attempt_id, charge_id)`, unconditional — so it still holds after release, and a replayed worker cannot duplicate a line.
- **One player cannot have two live sweeps** — `UNIQUE (player_id) WHERE state NOT IN (terminal states)` on the sweep table.
- **A charge belongs to at most one live sweep** — Follows from the first two: a sweep only ever acts on charges its own attempt holds, and a charge can be held once.
- **An attempt's charge set is atomic with its amount** — All reservations for one attempt are inserted in a single transaction. A partial reservation aborts the whole attempt and it re-selects — the set of charges and the amount to be debited are the same fact, so they cannot drift apart.

### The interlock

```sql
CREATE UNIQUE INDEX one_live_reservation_per_charge
  ON collection_attempt_charge (charge_id) WHERE released_at IS NULL;
```

### Why not the obvious primitive

- **SELECT … FOR UPDATE** — Row locks die with the transaction. The hold has to span a day, and more importantly has to span an HTTP call — holding a transaction open across a network call on a pooled connection deadlocks the app under trivial load.
- **Advisory lock** — Session-scoped, so it evaporates when the function returns. Invisible to ordinary queries, so the operator cannot ask why a charge is unpayable. No audit trail.
- **Optimistic version column** — Detects the conflict afterwards. It cannot express durable intent, so it cannot stop the link page offering a charge the sweep is about to debit — it only tells you later that someone lost.
- **A status enum on the charge** — Mutates the charge, which breaks immutability; cannot record who reserved it or for how much; and “reserved” is not a settlement state, so putting both in one column makes one unrepresentable while the other holds.

### Release rules

- **On success** — Released in the same transaction that records the payment and applies it. There is never an instant where a charge is both unsettled and unreserved.
- **On a definite failure** — Released with a reason, the charge gets a short cooldown, and the link path takes over.
- **On a lost response** — The attempt sits in `submitting` with the reservation held. A probe job asks the provider about the id it already committed — not found means release and retry safely; found means apply the real outcome.
- **Never on a timer** — There is no elapsed-time rule that releases a reservation. That rule is the bug this design exists to prevent.

### When the outcome is unknown

- **When the probe runs** — The attempt enters `submitting`, committed _before_ the call, with its provider id already chosen. A probe job walks attempts stuck in `submitting` on a backoff — a minute, five, fifteen, an hour, six hours — and asks Cashfree about that id. This is only possible because the id was committed first.
- **Provider never received it** — No money moved. Release the reservation, mark the attempt failed. A fresh attempt may then be created with a new id and a new key.
- **Confirmed success** — Apply it exactly as if the webhook had arrived: record the payment, apply it to the reserved charges, release the reservations — one transaction, same code path as the webhook.
- **Confirmed failure** — Release the reservation with a reason, put a short cooldown on the charges, and let the link path take over. Retry only if the notice is still valid for its date.
- **Probes exhausted** — After a day unresolved, the attempt moves to `unknown` and **the reservation stays held**. It pins to the top of the collections page with its age and amount. Nothing automatic touches it again.
- **Who resolves it** — A host holding the collections permission, after checking the Cashfree dashboard. Two actions: _confirm collected_ records the payment and releases, _confirm not collected_ releases and reopens the charges. Both write an audit row naming the actor and what they saw.
- **Why the reservation is held throughout** — So nothing else — a link, a later sweep, a second worker — can collect those charges while their fate is unresolved. The bias is deliberate: freeze rather than retry. An uncollected ₹900 is a WhatsApp message; a twice-collected ₹900 is a refund, an apology, and a player who stops trusting the billing.

## 7. The scheduling engine


### The seven settings

- **`minNoticePeriod`** = `25h` — [floor verified] RBI requires at least 24h. **25h is our own default**, not an external rule — it clears the floor with margin. [confirm] what Cashfree enforces on our account, then set this to whichever is larger.
- **`safetyMargin`** = `3h` — **Our policy.** Absorbs job lag and clock skew so a debit can never land short of the notice period. Tune it down once there is real timing data.
- **`executionWindows`** = `13:00–17:00 and 21:30–10:00 IST` — [confirm] NPCI restriction, reported as effective Aug 2025. The second window wraps midnight, so every test fixture must include a midnight crossing.
- **`providerLeadTime`** = `12h` — [confirm] how far ahead of the target date a charge must be submitted to be picked up for that date.
- **`scheduleGranularity`** = `DATE` — [verified] Cashfree's field is a date, not a timestamp. If they ever expose a time, flipping this recovers about a day with no code change.
- **`maxAttempts`** = `4` — [confirm] one attempt plus three retries is what Cashfree documents; sources disagree on the exact number.
- **`sweepFloor` · `sweepCeiling` · `maxBalanceAge`** = `₹200 · ₹3,000 · 30 days` — **Ours.** Below the floor, defer. Above the ceiling, sweep early — insufficient balance is the dominant UPI failure and smaller debits decline less. Past the age limit, sweep regardless, so a once-a-month player's ₹300 never sits under the floor forever.

### Eligibility, computed

```
**evaluateSweep**(player, charges, mandate, now, policy):

  amount = sum(charges: locked, unswept, settled-delay elapsed)
  if amount = 0                     → NoSweep(nothing owed)
  if a non-terminal sweep exists    → NoSweep(one at a time)
  if mandate not active             → NoSweep(needs mandate) + flag player

  due = cadence day reached
      or amount ≥ sweepCeiling             **-- cap exposure and debit size**
      or oldest charge is aging            **-- nothing rots**
      or mandate expires soon              **-- collect before the rail dies**
  if not due                        → NoSweep(not due, next eval at …)
  if amount > mandate cap            → take oldest charges up to the cap, rest rolls over

  earliestLawful = now + minNoticePeriod + safetyMargin

  **-- fixed point: under DATE granularity the provider may fire at the earliest
  -- legal instant of the target date, so the date must clear earliestLawful**
  D = date(earliestLawful)
  while earliestExecutableInstantOn(D) < earliestLawful:  D = D + 1 day
  while D < date(now + providerLeadTime):                 D = D + 1 day

  freeze the charge set, reserve every charge, snapshot the policy version
  return Sweep(amount, D, windows(D), noticeValidUntil)
```

### When it goes wrong

- **Scheduler didn't run** — The tick is a reconciler, not a queue drainer — it asks what state each sweep _should_ be in. A player missed for three weeks yields **one** sweep for the accumulated balance, never three replayed cycles. Sweeps raised late recompute their dates from the new now, so the notice is fresh. _(₹0 lost. Collection slips by the outage.)_
- **Notice sent, window passed** — The notice is void once its date is gone. Recompute and re-notice, up to a limit, then hand to a human. _(₹0 moved. No double charge is possible — the charges never left the sweep.)_
- **Declined inside the window** — Classify first. Insufficient funds or a technical decline retries on a backoff, re-snapped into a legal window. A mandate problem skips retries entirely. _(₹0 moved. Attempt counter persisted before submission, so a crash can't buy a free attempt.)_
- **All retries exhausted** — Release the charges back to the pool flagged overdue, put the player on a cooldown so the next cycle doesn't immediately re-attempt the same dead mandate, and send a link. _(₹0 moved. Debt persists and is visible. Never written off automatically at this stage.)_
- **Mandate revoked in the gap** — Caught by the pre-flight status check. Abort without submitting. _(₹0 moved. No wasted attempt, no damage to the merchant success ratio.)_
- **They paid a link after the notice** — Recompute at submission. Zero due means cancel and don't submit. Less due means submit the smaller amount — a debit below the notified amount is covered by the notice. _(They never pay twice.)_
- **Response lost mid-submit** — Never blind-resubmit. Probe the provider with the id committed before the call. _(At most one debit per attempt, provably.)_

### Page loads must not move money

- **A GET that moves money** — Browser prefetch, link unfurling when the URL is pasted into a WhatsApp group, uptime monitors, the back button — all issue that request. Money moves because someone shared a link.
- **Partial execution** — The request dies when the admin navigates away or the function times out. Sweeps created for 40 players, notices sent for 28, debits submitted for 12. Nothing resumes it, and the ledger now disagrees with the provider. Silent and guaranteed, not probabilistic.
- **Unpredictable timing** — The notice-to-debit interval — the one interval the regulator cares about — becomes a function of when someone opened a browser.
- **Nothing to say in a dispute** — “Why was I charged at 14:37 on a Thursday?” has no answer beyond “a page loaded”. No actor, no intent, and in the access log it is indistinguishable from a read.
- **Anyone with read access moves money** — A part-time coach checking the schedule gains a power nobody granted them.
- **Untestable** — You cannot assert “given this clock, exactly these sweeps are raised” if raising one requires simulating a render.

Exactly three trigger sources, enforced by the type system (no `PAGE_RENDER` variant): a **scheduler tick** runs the reconciler; a **signed webhook** applies a provider outcome; an **explicit admin command** enqueues a job.

## 8. Identity, access and privacy

- **Canonical identity** — One player row per human. The normalised phone number is the key — stripped of +91, spaces and leading zeros, with a unique index — which prevents the great majority of duplicates for free.
- **Phone verification** — One OTP, demanded exactly once: at the moment a payment method is first linked. Not at join. An unverified phone can join games and owe money; it cannot carry a mandate.
- **Device sessions** — A signed, long-lived device token issued after verification. It proves “this device belongs to the person who verified this number” and is what lets a logged-out phone see its own charges.
- **What needs re-verification** — Linking a new mandate, cancelling one, changing the phone number, or viewing financial history from an unrecognised device. Joining a game and cancelling a spot do not.
- **Cancelling a mandate** — Always available from the player's own UPI app — we cannot prevent that and should not try. In-app cancellation is offered too, behind re-verification.
- **Changing a phone number** — Verify the new number, then move the identity. The mandate does not move — it is bound to the old number at the bank, so it must be cancelled and re-authorised. Say so plainly before they start.
- **Duplicate players** — Merging is a money operation, not a roster tidy-up. The current merge hard-deletes a row; it must be refused outright when either side has an unsettled charge or a live mandate.
- **Financial access** — Reading or acting on charges, payments and mandates requires a verified device bound to that player, or a host with an explicit collections permission. Host permissions are separate from ordinary admin — seeing the schedule is not the same as moving money.

### Privacy

- **Public on the game page** — First name and last initial. Spots taken. Session price. Nothing else.
- **Never public** — Phone numbers, balances, what anyone owes, payment status, no-show history, mandate status. None of it appears on any page reachable without a verified session.
- **Enforced server-side** — The public endpoint's response omits the fields entirely — filtering in the frontend is a leak, not a control.
- **Opt out of the list** — A player can hide their name from the public list without being blocked from joining. Some people don't want their Tuesday evenings advertised.
- **Host visibility is logged** — Who looked at what is recorded, because “host” will eventually be more than one person.

## 9. Decisions


### Does a no-show get charged?

Paying afterwards removes the thing that made people turn up. Joining is now free, so joining is cheap, so the cap fills with people who won't come.
- **Recommended (CHOSEN)** — _The confirmation gate, as a state transition._ Three hours before start, `joined` must become `confirmed`. No tap by an hour before and it becomes `withdrawn`, promoting the waitlist atomically. Costs the player nothing, and turns a no-show into a spot someone else uses.
- **Plus (CHOSEN)** — _An optional ₹150 no-show charge that waives itself_ when they next check in. It is a **policy charge with its own origin**, never the session fee applied to someone who did not play — so it can be repriced, waived or switched off entirely without touching how sessions are billed. Collectible in principle, forgiving in practice, and it pulls them back to the venue instead of pushing them away.
- **Not this** — _Actually debiting someone for a game they didn't play._ It's the fastest way to get a mandate revoked. The threat works; firing it doesn't.

### What happens when someone doesn't pay

The ladder should end with you, in person, not with a fourth SMS.
- **Recommended (CHOSEN)** — _Automated for seven days, then a red ₹ next to their name at check-in._ One nudge an hour after the game — the highest-yield moment there is — one next morning, one after a day. Then it stops.
- **Why** — With twenty regulars and a front desk, _the most effective collection tool you have is seeing the number when they walk in on Thursday._ It converts better than any reminder will.
- **Write-off** — Under ₹500 and older than a month, write it off automatically — as a recorded decision, not a deletion. Even 5% bad debt is a few thousand rupees a month; one lost regular costs more than a year of it.

### Vercel Pro, about ₹1,800 a month

Not a preference — the free plan can't run this.
- **The problem** — Vercel's free plan _forbids commercial use_, and caps scheduled jobs at _one run per day_. A once-daily job means a notice can silently age past its validity before anything acts on it.
- **Recommended (CHOSEN)** — _Vercel Pro, $20/month._ Scheduled jobs at minute granularity, longer function limits, and a licence that covers taking money. About 0.4% of one month's takings.
- **Design rule** — Even so, _correctness never depends on the scheduler._ The tick is a reconciler that asks what state each sweep should be in — so a missed tick is lost time, not lost work, and three missed weeks produce one sweep, not three.

## 10. The build ladder


### Stage 1 — The list and the join

_4–6 days · ships on its own, no payments at all_

- `s1a` **[IN]** Public games page — One list. Date, time, price, “12/16 spots”, and who's already in as first name and last initial. No login, no nav bar.
- `s1b` **[IN]** Join with name and phone — Two fields, prefilled for a returning device. Phone normalised and matched to the existing roster. No payment step.
- `s1c` **[IN]** Spots counter with a soft cap — 16 is comfortable, 18 is fine. A one-tap “open 4 more” handles the regular you'd never turn away.
- `s1m` **[IN]** The confirmation gate as a state — `joined → confirmed` three hours before start. No tap by an hour before and it becomes `withdrawn`, promoting the waitlist in the same transaction. This is what replaces prepayment, and it is a transition, not a reminder.
- `s1d` **[IN]** Waitlist that promotes itself — Promotion is atomic with the withdrawal it came from, so a spot can never be given to two people. The promoted name also lands in front of you with a one-tap WhatsApp message.
- `s1e` **[IN]** Self-cancel right up to start time — No penalty. A cancellation at 18:40 frees a spot; punishing it converts late cancels into silent no-shows.
- `s1g` **[IN]** Share to WhatsApp with the live count in the text — Not a bare link — “Tue 7–9pm, 2 courts, ₹300. 6/16 in.”
- `s1h` **[IN]** Host adds anyone, any time, name only — A third of people will always reply in the group instead of tapping. You're the router.
- `s1i` **[IN]** Tonight screen — One list, one row per human: name, here?, money. Tap to check in, add a walk-in. One screen, not four.
- `s1k` **[IN]** Guest of a regular, added on the night — The guest is the participant; the inviter is the payer. The guest gets their own participation and their own attendance, and the charge goes to the inviter's account by default because they have the history and possibly the mandate. Separating the two means a guest's session never shows up in the inviter's attendance record or stats, and either side can be corrected without disturbing the other.
- `s1l` **[IN]** Auto-end 30 minutes after the session is due to finish — Never wait for a human to start the money flow. If the host did nothing all night, nobody is charged and he gets a push — failing to charge is recoverable, wrongly charging sixteen people isn't.

### Stage 2 — Courts stop being a guess

_3–4 days · also fixes a bug that already bites tournaments_

- `s2a` **[IN]** Courts held for a time range, not a whole day — Today one tournament owns a court for the entire day with no lending, so a 7pm social can't get a court on a tournament day. This also fixes the existing bug where a two-day tournament loses its courts on day two.
- `s2b` **[IN]** Block a court — Coaching batch, maintenance, private booking, broken net.
- `s2c` **[IN]** Two sessions sharing courts — Beginners 6–8, intermediate 7–9, swapping at 7:30. Normal, and impossible in the current model.
- `s2d` **[IN]** Change courts, extend, or shrink a live session — “Anna, can we go till 9:30, Court 3 is free.”
- `s2e` **[IN]** Free-slot view — For a fixed booked game, availability _is_ the product.

### Stage 3 — The money model — no gateway yet

_4–5 days · the foundation stages 4–6 depend on, replaces the notebook_

- `m1` **[IN]** Charges, adjustments, payments, applications, credits — Five objects, cleanly separated. A charge is immutable once locked; every correction is a new signed row. This is the stage that makes partial payments and corrections expressible at all.
- `m22` **[IN]** The five database constraints — Can't over-settle a charge, can't spend a payment twice, can't double-collect, can't double-bill a game, can't double-process a webhook. Written now, before anything can violate them.
- `m23` **[IN]** Reservations and the write-ahead rule — The partial unique index, the short reserve transaction, and the rule that no external call ever happens inside an open transaction. Built before a gateway exists so it is never retrofitted.
- `m2` **[IN]** Balance as a derived view, not a stored number — A balance you store is a number that can be wrong. Derived from charges plus adjustments minus applications, it cannot disagree with the rows.
- `m3` **[IN]** Payment method separated from settlement status — Cash, venue QR, gateway, credit are _methods_. Open, partly settled, settled, waived, written off are _statuses_. “Owes” is neither — it is a balance being positive.
- `m4` **[IN]** Day-end tally split by method — Cash matches the drawer, gateway matches the settlement record. The moment they don't reconcile you stop trusting the app.
- `m5` **[IN]** Per-player price override and free roles — A role on the participation, not a permanent exemption — a coach who turns up on Sunday to play should pay.
- `m6` **[IN]** Provisional amount shown before it locks — “₹300 for tonight — locking at 9:45pm. Tap if this looks wrong.” Moving a dispute to before the money moves is the cheapest dispute handling there is.

### Stage 4 — Cashfree, one-off links

_5–6 days · money arrives with nobody matching it by hand_

- `m7` **[IN]** Payment link as a reserved collection attempt — Creating a link reserves the charges it covers, so the link amount is provably backed by charges nothing else can touch — and a later sweep skips them.
- `m8` **[IN]** Automatic reminders — One an hour after the game, one next morning, one after a day. Then it stops and becomes a red ₹ at the desk. Four messages per debt, ever.
- `m9` **[IN]** Webhook with raw-body signature checking and a durable inbox — Verified against the exact bytes received, stored before interpretation, deduplicated by provider event id, and refusing backward transitions so out-of-order delivery is harmless.
- `m24` **[IN]** The probe job for lost responses — Every attempt commits its provider id before the call, so an unanswered request can always be resolved by asking the provider about an id we know we sent. Never blind-resubmit.
- `m10` **[IN]** Nightly reconciliation against Cashfree — Cashfree is the source of truth. Completeness, in-flight hygiene, cross-footing, and a canary that fires when a day has payments but no webhook events. Reads the _actual_ fee and tax from the settlement record rather than assuming a rate card.
- `m11` **[IN]** Vercel Pro and scheduled jobs — Required — the free plan forbids commercial use and runs jobs once a day. Correctness never depends on the scheduler being on time, but collection timing does.

### Stage 5 — Identity and the mandate

_5–6 days · the first player turns on auto-pay_

- `m12` **[IN]** Phone verified once, by OTP, only when money attaches — Not at join. This is also what makes the mandate lawful and a dispute defensible.
- `m25` **[IN]** Device sessions and financial access control — A signed device token bound to a verified player, and a separate collections permission for hosts. Seeing the schedule is not the same as moving money.
- `m13` **[IN]** UPI Autopay mandate, variable amount up to a cap — One PIN, ever. Cap shown to the player as a protection: “₹1,000 max per charge — we can never take more.”
- `m14` **[IN]** The ask, after their second clean link payment — Not at signup. Nobody grants a standing claim on their bank account to a venue that hasn't billed them correctly yet.
- `m15` **[IN]** Pre-flight mandate check, and daily attrition sweep — Players revoke from their own app and nothing tells you. Check status immediately before every submission, and flag “3 players need to re-link” daily instead of discovering it while chasing them.

### Stage 6 — The scheduling engine

_4–5 days · this is the part you asked for_

- `m26` **[IN]** Eligibility computed from policy, not a hardcoded weekday — A pure function of charges, mandate, policy and now. No literal durations anywhere; every sweep records the policy version that produced it.
- `m16` **[IN]** Per-player anchored weekly sweep — Their sweep day is the weekday of their first charge. Spreads the book across seven days so one bad day costs a seventh of the week, not all of it.
- `m27` **[IN]** Ceiling, aging and expiry overrides — Sweep early if the balance crosses a ceiling, if the oldest charge is aging, or if the mandate is about to expire. Defer if it is below the floor and nothing is aging.
- `m18` **[IN]** Decline classification and bounded retries — Insufficient funds retries on a backoff re-snapped into a legal window; a mandate problem skips retries entirely. Attempt count persisted before submission.
- `m28` **[IN]** Collections page is a pure read — Shows scheduler health, the next 48 hours, and a needs-attention list. One-tap actions enqueue a job; they never move money inline.
- `m19` **[IN]** Venue credit instead of refunds, with a surplus rule — Who caused the surplus decides: the venue double-collecting refunds to source within 24 hours; a player overpaying keeps credit against their next game; a cancelled session always refunds in full.
- `m20` **[IN]** Rain: end early and prorate — Two buttons — charge nothing, or the short-session rate. No slider.
- `m21` **[LATER]** Prepay as a per-session switch — Once charges exist, demanding payment upfront for a busy Saturday is nearly free to add. Build the switch, default it off.

### Stage 7 — The night, and the habit

_6–8 days · only worth it once the money works_

- `s4a` **[IN]** The wall board — Each court, who's on, who's next, the wait, and a visible “updated 19:42” so a frozen board announces itself instead of lying to sixteen people.
- `s4b` **[IN]** Players add themselves to the queue — From their own phone, reading the same board. “Am I next?” stops being a question you answer.
- `s4c` **[IN]** Nobody plays twice while others wait — As a sort order, never as an error message shown to a paying customer.
- `s4d` **[IN]** Manual override, from day one — The first time software picks a bad four in front of everyone, you stop opening it.
- `s5a` **[IN]** Repeat this session — One tap makes next Tuesday from this Tuesday — which is why a full recurring-series engine isn't worth building.
- `s5c` **[IN]** Cancellation blast, with an undo window — It has to be as fast as typing in the group, which also makes it easy to fire at the wrong Tuesday. Name the session in the confirm, hold the refunds a few minutes.
- `s4f` **[LATER]** Auto-sort the queue — Longest waited, similar level, avoid the same partners. Optional, behind the board, host confirms.
- `s4g` **[LATER]** Score entry for social games — Nobody records friendlies — it gets used for two weeks. It's also the one feature that drags in the biggest schema rewrite.
- `s5f` **[LATER]** Regulars leaderboard — Counted on attendance, not wins — attendance is real data because you generate it at check-in anyway.
- `s5g` **[LATER]** Month-end export — Who played how often, who owes what. A CSV is enough.
- `s4h` **[OUT]** Format presets (Popcorn, Shuffle, King of the Court) — Four rotation algorithms picked from a dropdown, for things you currently say out loud at 7pm.

## 11. Three kinds of automation

- **Deterministic internal automation** — **Reliable.** Sessions repeating, charges locking, sweeps being raised, notices scheduled, reservations taken and released, reconciliation running. This is our own code against our own database. It either works or it is a bug we can fix, and it is fully testable against a fixture clock.
- **Asynchronous external payment automation** — **Best-effort, and eventually consistent.** Notices, debits, webhooks, settlement. We control when we ask; we do not control the answer or when it arrives. Debits decline, mandates die silently, webhooks get lost, settlement lands on its own schedule. The system is designed so every one of these is a normal Tuesday rather than an exception — but no promise here is instant or guaranteed.
- **Human-dependent attendance** — **Irreducible.** There is no sensor that knows who played. Everything downstream is only as good as one person tapping names for a minute. This is the input, and it cannot be automated at any price.

### Monthly human load (~35 sessions)

- **Tapping who turned up** — ~35 times · 30–60 seconds each. The load-bearing human act.
- **Typing in walk-ins** — 10–20 times · 20 seconds each.
- **Taking cash at the counter** — Declining to ~10 a month as mandates spread.
- **Disputes** — 3–8 a month at launch, settling to 1–3.
- **A word at the desk with whoever's still short** — 2–5 people a month. This is where the last 5% actually gets collected.
- **Waive / write off decisions** — 1–3 a month, one tap each.
- **Re-authorising dead mandates** — 1–3 a month. Players revoke and nothing tells you.
- **Glancing at the reconciliation number** — Weekly, one minute. If nobody ever looks, the automation is unverified rather than automatic.

## 12. Not building

- **UPI Reserve Pay as the primary rail** — _Reason updated._ Not a technical limitation — multiple debits per block are live and Cashfree ships them. Held back by limited payer-app support (Paytm, Navi, BHIM today), merchant enablement and category review, the ₹10,000 maximum block and the re-authorisation it forces, and the fact that a refund does not replenish the reserved limit. Revisit when PhonePe and Google Pay support it.
- **UPI One-Time Mandate** — Genuinely one capture per block. A PIN every session for no saving over just paying a link.
- **Charging per session on the mandate** — Roughly twelve times the fee for the same outcome swept weekly — and the ₹5 / ₹15 slab means the saving comes from aggregating _past_ ₹3,000, not from sitting under ₹1,000.
- **A venue-wide billing day** — Puts every notice and debit into one four-hour window. One failed job takes out the week.
- **Collection triggered by page loads** — A GET that moves money, partial execution on navigation, and nothing to say when a player disputes a charge.
- **A stored balance column** — A number that can silently disagree with the rows it is supposed to summarise.
- **Three-strike auto-block** — Computed from a check-in tap you'll sometimes forget, then used to block a regular you want to keep.
- **In-app chat or a social feed** — WhatsApp wins this outright. Link out to the group.
- **DUPR, Elo, or any computed rating** — Needs disciplined score logging and volume. At twenty a day it never converges.
- **Host approves every join** — Extra work at the worst moment. Instant join plus a waitlist instead.
- **A hard cutoff hours before start** — People decide at 18:40 in the car. The confirmation gate does this job better and without turning anyone away.
- **Court QR self check-in** — People arrive with a bag in one hand and a bottle in the other.
- **Prepaid passes and punch cards** — A balance ledger with its own support burden. Revisit after six real Tuesdays.
- **Memberships, tiers, prime-time rules, karma points, cross-venue anything** — Built for marketplaces with hundreds of venues. You have one.
- **Add-to-calendar, profile pages, session photos** — Each is one afternoon and one permanent button nobody taps.

## 13. Engineering calls already made

- **Codebase** — Build in `app/` — the Next.js tree on Vercel. It's the only one getting real commits. Move the Go tree to a branch and fix the README paragraph that says the opposite, in the same PR.
- **How a session exists** — A session is a tournament row with `kind = 'session'` plus its one category row. The matches table isn't touched — so “no two live matches on one court” and “same player can't be live twice” cover sessions for free.
- **Court ownership** — Replace one-court-per-day with a held-from / held-until range. The day grain is already being worked around in three places in the code.
- **Money tables** — Charge, adjustment, payment, application, credit, refund, collection attempt, reservation, mandate, webhook event. Ten objects sounds like a lot until you try to express “Ravi paid ₹1,400 for four people, one of whom was over-billed” without them.
- **Never edit a charge** — Append only. A delete trigger raises on every money table. Corrections are new signed rows.
- **Money representation** — Integer paise. No floats anywhere. Currency pinned to INR by a constraint.
- **Cashfree specifics** — [confirm] Autopay needs manual activation by an account manager — ask on day one, it's the long pole, and merchant eligibility for our category is not established. Sandbox works before KYC finishes. Their docs are mid-migration and a third of the API URLs 404; budget for that. Never cite `test.cashfree.com`, which is publicly indexed and serves production-looking content.
- **Settlement** — [verified] T+2 bank working days is the contractual default and the cycle is a per-merchant setting. [confirm] what this account actually gets. Either way the app **reads settlement, never assumes it**: subscribe to settlement webhooks, match by payment and settlement id, and take the real fee and tax from the settlement record rather than any rate card.
- **Provider facts in general** — Every provider-dependent number in this document is tagged [verified], [assumption] or [confirm]. Nothing tagged _confirm_ may become a hard-coded product rule before Cashfree answers in writing — it goes in as a setting with a default.
- **Merging duplicate players** — The current merge hard-deletes a player row. Refuse it outright when either side has an unsettled charge or a live mandate.

## 14. Questions for Cashfree (unanswered — settings with defaults, never product rules)

- **Does the 1.95% platform fee apply to mandate debits on top of the ₹5 / ₹15 per-debit fee?** — **Ask this first.** It is the difference between weekly aggregation saving 77% and saving 37%, and it changes whether the mandate path is worth building at all.
- **Is our use case supported?** — A recreational sports venue charging variable amounts for sessions attended. Confirm the merchant category is eligible for UPI Autopay, and ask whether there is a negative list.
- **Can a weekly aggregate debit be generated from charges accumulated dynamically?** — The amount is not known until the week ends. Confirm an as-presented or on-demand variable mandate supports this, and that nothing requires the amount to be fixed at registration.
- **What notice period does Cashfree actually enforce between the pre-debit notification and the charge?** — RBI's floor is 24 hours. Cashfree's FAQ describes about 25. Is that their rule, the acquirer's, or a rounding of the floor — and is it ever longer? The answer sets one setting; it must not be guessed. Also confirm the API call, who delivers the notice, and what happens when delivery fails.
- **Are failed debits billed? Are retries billed separately?** — Not published anywhere. At realistic decline rates this is a real line item.
- **What are the mandate limits?** — Maximum amount per debit, maximum mandate validity, and whether a variable cap can be changed after registration without re-authorisation.
- **What is the retry behaviour?** — How many attempts, over what period, and whether a retry outside the notified date requires a fresh notice.
- **What webhook events exist for mandates and debits, exactly?** — The public reference is thin. Ask specifically whether there is any event on mandate revocation and on block or mandate expiry, or whether we must poll.
- **Is there a per-message charge for SMS or WhatsApp link delivery?** — Not published. At 2,000 links a month it matters.
- **Is the ₹20 lakh promotion cap cumulative or monthly?** — Cashfree's own pages disagree, and it is a tenfold difference in the value of the offer.
- **Does the ₹4,999 annual maintenance charge apply?** — It appears on one Cashfree pricing page and not the other.
- **What settlement cycle will this account actually get?** — And is there an initial hold for a new merchant, does the campaign T+1 revert to T+2 after March 2027, and is there any API to read the configured cycle?

## 15. Changes from v1

- **Corrected — UPI Reserve Pay** — v1 said NPCI allows only one capture per block. That is true of One-Time Mandate only. Single Block Multiple Debits has been live since 2024 and Cashfree ships it as Reserve Pay — it is _technically capable_ of what was asked for. It stays out of the primary plan for practical reasons: limited payer-app support, merchant enablement and category review, the ₹10,000 maximum block and the re-authorisation it forces, and the fact that a refund does not replenish the reserved limit. Block-lifetime figures appear only as illustration, not as a claim.
- **Corrected — notice period** — The 25-hour figure was presented as a requirement. The **regulatory floor is 24 hours** where it applies; Cashfree's own rule may be stricter and is unconfirmed. The 25-hour default and the 3-hour safety margin are now stated as _our_ implementation policy, and the notice period is a setting rather than a constant.
- **Corrected — absence does not create a session charge** — v1's state machine said both `played` and `absent` produce a charge, which contradicted the confirmation-gate model. Now: presence produces the session charge; absence produces none. The optional no-show fee is a _separate policy charge_ with its own origin, so it can be repriced, waived or switched off without touching session billing.
- **Clarified — guests** — Participant and payer are explicitly separate. The guest owns their participation and their attendance; the inviter owns the charge. A guest's session never enters the inviter's attendance history or statistics.
- **Added — the reservation schema** — Sweep, collection attempt, reservation and charge are now related explicitly, with the constraint behind each guarantee: one charge cannot hold two live reservations, one attempt cannot reserve a charge twice, one player cannot have two live sweeps.
- **Added — the unknown-outcome procedure** — When a provider response is lost: when the probe runs, what each answer does, when it becomes manual review, who may resolve it, and why the reservation stays held until it is.
- **Simplified — the scheduling engine** — Reduced to seven settings and one eligibility function. Removed the speculative multi-acquirer framing; this is a calculation over a few values, not a rules engine for providers we do not have.
- **Corrected — payment links are not free** — Zero MDR is about the rail, not the gateway. Cashfree's 1.95% platform fee applies to UPI. Links are free only under a new-merchant promotion capped at ₹20 lakh cumulative and ending March 2027.
- **Corrected — the per-debit fee is two numbers** — ₹5 below ₹1,000 and ₹15 at or above, plus ₹7.50 per registration. The promotion excludes subscriptions entirely. The cost table now tags every figure as published or to-be-confirmed, and gives ranges rather than single numbers.
- **Corrected — settlement** — T+2 bank working days is the contractual default, not T+1, and the cycle is a per-merchant setting. The app now reads settlement rather than assuming it, and takes the real fee from the settlement record.
- **Added — the money model** — Charge, adjustment, payment, application, credit, refund, collection attempt, reservation, mandate and webhook event are now separate objects with defined boundaries. Payment method is separated from settlement status; “owes” is a derived balance, not a method. Balance is a view, not a column.
- **Added — the reservation interlock** — Charges are reserved by a partial unique index before any external call, and released only on provider confirmation, never on a timer. This replaces v1's “the sweep reads the live balance”, which was a read-then-act race across a day-long gap.
- **Added — the scheduling engine** — The hardcoded “Sunday notice, Monday evening debit” is replaced by a pure function that computes the earliest lawful debit date from versioned policy parameters, handling date-only provider granularity and midnight-wrapping execution windows.
- **Added — state machines** — Participation, charge, payment, collection attempt, mandate and sweep run all have explicit states, illegal transitions, and the constraint or guard that enforces each.
- **Added — identity and privacy** — Canonical phone identity, OTP demanded once when money attaches, device sessions, what needs re-verification, and a public page that shows first name and last initial and no financial information at all.
- **Removed — collection on page load** — Money now moves from exactly three triggers: a scheduler tick, a signed webhook, or an explicit admin command that enqueues a job. The collections page is a pure read.
- **Changed — the confirmation gate** — Now a real participation state transition integrated with the waitlist and billing, rather than a notification.
- **Changed — “fully automated”** — Split into deterministic internal automation, asynchronous external payment automation, and human-dependent attendance. Only the first is reliable in the sense the phrase implies.
- **Changed — the build ladder** — Same progression, but the financial state model, the database constraints and the reservation interlock all move into stage 3, before anything touches a gateway. Seven stages instead of six.
- **Newly unresolved** — Whether the platform fee applies to mandate debits — this single answer moves the cost model by a factor of five. Whether failed debits are billed. Whether link delivery is metered. The exact notice period on our acquirer. Whether our merchant category is eligible at all. All of these are now questions to Cashfree rather than assumptions in the plan.
