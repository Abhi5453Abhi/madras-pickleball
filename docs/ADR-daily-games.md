# ADR — how daily games land in this repo

Decisions for `docs/SPEC-v4-daily-games.md`. Revision 3: two adversarial reviews before the
code was written, and four more against the finished stage. Objections that changed a
decision are named inline, so the next reader can see what has already been argued rather
than arguing it again; §12 lists the defects the later reviews proved.

Where this departs from the spec it says **DEVIATION** and says why. Everything else
follows the spec.

---

## 1. A session is its own aggregate, not a tournament row — DEVIATION

The spec's engineering call: *"A session is a tournament row with `kind = 'session'` plus
its one category row. The matches table isn't touched — so 'no two live matches on one
court' and 'same player can't be live twice' cover sessions for free."*

We are not doing that. Sessions get `game_sessions` and `session_participants`.

**The honest cost/benefit** (the first draft of this ADR overstated the case and was
called on it):

*What the split really costs.* Stage 7's wall board — each court, who's on, who's next,
the wait — has to be written against session tables instead of reusing `board.ts`. That
is a real cost, and it is not "one partial unique index". It is roughly: a
`session_court_slots` table, a queue order, and the three guards `board.ts` already has
(one live foursome per court, nobody plays twice while others wait, manual override).
Call it a few hundred lines, not a re-implementation of `board.ts` — because `board.ts` is
mostly draw flow, bracket slot resolution and offers for a knockout, none of which an
open-play rotation has. Note also that the spec itself marks score entry for social games
(`s4g`) as **later**, on the grounds that it "drags in the biggest schema rewrite" — so
the part of `matches` that would genuinely have been reused is the part the spec has
already deferred.

*What the split really buys.* Not tidiness — safety in the six stages before stage 7:

- `tournaments.status` is `draft | registration | live | completed | archived`, and
  `statusWords()` (`src/components/ui.tsx:458`) turns those into English for the
  tournament UI. A session's lifecycle is not those words.
- About twenty query sites read tournaments with no discriminator (`board.ts:178`, `:924`,
  `public.ts:236`, `:463`, `venue.ts:29`, `events.ts:154`, `:206`, `admin/page.tsx`).
  Adding `kind='session'` makes every one of them wrong by omission.
- `events.ts:24-31` holds a hard invariant that one tournament has exactly one category and
  `primaryCategory()` throws when it does not. A session would carry a dummy category row
  forever to satisfy a rule that means nothing to it.

*The error class we are choosing instead.* A missed filter in the fused design leaks a
session into the tournament list — cosmetic. A missed **union** in the split design leaves
a court looking free when it is not — not cosmetic. That is why decision 2 moves court
occupancy into one table both aggregates write to, rather than leaving it to callers to
remember to union. See below.

## 2. Court occupancy is one table, time-ranged, and it is the cross-holder guarantee
— stage 2, BUILT

`tournament_courts (court_id, day_key)` is gone. In its place, `court_holds` says who has
which court between which two instants, and both tournaments and daily sessions write to
it. Migration `0007_court_holds.sql`.

### What the old model could not say

- A court belonged to one tournament for a **whole day**, so a 7pm social could not have a
  court on a tournament day. That is `s2a`, and it is the headline.
- `unique (tournament_id, court_id)` made a **two-day tournament unrepresentable**: it could
  hold a court once, ever. `assignCourts` only ever computed one `day_key`, from
  `start_date`, so day two silently had no rows — while eight of the eleven read sites
  never filtered by day at all and went on believing the tournament held the court forever.
  The picker, which did filter by day, would happily give the same court to somebody else
  that afternoon.
- A finished tournament **pretended** to let go of its courts. `courtOptions` filtered
  completed tournaments out of the picker; the rows stayed, still holding the court under
  the index, and were deleted only opportunistically, inside the next tournament's save,
  for exactly the courts it asked for. Anything else — the board, the public page, the
  send-to-court gate — still thought a finished tournament owned its courts.
- `court_closures` had **no writer anywhere in the repo's history**. Three reads, all
  scoped to a tournament, all therefore always empty. "Block a court" (`s2b`) did not exist.

### The shape

```
court_holds(id, court_id, kind, tournament_id, session_id, reason,
            held_from, held_until, released_at, created_by_user_id, …)
```

- `kind` is `tournament | session | block`, and a CHECK ties it to the columns: exactly one
  holder, or none at all, which is a block. **No polymorphic FK-less holder** — nothing else
  in this schema is FK-less and this table is not going to be the first.
- A block is venue-wide. `court_closures.tournament_id` scoped a closure to one tournament,
  which is the wrong shape: a court with a broken net is broken for everybody.
- A block must say what for (CHECK), and must have an end. A court taken out "until further
  notice" is a court that quietly disappears.

### The guarantee: `court_hold_slots`, not the application

```
court_hold_slots(court_id, slot_start, hold_id)  primary key (court_id, slot_start)
```

One row per court per quarter hour, materialised by a trigger on `court_holds`, boundaries
rounded **outward**. Two holds that overlap by one minute share at least one slot, so the
second is refused by Postgres. Nothing in `server/courts.ts` is allowed to be the
guarantee: the checks there exist to produce a sentence naming who has the court, and the
index exists to be right when two people press Save in the same second.

**No `btree_gist` EXCLUDE.** `CREATE EXTENSION btree_gist` is fine on Neon and is **not
available in PGlite** (verified: `extension "btree_gist" is not available`), and the whole
migration file runs in one transaction, so adding it would brick the embedded database that
`npm run dev` and every test depend on. A quarter-hour grid is the price. A 14-hour
tournament day is 56 rows; an evening session is 8.

