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
— stage 2

`tournament_courts (court_id, day_key)` with `unique (court_id, day_key)` is replaced by
`court_holds`, which **both** tournaments and sessions write to.

The first draft claimed `matches_one_live_per_court` keeps two time-sharing holders safe.
That was wrong: that index is on `matches`, and sessions never produce matches, so it
would not have covered the session-vs-tournament case at all. The correct statement:

- **Between holders** (tournament vs session vs tournament) the guarantee is
  non-overlapping holds in `court_holds`. That is the only guarantee there is, and it is
  structural.
- **Within a tournament**, `matches_one_live_per_court` survives unchanged and still
  stops two matches going live on one court.
- **Within a session**, stage 7 gets its own one-live-foursome-per-court index.
- `livePlayerConflict` (`board.ts:1137`) scans `matches` venue-wide and today covers
  cross-tournament player clashes for free. It goes blind to sessions. Stage 7 must union
  session play into it. Written down here so it is a task, not a surprise.

**No `btree_gist` EXCLUDE.** `CREATE EXTENSION btree_gist` is fine on Neon and **fails on
PGlite** unless the contrib bundle is registered at `new PGlite()` construction
(`db/index.ts:79`), and the whole migration file runs in one transaction
(`bootstrap.ts:58-73`), so the failure bricks the embedded database that `npm run dev` and
every future test depend on. Instead, overlap is made impossible with stock btree:

- `court_holds` carries `held_from < held_until` (CHECK) and a real FK to its holder;
- each hold materialises into `court_hold_slots` rows of **15 minutes**, boundaries
  rounded outward, written in the same transaction;
- `unique (court_id, slot_start)` on the slot table.

Two overlapping holds share at least one slot, so the unique index refuses the second.
Rounding outward only ever over-reserves, never under-reserves. A 14-hour tournament day
is 56 rows; an evening session is 8.

**No polymorphic FK-less holder.** `court_holds` gets two nullable FK columns,
`tournament_id` and `session_id`, both `on delete cascade`, and
`check (num_nonnulls(tournament_id, session_id) = 1)`. Nothing else in this schema is
FK-less and this table will not be the first.

**Holds end when the holder ends.** `events.ts:161-170` currently pretends a finished
tournament has let go of its courts while the row still says otherwise. That fiction does
not survive: completing or cancelling a holder truncates `held_until` to now, in the same
transaction, and deletes the freed slots.

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

A host adding a **name only** (`s1h`, `s1k`) has no phone to match on. It matches a
same-name player already in the venue's book — phone or no phone, which is what
`registration.ts:331` has always done and is right for the host, who is looking at the
person. What it refuses is a bare name that exactly matches somebody **already on this
list**: that is either a second Priya or a second tap, and only the host can say which, so
they are asked for a surname or a number rather than having a duplicate player created for
them in silence.

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

Storing it buys back re-sending and rotation. What it costs is small: unlike a session token
this authorises nothing but confirming or giving up one spot in one game, and an attacker who
can read the table already has every name and phone number in it. Stage 5 replaces it with a
verified device session.

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

Everything above is a defect found by reading, not by running: `npm install` is blocked in
the environment this was written in, so the SQL-level claims were proved against a real
PostgreSQL 16 and the pure logic against its own tests, and `tsc`, `vitest`, `eslint` and
`next build` are still owed.