**The trigger is statement level, with transition tables** (`REFERENCING OLD TABLE`/`NEW
TABLE`, `FOR EACH STATEMENT`), and its SELECT is ordered by `(court_id, slot)`. Row level
was wrong in two ways: one statement that moves several holds at once would re-insert the
first row's slots while the second row still held the ones it was moving out of, raising on
an overlap that does not exist; and the lock order on the slot index would follow whatever
order the rows happened to arrive in, so two hosts saving the same two courts in opposite
checkbox order deadlocked instead of one of them waiting. `setHolds` sorts its VALUES list
to match the trigger's ORDER BY.

### Rounding, in both directions

Outward rounding can only ever over-reserve, which is the safe direction — but it has to be
consistent or it produces refusals nobody caused:

- **Taking a court** rounds the start DOWN to the quarter hour it is in, so a court assigned
  at 18:31 is playable at 18:31 rather than at 18:45.
- **Letting one go** (`endHoldsAt`) truncates DOWN too, so the hold left behind does not own
  the quarter hour the next holder starts in — but never below the END of the quarter hour
  it began in, because a game that ran 19:02–19:10 did use 19:00–19:15 and a row with
  `held_until <= held_from` is not one Postgres will keep.
- **Reading** — `holdsBetween` and `gaps` — widens to the same grid, so a screen that says
  "free" means free to the index. `holdsAtInstant` is the exact query, for the two places
  that ask "what is happening right now": the live board and the public gate sign.
- **Taking a court whose quarter hour is already spoken for** walks forward to the first
  free slot rather than being refused. A block that ended at 19:05 still owns 19:00; the
  answer the venue wants is "you have it from 19:15", not "pick another court".

`resolveWindows` is the single place all of this is decided, and both the check and the
write call it. Any drift between them is the bug class that turns "Court 3 is free" into a
refusal, so there is exactly one function that can drift.

### Hours are stored, not inferred

`tournaments.court_from_min` / `court_until_min`, null meaning the whole day. The first
version read the hours back off the holds, which is wrong the moment a hold is clamped or
truncated: a court taken up at eleven made `tournamentHours` report 11:00, and the next
save moved **every other day** of a two-day tournament to match.

### Holds end when the holder ends

`finishEvent`, `deleteEvent`, `endSession`, `cancelSession` and `markAutoEnded` all release
or truncate in the same transaction as the state change, and `assignCourts` /
`setSessionCourts` re-assert the holder's state inside their own transaction — otherwise a
save that began a moment earlier could put courts back on a tournament that has just
finished, and nothing would ever release them again.

### What the migration does with the old rows

- `tournament_courts` → one whole-day hold per row, **excluding** tournaments that are
  completed, archived or soft-deleted. That makes real what the old picker only claimed.
  The old indexes guarantee no two of these can overlap.
- `court_closures` → one block hold per row, **one subtransaction at a time**. That table
  had no uniqueness of any kind, so two closures on one court in one afternoon are ordinary
  — and a single INSERT of both would collide on the slot index and abort the whole
  migration, which on this codebase means `ensureReady()` throws and the app never boots. A
  closure that cannot be placed is dropped. An open-ended closure becomes a 24-hour block:
  the product now requires an end, and re-blocking is one form.
- Both tables are then dropped. Every reader was rewritten; leaving them would leave a
  second answer to the same question.

### What this still does not cover

- **Within a tournament**, `matches_one_live_per_court` survives unchanged and still stops
  two matches going live on one court.
- **Within a session**, stage 7 gets its own one-live-foursome-per-court index.
- `livePlayerConflict` (`board.ts`) scans `matches` venue-wide and covers cross-tournament
  player clashes for free. It is blind to sessions, because a session produces no matches.
  Stage 7 must union session play into it. Written down here so it is a task, not a surprise.
- `markAutoEnded` can leave `ended_at` a few minutes after `held_until`, because the hold is
  truncated to the quarter hour. The court is the thing that has to be right.

## 3. Price and payer are Stage 1 requirements, not scope pulled forward

The first draft billed these as deviations. They are not: `s1a` puts the session price on
the public list, `s1g` puts it in the share text, and `s1k` states the
participant-versus-payer split verbatim as a Stage 1 item.

- `game_sessions.price_paise integer not null`, `check (price_paise >= 0)`, currency
  pinned to `INR` by a check. **Integer paise from the first migration. No float in this
  feature at any stage.**
- `session_participants.player_id` is who played; `payer_player_id` is who owes. Equal for
  everyone except a guest, whose payer defaults to the inviter.

**Invariant, not just a column** (`s1k`'s stated consequence): every attendance, history
and stats query keys on `player_id` and **never** on `payer_player_id`. A guest's game
never enters the inviter's attendance record. There is a test for this.

**Reaching into stage 3 once, deliberately:** the payer is snapshotted onto the charge when
the charge locks. Reassigning a payer after lock is an adjustment plus a new charge, never
an update — charges are immutable. And charges carry an `origin` (`participation` |
`policy`) from their first migration, because `absent` must never produce a session
charge.

## 4. State transitions are conditional UPDATEs

House style already: `board.ts:556-570` re-asserts the pre-state in the `WHERE` clause and
uses `.returning()` as the success test. Every session and participation transition does
the same. Illegal transitions fail as "that already happened" rather than corrupting a
row, and two hosts tapping at once cannot both win.

## 5. Capacity is structural, not a lock someone must remember — REVISED

The first draft used `pg_advisory_xact_lock(hashtext(session_id))`. Three separate
problems were found and it is gone:

- `hashtext` is STRICT, so a null id acquires **no lock and raises no error** — the
  symptom is a seventeenth seat, not an exception;
- the one-argument form shares a key space with `bootstrap.ts:36`'s literal `7231001`;
- on PGlite there is one WASM backend, so the lock is never contended (every concurrency
  test would pass vacuously) and any real wait can never be released.

More important than all three: an advisory lock binds only callers who remember to take
it, and Stage 1 has five insert paths — player join (`s1b`), host add (`s1h`), walk-in
(`s1i`), guest (`s1k`), waitlist promotion (`s1d`). One missed lock overfills the session
with no error and no audit row. The spec's own principle is *"refused by the database, not
by a check someone might forget to write."*

So, two mechanisms, neither of them advisory:

1. **`select … from game_sessions where id = ? for update`** inside the join transaction.
   Correctly namespaced by construction, no `hashtext`, returns zero rows for a bad id (a
   typo is an error, not a silent no-op), behaves identically on PGlite and behind
   PgBouncer, and is released by commit.
2. **A seat number with a partial unique index.** Each occupying participation holds
   `seat_no`, and `unique (session_id, seat_no)` over the occupying states. Two joins that
   both compute "fifteen taken, one seat left" cannot both take seat 16 — the database
   refuses the second, and the caller retries. Seats are allocated lowest-free first, so a
   withdrawal genuinely frees a seat, and lowering the cap floors on the **headcount** and
   not on the highest seat number, because seats are recycled and one person left holding
   seat twelve must not pin the cap at twelve.

Waitlist promotion happens inside the same transaction as the withdrawal that caused it,
so a freed spot can never be given to two people.

The spec's argument against advisory locks is about stage 3's **reservations**, which must
survive a day and an HTTP call. That argument stands and stage 3 uses the partial unique
index the spec specifies. These are different problems.

## 6. Nothing that changes state runs on a page render

The spec forbids collection on page load. The same rule, one stage earlier and one class
wider: **giving someone's spot away must not happen on a GET.** A WhatsApp link unfurl
must not withdraw an unconfirmed player.

Three trigger sources, and no `PAGE_RENDER` variant exists in the type: a **scheduler
tick**, a **signed webhook** (stage 4), an **explicit command** from a host or a player.

### 6a. The tick has to be sub-hourly, and Stage 1 must say so

`s1m` fires at T−3h and T−1h; `s1l` at T+30m. Vercel's free plan runs a cron **once a
day**, and Vercel Pro is `m11`, in Stage 4. The first draft named the endpoint
`/api/cron/daily` and never stated a frequency, which hid the problem rather than solving
it. Stated plainly:

- The endpoint is `/api/cron/tick`, guarded by `CRON_SECRET`, and wants a run every
  **5–15 minutes**.
- Until Vercel Pro lands it is driven by a free external pinger — a GitHub Actions
  schedule or cron-job.org — hitting the same secret-guarded URL. `planSession` never
  changes.
- **The venue is never blocked by a scheduler.** The host's Tonight screen, the game screen
  and the games list each carry a badge with the age of the last finished tick, going red
  past thirty minutes, and a "run it now" button that does exactly what the tick does. That
  badge is the whole of what replaces doing this work on a page render, so it has to be
  right precisely when the scheduler is going wrong: it reads only **finished** runs, or an
  in-flight tick — or one killed by the function time limit — would make it say "never ran"
  during every single tick.
- **One bad game does not stop the venue.** Each session reconciles in its own try/catch. The
  candidate list is ordered by start time, so without that a single session that deadlocks
  or times out would be first in the queue on every tick and the gate would stop running for
  every other game indefinitely.

The spec's "three missed weeks produce one sweep, not three" property is about
**collection**, where late is lost time rather than lost work. A confirmation gate is not
like that: promoting a waitlisted player at 03:00 for a 19:00 session is a wasted evening.
So the planner carries a **staleness horizon** and will not fire a boundary older than
`maxCatchUpHours`; it records the boundary as passed instead, and the session shows as
"the gate did not run" rather than silently doing the wrong thing late.

### 6b. The reconciler is pure, and the applier is idempotent

`planSession(session, participants, now, policy)` in `src/lib/daily-clock.ts` is pure and
never reads a clock — the house pattern from `lib/estimate.ts` and `lib/draw.ts`.

Purity alone does **not** make replay safe; it makes two overlapping ticks compute
*precisely the same actions*, which is the amplifier, not the defence. So:

- every action carries a deterministic key `(session_id, kind, boundary_at)` derived from
  the **boundary**, never from `now`;
- the applier inserts that key into `session_scheduled_actions` with
  `unique (session_id, kind, boundary_at)`, `on conflict do nothing … returning`, **in the
  same transaction as the effect**, and treats an empty return as "already done";
- every mutation re-asserts its pre-state in `WHERE`, so a replay is a zero-row update;
- the tick itself takes `pg_try_advisory_xact_lock(4231, 1)` — the **try** form, which
  never waits, so an overlapping tick returns immediately instead of queueing to run the
  whole cycle again.

That table is also where the scheduler-health badge and, later, the collections page get
their numbers.

### 6c. Waitlist promotion has one defined target state

Promotion sets `confirmed` when the confirmation window has already opened, and `joined`
when it has not. Promoting to `joined` after the deadline would have the very next tick
withdraw them; promoting to `confirmed` before the window opens would skip the gate. Every
promotion writes `promoted_at` and an audit row, and lands in the host's "needs you now"
list with a one-tap WhatsApp message — because in Stage 1 the host is the delivery channel
(6d).

### 6d. Stage 1 has no messaging API, and the design says so

There is no SMS or WhatsApp integration until Stage 4, and link delivery is a `[confirm]`
question to Cashfree even then. So in Stage 1:

- every participation has its own capability URL (`/s/<token>`, decision 8a) — that is the
  "tap to confirm" link;
- the host's Tonight screen lists who has not confirmed, each with a one-tap `wa.me` link
  carrying the text and that player's own URL;
- a player returning to the public session page on the same device sees Confirm as the
  primary action.

The confirmation gate is a **per-session switch**, default on. A host who has not told
anyone can turn it off for that session rather than having sixteen people silently
withdrawn.

## 7. The public page is a pure read with server-side redaction

`src/server/daily-public.ts` mirrors `public.ts`: no `server-only`, `cache()`-wrapped,
cookie-free, and **explicit mappers, never a raw row**. Public rows carry first name plus
last initial and nothing else. Phone numbers, balances, attendance history and payment
status are absent from the selected columns, not filtered in the component.

Freshness is not sacrificed to caching: like every other page here the route is
`export const dynamic = 'force-dynamic'` and calls `ensureReady()`; the live spot count
comes from `<LiveRefresh>` polling a cookie-free `s-maxage=2` version route, exactly as
`t/[slug]` already does. "Cookie-free" buys the *version route* its CDN cache, not the
page. Returning-device prefill is `localStorage`, client-side, as in `r/[token]/form.tsx`.

`hide_from_public` lets a player stay off the visible list without being blocked from
joining.

## 8. Identity reuses `players`

`normalizePhone()` (`lib/parse-players.ts:44`) and `players_phone_key_uq` are the dedupe
basis, unchanged. A join matches an existing player on phone **and** name — the rule
`registration.ts:323` already uses, for the reason it already gives: the same number under
a different name must not reveal whose number it is.

**One number holds one spot per game**, whatever name it is typed under. Without that
rule the same phone under sixteen different names takes sixteen seats — `resolvePlayer`
deliberately refuses to move a number onto a different name, so each alias becomes a fresh
player and a fresh seat. The check runs before a player is resolved at all, and its answer
is the same shape whether the name matched or not, so the public form cannot be used to ask
"is this number Suresh's?".

The response is the same for somebody who has just joined and somebody who was already on
the list — the earlier version returned `alreadyIn` to the browser, which made the form a
one-request oracle answering *is this number playing tonight* for any number under any name.
**One residual signal is not closeable here and should not be pretended away:** the public
page shows the count, so anybody can watch whether joining moved it. Limits make that slow;
the OTP at stage 5, demanded when a payment method is linked, is what makes it wrong.

A host adding a **name only** (`s1h`, `s1k`) has no phone to match on. It matches a
same-name player already in the venue's book — phone or no phone, which is what
`registration.ts:331` has always done and is right for the host, who is looking at the
person. What it refuses is a bare name that exactly matches somebody **already on this
list**: that is either a second Priya or a second tap, and only the host can say which, so
they are asked for a surname or a number rather than having a duplicate player created for
them in silence.

**This one also expires.** A walk-in "Deepak Raj" still binds silently to member Deepak Raj's
player row when he is not himself on that list. Today that is a wrong attendance row, which
is recoverable. Once stage 3 raises charges it is a misdirected debit, and at that point the
exact-name match against a phone-bearing player has to become a one-tap host confirmation —
"the Deepak Raj on 98400 12345?" — using the `flagged` value the join already computes and
currently only half uses.

### 8a. Self-cancel needs authority, and Stage 1 has none without this

`s1e` is self-cancel with no login. Device sessions are `m25`, in Stage 5. Without
something in between, anyone who can read the public page can cancel any named player —
and `s1d` then promotes the waitlist, so the griefing is amplified rather than merely
annoying.

So each participation gets 160 random bits at `/s/<token>` — noindex, and the only
authority confirm and cancel accept. The device keeps its own tokens in `localStorage` so a
returning phone sees its spot without typing anything, and the token is handed back on a
repeat join only to the device that already holds it.

**It is drawn, and it is stored as it is rather than hashed — DEVIATION from every other
token in this schema.** Two earlier designs were tried and both were wrong:

- *Hashed, like `registrationTokens`.* In stage 1 the host **is** the delivery channel: the
  Tonight screen has to put a one-tap WhatsApp link beside anybody who has not confirmed,
  and it cannot build one from a digest. It also leaves a player whose phone cleared its
  storage with no way back in and nobody able to send them one.
- *Derived from the participation's own id* (`sha256('spot:' + id + secret)`), which makes it
  re-derivable. That is reproducible by anybody who ever sees an id, cannot be rotated if a
  link leaks, and — the trap that killed it — silently invalidates every live link the day
  somebody sets the secret it is salted with.

Storing it buys back re-sending and rotation — and rotation is implemented, not just
claimed: `rotateSpotToken` draws a new one and retires the old, reachable from the host's
own screen for the day a link ends up in the wrong group chat.

**What it costs, stated properly.** The first version of this paragraph said an attacker who
can read the table already has every name and phone number in it, so the token adds nothing.
That is wrong, and it is worth being clear about why: a name is a *record*, a token is a
*live capability*. A read-only leak — a backup, a `select *` in a log, a console screenshot,
a reporting replica — would now also hand over the power to cancel every spot in every game.
Hashing makes that class of leak inert, and that asymmetry is precisely why every other token
in this schema is hashed.

The judgement is that for stage 1 the capability is small enough to trade: confirming or
giving up one seat in one game, for one evening, recoverable by the host in a tap. **That
trade expires the moment `/s/` shows money.** SPEC-v4 §8 requires a verified device for
financial access, and this token must not become what stage 3 reaches for — at that point it
is hashed and the raw value kept encrypted for the host's send, or it is replaced outright by
the device session of stage 5. Written here rather than left to be rediscovered.

**It does not ride a `Referer`.** `/s/` and `/r/` send `Referrer-Policy: no-referrer` from
`next.config.ts`. Browsers already default to `strict-origin-when-cross-origin`, which keeps
the path off a cross-origin request — but a default is the browser's to change and these two
paths *are* the credential. What no header fixes is that WhatsApp's link preview fetcher sees
the URL; that is true of any forwarded capability link and is already true of `/r/`.

**Its rate limiter is its own.** The existing `checkTokenLookupAllowed` counts failures
across the whole venue and locks out at a hundred an hour — correct for a QR code inside the
building, and a denial-of-service switch the moment a **public, forwarded** URL feeds it.
Spot lookups are counted separately, per IP, with no venue-wide ceiling, and the court and
sign-up gate is now scoped to its own kinds so nothing can reach it from outside.

### 8b. `mergePlayers` breaks the day `session_participants` exists

`registration.ts:853-857` decides a player is an orphan by counting `tournamentPlayers`
rows only, then hard-deletes. Once participations reference `players.id`, a session-only
player is still "orphan" by that count — so merge either raises a foreign-key error or
cascades away someone's entire session and attendance history.

This is fixed in the same migration that adds the table: the orphan check unions
`session_participants`, and merge refuses outright when either side has any participation.
Stage 5 tightens it further to unsettled charges and live mandates.

## 9. Migrations

Enforced by `src/db/__tests__/bootstrap.test.ts` and by how `bootstrap.ts:58-73` applies
them. Every migration in this feature obeys all of it:

- `drizzle/NNNN_name.sql`, **one statement per `--> statement-breakpoint` chunk** —
  postgres.js sends each chunk through the extended protocol, which rejects multiple
  commands; PGlite would accept them, so a violation diverges in production only;
- no `--> statement-breakpoint` inside a string, `$$` body or comment — the splitter is
  `String.split`;
- no `CREATE INDEX CONCURRENTLY`, `VACUUM` or `ALTER SYSTEM` — everything runs inside one
  transaction;
- **no new enum value used in the file that adds it.** `ALTER TYPE … ADD VALUE` may sit in
  a transaction but the value cannot be referenced there, and the failure rolls back the
  whole bootstrap into a retry loop, because `ensureReady()` clears its memo on rejection.
  Creating a brand-new type and using it in the same file is fine, which is what this
  feature does;
- an appended `_journal.json` entry whose `when` is strictly greater than every applied
  migration — the applier's gate is a watermark (`applied >= when`), not set membership,
  so a timestamp older than production's watermark is skipped **forever, silently**;
- a regenerated `src/db/bootstrap-migrations.ts` (`npm run db:bootstrap`), because the
  hash is the sha256 of the exact file bytes;
- `drizzle/meta/NNNN_snapshot.json`, not needed at runtime but required for the next
  `drizzle-kit generate` to diff correctly;
- every column named explicitly in `schema.ts` — `casing: 'snake_case'` applies to
  drizzle-generated SQL only, so a hand-written migration and an inferred name diverge at
  runtime rather than at generate time.

Two latent defects in the existing applier, recorded here and hardened in stage 3 rather
than quietly relied on: the stored migration `hash` is written and never compared, so an
edit to a shipped `.sql` is undetectable; and `ensureReady()` has no circuit breaker, so a
permanently failing migration retries on every request.

## 10. Every new route calls `ensureReady()` and is `force-dynamic`

`bootstrap.ts` skips work when `NEXT_PHASE === 'phase-production-build'`, but
`src/db/index.ts` builds its handle on first property access. A new route that touches
`db` outside `ensureReady()`, or that Next decides to prerender, constructs PGlite inside
the build worker, where the WASM aborts. Every daily-games route therefore declares
`export const dynamic = 'force-dynamic'` and calls `ensureReady()` first, like every
existing page.

## 11. Stage 1 details that were not written down

- **Soft cap** (`s1c`): capacity is mutable. Raising it promotes as many waitlisted
  players as there are new seats, in the same transaction, under the same row lock.
  Lowering it never evicts anyone — it only stops new joins.
- **Waitlist order** is FIFO by `seq`, a per-session monotonic counter. A player who
  cancels and rejoins goes to the back, because rejoining inserts a new row rather than
  resurrecting the withdrawn one. Resurrection would let two concurrent rejoins both pass
  a `where state = 'withdrawn'` guard and collide on the unique index as a raw error.
- **`seq` and `seat_no` are different things.** `seq` is arrival order and never changes.
  `seat_no` is which of the capacity seats you hold, and is reused when someone leaves.
- **The Tonight screen's money column** (`s1i`) renders the session price and "—" until
  stage 3 fills it. The column exists from the start so the screen does not get relaid out
  later.
- **`absent` takes no seat back.** Marking someone absent after the session does not free
  a seat or promote a waitlist — the evening is over.
- **Ids are not sortable.** `lib/ids.ts` is uniformly random despite its comment; nothing
  in this feature may infer time order from an id.

## 12. What the reviews found

Four adversarial reviews ran against the finished stage — correctness and concurrency,
security and privacy, UX and copy, and spec fidelity and tests. Their proven defects, and
where each is fixed, because the fix is the interesting part:

| Found | Fix |
|---|---|
| `setPresent` read the session status without `for update`, so a host's tap and the tick that closes the night interleaved: the tap wrote `checked_in` into a frozen night, leaving a participation that was neither played nor away and that nothing would ever resolve. Proved on a live database with two connections. | `for update` on the session inside the same transaction, and `absent` removed from the states a tap may leave — it is only ever written by the lock. |
| A hundred requests to `/s/<anything>` locked out **every** court QR code and tournament sign-up link in the building for an hour, because spot lookups fed the venue-wide failure counter. | Spot lookups get their own per-IP budget with no global ceiling; the court/sign-up gate is scoped to its own kinds. |
| Join limiting was per client-declared device id, so a script sent a fresh one each time; and one phone number under sixteen names took sixteen seats. The global ceiling was itself a switch anyone could flip to stop sign-ups venue-wide. | Per IP and per device, no global ceiling, and one number holds one spot per game — checked before a player row is resolved. |
| The spot token was derived from the row id and salted with an optional secret: re-derivable by anybody who saw an id, unrotatable, and silently invalidated for everyone the day the secret was set. | Drawn, stored, rotatable. Decision 8a has the argument. |
| Releasing a spot named the next person on the waitlist in full — including people who had asked to stay off the public list. | The page says somebody moved up and not who; every player-facing outcome is now a fixed code rather than a sentence carried in the URL. |
| The confirmation gate could not be switched off: an unchecked checkbox sends nothing, and the action tested `!== 'off'`. | Tests for the value being present. |
| `mergePlayers` checked for a clash outside its own transaction and surfaced a raw constraint error; its orphan check was dead code. | The check moved inside, with the unique index caught and turned into a sentence. |
| `price_paise` is an `int4` and nothing bounded it: a mistyped price reached the database as `integer out of range`. | ₹1,00,000 ceiling, in the parser and in both server guards. |
| A player could still give up a spot after the start — the rule lived only in the view — and the waitlist was promoted into a game already being played. | Both are server rules now. |
| Ticking somebody off redirected, which reset the scroll position: ticking the fourteenth of sixteen arrivals threw the host back to the masthead. | Revalidate, do not navigate. |
| "Take somebody off" was a `Confirm` containing one button per person, each of which removed that person on first press — the two-tap guard was on the menu, not on the act. | Each name is its own `Confirm`. |
| The Tonight toggle was a 3.3:1 green slab labelled "Tap" / "Here", with no accessible name — sixteen buttons all called "Tap". | Ink fill, "Not here" / "Here", and a name that carries whose row it is. |
| A cancelled game read "Finished"; a waitlisted player on a finished game was still told they might move up; a cancellation with no reason typed showed no notice at all. | Each state renders its own sentence. |
| The test suite's `beforeEach` re-seeded a venue and an organiser that `truncate` never cleared, so every test after the first died in the hook — and its idempotency test wound the session back to a status it already had, leaving an empty plan, so the replay defence it claimed to prove was never executed. | Seed once; the idempotency test now uses `go_live`, whose plan does not depend on participant state, and asserts the claim row count. |

### The second round

The same two reviewers were sent back at the fixes. Four of them held; three did not, and
one fix had introduced a worse bug than the one it closed:

| Found on re-review | Fix |
|---|---|
| **The capacity floor I had just "fixed" was unsafe.** Flooring on the headcount instead of the highest seat number meant that after withdrawals — seats `{12, 15}` held by two people — lowering the cap to four left both of them *above* it and invisible to `freeSeats`, which scans `1..capacity`. The promotion in the same call then filled 1–4 on top of them: six people in a four-seat game, proved on a live database. | Seats are compacted onto `1..n` under the lock before the cap moves, so the highest number equals the headcount and the floor is right without being over-conservative. In two statements via an offset, because a single renumbering `UPDATE` raises a duplicate key the moment the new order swaps two rows — also proved. |
| **Closing the seat-stuffing hole made the join oracle worse.** Matching on the number alone, before any name is resolved, meant one request answered *is this number playing tonight* for any number under any name — cheaper and quieter than before, since the early return takes no seat and never reaches the host's screen. | `alreadyIn` no longer leaves the server. Both outcomes render one sentence; only a device match returns a token. The residual signal — the public count moves when somebody joins — is named in decision 8 rather than pretended away, and stage 5's OTP is what actually closes it. |
| **The guest self-invite fix left a dangling foreign key**, making that particular merge impossible for ever with nothing the host could do. | The self-invite is cleared whichever id it still carries. |
| **The plaintext-token argument had a false premise and an unimplemented claim** — "an attacker who can read the table already has everything" conflates a record with a live capability, and there was no rotation. | Decision 8a rewritten to say what it really costs and when the trade expires; `rotateSpotToken` implemented and on the host's screen. |
| The new spot limiter exempted a request with no forwarded IP, and its cap was low enough that one person on the venue Wi-Fi could lock everybody out of their own links. | Missing IP is its own bucket; the cap is now hygiene rather than a control, which is honest about what a 160-bit token already does. |
| Seating somebody off the waitlist pushed the cap up with no audit row and no status guard. | Both added. |
| The cron 500 still returned driver text, and "run it now" reported only failure even when most games had reconciled. | Both fixed. |

Everything in the two rounds above was a defect found by reading, not by running: at the
time, `npm install` was blocked in both sandboxes, so the SQL-level claims were proved
against a real PostgreSQL 16 and the pure logic against a hand-written test harness.

That was resolved later by fetching the Linux builds of the seven native packages this app
uses (next-swc, Tailwind's oxide, lightningcss, esbuild, argon2, rolldown, the resolver
binding) on the one machine with a route to npm, and layering them into `app/node_modules`.
`tsc`, `vitest`, `eslint` and `next build` all run in the sandbox now, and stage 1's checks
came back green — **except one defect only `next build` could find**: `app/s/[token]/actions.ts`
is a `'use server'` module and exported a synchronous type guard. Every export from such a
module must be an async server action; Next refuses at build, not at request, so typecheck,
lint and 181 tests all passed it happily and the deploy would have failed. The codes moved
to `s/[token]/outcome.ts`. The other seven `'use server'` files export only types, which are
erased.

## 13. What the stage 2 reviews found

Two adversarial passes over the court-hold model, the second sent at the fixes from the
first. Rows are ordered by how badly they would have hurt.

| Found | Fix |
|---|---|
| **`isCourtClash` was a tautology.** Both branches of its ternary were byte-identical, so the SQLSTATE was read and discarded — and drizzle 0.45 wraps driver errors, putting the real one on `cause` and making the message the failing SQL, which for an insert into `court_holds` never mentions `court_hold_slots`. The entire "somebody took that court a second before you" path was dead: those races returned a 500. In the other direction, an FK violation or an unmigrated table would have been reported to an organiser as a court clash for ever. | Walk the `cause` chain; require the SQLSTATE **and** the constraint. `constraint_name` is postgres.js, `constraint` is PGlite — both are checked, and there is now a unit test for each shape. |
| **The check and the write disagreed about what was being taken.** The pre-check asked about the window as typed; the write kept the start of an already-running hold. A game moved from 19:00 to 22:00 was checked for 22:00–23:00 and written as 19:00–23:00 — three hours nobody asked for, and a refusal, blamed on a phantom third party, that no retry could clear. A multi-day tournament index-matched its windows to its holds and could collide with itself. | One function, `resolveWindows`, decides what a holder gets on one court; the check and the write both call it. Existing holds are matched by **overlap**, never by position. |
| **The first fix for that was worse than the bug.** Anchoring on "a hold that is *running*" meant a game whose scheduled end had passed but which was still being played had no anchor, its window collapsed to nothing — and `setHolds` read "no window" as "no hold" and **deleted every court the game was standing on**, reporting success. | Anchor on "a hold that has begun". And an empty resolution is never a delete: a court keeps what it has, and a court that cannot be given is named in the refusal instead of being silently dropped. |
| **The closures backfill could abort the migration.** `court_closures` had no uniqueness of any kind, so two closures on one court in one afternoon collide on the slot index — and every migration runs in one transaction, so the whole thing rolls back, `ensureReady()` throws, and the app never boots at all. The pre-fix behaviour was merely losing the rows. | One subtransaction per closure. A closure that cannot be placed is dropped; a failed deploy is not the right price for a row no screen could ever see. |
| **Two hosts saving the same two courts in opposite checkbox order deadlocked** — a 40P01, which is not a clash and had no sentence. | The insert is sorted by court then start, the trigger's own SELECT is ordered to match, and 40001/40P01 now produce "Two people saved at once. Nothing was changed — try again." rather than a stack trace. |
| **The screens and the index disagreed about "free".** The pickers and the day view asked in real time; the interlock works on the quarter-hour grid. A tournament that finished at 19:05 left its court showing free from 19:10, and the save then refused it. | `holdsBetween` and `gaps` widened to the grid. The two places that genuinely mean "right now" — the live board and the public gate sign — got `holdsAtInstant`, which is exact. |
| **Rounding the start up cost the venue a quarter of an hour** at the moment it mattered: a court assigned at 18:31 was owned by nobody until 18:45, and `sendToCourt` refused every match. | Both the taking and the letting-go round down, which is only safe because they are consistent; and a start whose quarter hour is genuinely spoken for now walks forward to the first free one instead of being refused. |
| **`setSessionCourts` never re-asserted the session's status inside its transaction**, so a save already in flight could give courts to a game the reconciler had just ended, and nothing would ever release them. `assignCourts` had the same shape against `finishEvent`. | A guarded `UPDATE … RETURNING` on the holder's own row, inside the transaction — the house pattern, taking the row lock that serialises the two. |
| **`sendToCourt` and `moveMatch` checked the hold outside their transaction** and never re-asserted it, so a match could go live on a court the tournament had stopped holding. `moveMatch` also had no `.returning()` check at all. | Both re-check inside the transaction with the hold row locked `FOR SHARE`, and `moveMatch` uses `.returning()` as its test like everything else. |
| **`endHoldsAt` deleted a hold that began in the same quarter hour it ended in** — a game that ran 19:02 to 19:10 was recorded as having been played on no court. | Truncated to the end of the quarter hour it began in, never below its own start. |
| **The hours were read back off the holds**, so one clamped hold moved every other day of a two-day tournament to match it. | `tournaments.court_from_min` / `court_until_min`. The hours are an input, not something to reverse-engineer from output. |
| Reporting success while holding nothing: a window entirely in the past wrote no holds and returned `{ok: true}` with the asked count. | Refused, by name: "There is nothing left of those hours on Court 1 and Court 2." |
| `createSession`, `rescheduleSession` and `extendSession` ignored what was actually held; `cancelSession`, `endSession` and `markAutoEnded` never resynced `court_count`. | `setHolds` returns the courts it held; `syncSessionCourtCount` runs on every path that changes them. |
| The `tournaments_court_hours` CHECK evaluated to NULL — which passes — when exactly one column was null. | `(a is null) = (b is null) and …`. |
| The test file's dates were fixed, so two thirds of it would have started failing on 16 September with errors about hours that had gone. | Every date is derived from today. |
| `courtOptions` showed a court as free when there was nothing left of the hours at all, because a court with no resolvable window was skipped rather than reported. | Skipped means "cannot answer": it renders as "nothing free in these hours". |

A third pass looked at the screens rather than the engine, and found that the model was
ahead of the product. What it changed:

| Found | Fix |
|---|---|
| **The court identity stage 2 made real was never shown to the player.** `/g/[slug]`, `/s/[token]`, `/games` and the WhatsApp share text all still said "2 courts" — the one fact a player standing at the gate already has. | `courtsLabel`: "Courts 3 and 4", read from the holds rather than the cached count, because courts can be swapped mid-evening and a number goes stale silently. |
| **"That game has finished — nothing to extend."** about a game that had not started. The ordinary order is make it, fix the hours, publish; `extendSession` refused drafts. | Drafts allowed, and the sentence says what it means. |
| **`closedReason` changed meaning and two screens didn't.** The live board and the move screen printed "out of action — Yours from 6:00 pm" about a court in perfect condition. | The reason is a sentence in its own right now; nothing prefixes it. |
| **Two tournaments sharing a court in one day crossed their board entries** — `perCourt` was keyed by court alone, last writer wins, so a live evening match could be captioned with the morning tournament's "Your hours ended at 3:00 pm". Newly reachable *because* of stage 2. | Keyed by holder and court. |
| **Taking a court off a game deleted the record that it had been played on.** The opposite of the care `endHoldsAt` takes. A game that used Court 1 from seven to half past showed the court free from seven. | A removed court's running hold is truncated, not deleted — the same rule, in the same shape. |
| **Blocking a court defaulted to 06:00–08:00** and allowed the past outright, so at half seven in the evening a host got a block from this morning and a receipt saying it would come back "at the time you set". | Defaults to the next quarter hour for two hours; a block whose hours have gone is refused. |
| **"Give it back" was offered on a block that ended hours ago**, and erased the record that the court had ever been out. | Past blocks read as history, and the write refuses them too — a stale screen is where that tap comes from. |
| **The blocking refusal gave impossible advice.** A broken net on a busy court got "pick another court, or another time": the net is broken on *that* court at *this* time. | Blocks get their own sentence — move or finish what is on it first. |
| **The free-slot list under-answered its own question.** An empty day read "Free 00:00–00:00"; a booked court offered midnight-to-six as the answer; the answer was the smallest, palest text on the screen. | Gaps clipped to the drawn window, each with its length, in the size of an answer. The bar gained a legend and a "now" marker, and stretches to cover anything running outside 6am–11pm instead of clamping it to a zero-width sliver. |
| **`/admin/games/new` threw the whole form away on any refusal** — title, times, price, spots, notes, court ticks and the gate switch — on the screen used weekly, while the tournament form next door preserved everything. | The refusal carries the values back. Courts are no longer pre-ticked either: ticking every free court made a one-court game three unticks. |
| **The free-slot view was filed under Settings.** "Availability IS the product", reachable only via avatar → Your account → Courts. | Linked from `/admin/games`, `/admin/games/new` and `/admin/live` — the screens where somebody is deciding whether a court is free. |
| **The multi-day fix had no screen at all.** `dayKeysBetween` and `tournamentWindows` handled it perfectly and nothing could produce a tournament longer than a day. | A "Days" field on the create form. |
| `removeCourt` named a screen that cannot clear a block, and `/admin/live` said "nothing on court yet" above two cards naming a game on two courts. | Both say what is true. |
| The court `<select>` on the day view was 48px, below this app's own 56px floor, and preselected Court 1 with no empty option. | `tap`, and "Which court?" first. |

A fourth pass read the ~1,350 lines written since the last green build, looking only for
what a compiler would have caught. It found no compile errors and six real defects:

| Found | Fix |
|---|---|
| **The multi-day clash check on the create form was a no-op.** `Math.min(want.fromMin, 1440)` where `fromMin` is already ≤ 1440 — so a weekend tournament ignored tomorrow's holds entirely and offered a court the save would refuse. | The clip to "now" applies only to the day that is actually today; every other day is asked about in full. |
| **Re-saving a multi-day tournament mid-run resurrected finished days.** A window whose hours had ended was re-anchored to its full configured hours, undoing the truncation `finishEvent` had applied — and then asked whether those hours were free, so a court free right now could be refused over yesterday afternoon. | A window that is entirely over keeps its hold verbatim, or takes nothing. Three assertions pin it. |
| **A live match whose tournament's hours had run out vanished from the board.** Keying the board's per-court entries by holder made the holder the only thing that can own a court — so four people standing on one were taken off the screen. | A court with a live match is owned by that match's tournament, hours or no hours. |
| **The day view still dropped a hold that runs past midnight** — the widening added for exactly that case capped its own upper bound at midnight. | Capped at 48 hours instead. |
| **The new-game form stopped pre-ticking any court**, so a host who did not notice created a game holding none. | A first visit pre-ticks the free courts; a refused save restores what was ticked. |
| An emptied "Days" field submitted `''`, and `Number('')` is 0, so it was refused as out of range instead of defaulting to one. | `||`, not `??`. |

**One caveat, deliberately accepted.** Migration `0007` was rewritten in place — twice — after
it had been applied to throwaway databases on this branch. That is a rule this project would
normally not break: a migration that has run anywhere must be corrected by the next one, or
databases silently diverge from their journal. It is safe here because 0007 has never run
anywhere that survives — it is not on `main`, it has not been deployed, and every database
that applied it (the test PGlite, a local PostgreSQL, a throwaway container) is built from
scratch. Anyone who ran `npm run dev` on this branch mid-stage should delete `app/.pglite`
once; anyone who has not can ignore this. The moment this branch merges, 0007 is frozen.

### What stage 2 deliberately does not do

- **Per-court hours within one game.** "Beginners on Court 1 from six, Court 2 from half seven"
  is one window per session, applied to every court it holds. The swap is performed at the
  time, by editing, which works and is not the same as scheduling it. `s2c` is satisfied in
  the sense that two games can share an evening; it is not satisfied in the sense that the
  swap can be set up in advance.
- **"When can I get two courts for ninety minutes?"** `freeCourtsBetween` answers it exactly
  and has no screen. The day view lists gaps court by court and leaves the intersection to
  the host.
- **A repeating block.** Coaching batches are weekly and this screen makes you type them
  fifty-two times. The nearest spec item is `s5a`.
- **A start-time field on "Courts and hours".** A game that starts late has no expression;
  only the finish moves.
- **Taking a court out from under a live game.** The broken-net case refuses and says what
  has to move first. Doing it in one act means ending or moving a game, which is a decision
  with people standing on a court and not one to make implicitly.

Two things the second reviewer flagged that were **left as they are**, deliberately:

- The statement-level trigger closes a hole the application cannot currently open — nothing
  does a multi-row `UPDATE` that grows a hold. It is kept because the lock ordering it makes
  possible is not optional, and because the next person to write such an update should not
  have to discover this.

  One risk goes with it, and it is worth naming because it is the one thing this project
  said it would never take: transition tables (`REFERENCING OLD TABLE` / `NEW TABLE`) have
  not been run against PGlite. They are core Postgres executor machinery since 10 and PGlite
  is a real Postgres 18 backend compiled to WASM, so the expectation is that they work — but
  it is an expectation, not a test, and if it is wrong the migration aborts inside its single
  transaction, `ensureReady()` throws, and the embedded database every `npm run dev` uses
  never comes up. The failure is loud and immediate rather than silent, and `npm test` is
  what finds it. **If it does fail, the fallback is the row-level version in commit
  `ba368e5`**, which was run against PGlite and works; `setHolds` already sorts its VALUES
  list, which is what gives a row-level trigger the same lock ordering. Nothing merges
  before that test has run.
- `markAutoEnded` can leave `ended_at` a few minutes after `held_until`. The court going back
  to the venue on a grid boundary is the point; the attendance record is unaffected.
