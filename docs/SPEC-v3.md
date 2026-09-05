# Madras Pickleball — Tournament Site
## Build spec v3 (locked)

Three rounds of design, two rounds of review by four specialists. v3 is what gets built.
`docs/SPEC-v1.md` and `SPEC-v2.md` are kept for the reasoning trail.

**What the product is, in one sentence:** the only thing that knows four categories are sharing
four courts — a live court board that answers *what's on each court, who's next, and is anyone
double-booked*, wrapped in the smallest tournament manager that can feed it.

**Two premises that were wrong in v1 and stay reversed:**
- Club pickleball is **self-refereed**. Scoring is opened by a court QR with no login. Umpire
  accounts exist as an optional named upgrade for the showcase court.
- **Nobody taps 60 rallies × 70 matches.** Typing the game scores (~10 seconds) is the default
  path; rally-by-rally scoring is opt-in, and lands after tournament #1.

---

# PART A — What gets built for tournament #1

Everything in Part A ships before the first real tournament. Part B is v1.1. Part C is parked.
The plan is anchored to a **named tournament date**, and scope is cut backwards from it — without
a date the build expands to fill the time.

## A1. Roles and access

| Who | How they get in | What they can do |
|---|---|---|
| **Super Admin** | username + password | everything + create accounts, reset passwords, manage courts and roster |
| **Admin** | username + password | run tournaments end to end |
| **Scorer** | **no account** — court QR | enter/confirm the score for the match on that court |
| **Umpire** | court QR **+ 4-digit PIN** (step-up, not a standalone login) | same, but named in the audit trail; required for finals |
| **Public** | nothing | everything except phone numbers and unpublished draws |

**Two admin accounts are mandatory** before a tournament can go live, and the go-live action is
blocked server-side until **the second admin has logged in once from a different session** — two
accounts on one person's phone does not survive the lockout it exists to prevent. Super Admin gets
a printed one-time recovery code. No public sign-up, ever.

### Court tokens — the concrete design

- One token per court per tournament. 10 characters of Crockford base32 (~50 bits, excludes
  I/O/0/1/U) formatted `K7X4M-9RQ2`, because when the QR won't scan in the sun a human types it.
  Only `sha256(raw)` is stored, plus a 5-character prefix printed on the card for matching.
- **The card prints a stable URL — `mpb.in/c3` — which server-side resolves to the live
  tournament's current token.** The cards are laminated once and never reprinted.
- Opening it **exchanges the token for a device-bound `HttpOnly` session cookie** and redirects to
  `/court/3`. The secret leaves the URL bar, browser history and screenshots. Revoking a token
  deletes every session issued from it in the same transaction.
- **Writes carry `match_id` + `expected_version`.** The server checks *that match is on this
  token's court and is scoreable*. It never resolves "whatever is on this court now" at write
  time — that is precisely how a late-flushing submit lands on the next pair's match.
- Court sessions die at end of tournament day. Tokens auto-expire at tournament end + 24h.
  A **"Revoke all court tokens"** button exists for when the QR gets posted in a 200-person group.
  The board shows *"Court 3: 6 devices connected"* — visibility is the defence, not secrecy.
- Rate limits: `GET /c/*` 5/min per IP (this is the one place IP limiting is right — a token
  guesser is not the venue behind its NAT); writes 60/min per court session and per match.
  Identical response and timing for "no such token" and "revoked", so it is not an oracle.
- **Knockout matches from the semi-finals on do not run on an open token** — `scoring_mode` flips
  to `authenticated` and they need an umpire PIN or an admin. One column, and it removes the only
  matches anyone would bother gaming.
- The court page never dead-ends: no match on Court 3 shows *"Nothing on Court 3 right now —
  next up: Ravi/Priya v Arun/Deepa"* and a **"We just played — find our match"** link.

Blast radius, stated honestly: one court's current match, while it is on that court, reversible
and attributed. That is a good trade against the certainty that per-scorer logins get shared in
the WhatsApp group and half the courts go unscored.

## A2. Getting a tournament set up

The tournament page is a **checklist of cards**, not a wizard — players trickle in, two no-show,
someone brings a friend, a category gets added at 10am. Every card stays editable after go-live.
A persistent primary button always names the next step: *"Next: pair the players →"*.

**Quick Play** is what the empty state offers and what makes this a weekly habit rather than a
thing relearned three times a year: one screen — name pre-filled *"Sunday Social — 14 Sep"*, a
paste box, three big buttons (Men's / Mixed / Open Doubles), **Start** → picks the format, pairs
randomly, creates the matches, goes live, hands back a share link. **This path is timed
end-to-end on a real phone and must stay under 90 seconds.**

**Players.** Paste the list from WhatsApp. v1 parser: strip numbering, bullets and emoji, one name
per line, a 10-digit number is a phone. Then a **review table** — every cell editable, ambiguous
rows amber, possible duplicates flagged with *"Same as Ravi Kumar? Link / Keep separate"*.
**Never reject a paste.** (The clever parsing — `/` pair splitting, M/F and skill inference — waits
until we have five real lists from the venue's group to test against. Writing a parser against an
imagined format is how you get a parser for an imagined format.)

**Only `name` is required.** Gender is asked lazily, as a 3-tap toggle strip, only when a
Men's/Women's/Mixed category exists. Skill is worded **Strong / Regular / New** and only asked if
it's needed; the number behind it is never shown back to the user. Phone is optional, admin-only,
and never rendered on any public or scorer screen. Photos are not in the flow.

**Categories.** Discipline (Singles / Doubles) × gender (Men's / Women's / Mixed / Any). No age or
rating bounds in v1 — there is no birth date on a player and "35+ Doubles" works fine as a name.

**Pairing.** Tap a player → sticky bar *"Pairing with Ravi ✕"* → the list filters to valid partners,
so in Mixed an invalid pair is literally unformable → tap the second. Two taps per team, identical
on phone and laptop. **"Pair the rest randomly"** at the bottom, because the real workflow is
hand-pair the four couples who always play together and let the app do the other eight. Re-roll
previews before committing. Teams auto-name "Ravi / Priya". Live validation: *"Need 6 more women
for 12 mixed teams."* Odd numbers → substitutes list.

## A3. Formats, and the number that decides the day

**Formats in v1: "Everyone plays everyone" (round robin) and "Groups first, then knockout"**, with
the knockout field forced to 4 or 8 (top 2 from 2 or 4 pools). This is what a club Sunday runs, and
it removes bye generation, seed-position tables, plate draws and `loser_of` edges from the critical
path entirely. `match_slots` and every enum value still land in the schema, so single elimination,
plate and 3rd-place in v1.1 are additive, not a migration.

Pools are seeded serpentine (1,2,3,4 / 8,7,6,5 / …). **Pools of 3 are never generated at draw
time; at 6 or 7 entries the format picker offers a single round robin instead.** Unequal pools do
occur at runtime after a withdrawal, which is why standings rank on ratio (§A6).

Group → knockout advancement is **admin-confirmed in v1**: standings compute, the admin taps the
qualifiers, the bracket builds. Twenty lines instead of an engine, and the tiebreak code gets to
survive one real day before it is trusted to build a bracket unattended.

### The format picker's arithmetic — fixed

v2's estimates were wrong by ~2x on their own assumptions (66 round-robin matches at 30 min on
3 courts is **11 hours**, not "about 5 hrs 30") and wrong again by ignoring that categories share
courts. That was the single most dangerous number in the document: the tool that exists to stop the
day running past sunset would have caused it.

The estimate is now **tournament-wide and cumulative**, recomputed every time a category is added:

> **Adding Mixed Doubles makes the day 6 hrs 10 across 4 courts.**
> Start 9:00 → finish about **15:10**. Sunset 18:20.
> 55 matches · everyone gets at least 3 games

Basis: total matches across all categories ÷ total courts × per-match minutes (30 for best-of-3 to
11, 20 for one game to 15, 15 for one game to 11, including changeover), **+10% for players entered
in two categories**, and it includes plate and 3rd-place matches the moment they are ticked. During
the day the per-match figure switches to the **rolling actual duration for that category today**.
A per-category number, if shown at all, is labelled *"if this category had all 4 courts."*

## A4. The court board — the run-day home screen

Phone-first, because the organiser is walking around. All courts visible at once with no scroll is
the load-bearing constraint; above five courts it becomes a 2-column grid rather than a list.

**Layout (390px):** court cards stacked at the top → a **"Next 6"** band of already-conflict-checked
matches each with one-tap Send → the full queue behind a scroll, **defaulting to "Ready only"**
(with 60 queued across 3 categories, typically 8–12 are placeable; that default turns 60 into 10)
→ a sticky bottom bar with the day's pulse: **"4 courts · 3 live · 60 to play · finishing about
18:15"**. That finish figure is what triggers "shorten the format", so it is on screen all day.
If the organiser is ever scrolling 60 rows, the design has failed.

**Laptop:** courts as columns, kanban-shaped, with a permanent right-hand alerts rail for disputes,
no-score courts and conflicts. "Send to Court 2" stays a button on both, so one mental model.

**Court card states:** Live (green, "started 12 min ago") · **Free** (grey, escalating to amber
after 5 min, with a full-width "Send next match →" — an idle court is daylight burning) · Called
(amber, countdown ring, "They're on" / "No-show") · **Finished, no score** (the common failure is
not a wrong score, it is *no* score, because the pair walked off for water — the court stays
occupied in the data and the queue jams) · Out of action ("Court 3 — puddle. Tap to restore.").

**Match lifecycle is five states**, not seven: `pending → ready → called → live → completed`.
"On deck" is a queue position, "warming up" is the second half of the called countdown. All enum
values stay in the schema.

**Cross-category conflict detection** — the reason to build this at all. With 40 players across 3
categories about 12 people are in two, so double-booking is the median case, not an edge case.
Every player in both teams is checked across all categories before a match can be sent:

- **hard block, red:** *"Ravi is on Court 1"* — and that sentence **is** the disabled button's
  label. The reason is the affordance.
- **soft, amber:** *"Ravi: 3 matches in the last 90 min"* — cumulative load, which people respect,
  rather than a 10-minute cooldown that gets clicked through until the hard block does too.
- **grey:** *"Waiting for the winner of Ravi/Priya v Karthik/Meera"* — never "unresolved slot".

**Detection alone is a nag.** The board's default action is a suggestion: **"Next placeable:
Mixed QF3 — Send to Court 2 →"**, with blocked matches simply not offered. And when a court goes
free with everything blocked, it proposes rather than shrugs: *"Court 3 idle. Mixed QF3 in ~8 min
when Ravi finishes — hold, or run Women's SF2 now?"* A **blocking view** shows which player is
gating the most queued matches, because that is the person to schedule around.

Queue order: placeable first → round order → **longest-rested players first** (the fairness rule
players actually notice) → category interleaved → manual position wins and is labelled *"moved up
by you"*. Reordering on a phone is **"Send to Court…"** and **⋮ → Move to top / Hold**. Hold
matters: the organiser knows Ravi is in the car park and needs to park a match without deleting it.
Completed matches leave the board into a collapsed "Done (23)".

**A per-category `not_before` time** is set at draw creation so the pools don't all finish at once
and dump every dual-entry player into the same afternoon deadlock.

## A5. Scoring

### The default path: type the score, loser confirms at the net

1. **Printed court card** — A5, laminated, cable-tied to the net post. Giant QR, the short URL
   readable underneath, **COURT 3** at 100pt, colour-coded per court so a misplaced card is
   visible from a distance, one instruction: *"Scan when your match ends. Type the score."*
2. **"Is this your match?"** — court-coloured header, COURT 3 at 40px (a physical cross-check
   against the net post), both team names at 28px, **"Yes — enter the score"**, and a quiet
   **"This isn't our match"** that lists every live and on-deck match *and* raises a drift signal
   on the admin board.
3. **Score entry is chosen, not typed.** No keyboard. Per game: *"Who won game 1?"* (two big
   buttons) → *"Their score"* (**11** pre-selected, 12/13/14/15 as chips) → *"And the other
   side?"* (chip grid 0–13, 56px targets). Nine taps for a three-game match, one-handed, in sun —
   and an impossible score is **unenterable**, which designs out the most common real error
   (entering 9-11 the wrong way round) instead of detecting it later. Never offers a game 3 row
   after a 2-0.
4. **"Who's submitting?"** — the two team names. Without this tap, "the opposing side also
   submits" is not implementable, because nothing knows which side you are.
5. Submit is a **600ms press-and-hold**.
6. **"Hand the phone to Arun / Deepa"** → they tap **Agree** or **Not right**. One device, five
   seconds, and it is the actual social protocol of self-refereed pickleball. Escape hatch:
   *"They've already left"* → stays reported for the timeout or an admin. A second phone opening
   the same QR also works — independence is a server-side **attributor key**
   (`user:<id>` / `umpire:<id>` / `token:<court>:dev:<device>`), and two submissions confirm each
   other only if the keys differ **and** they declare different sides.
7. Then, immediately: **"Your next match: 2 matches away · Court 1"** and *"Next on Court 3:
   Karthik/Meera"* — the moment after entering a score is exactly when players want that.

### States, and who sees what

| State | Scorer | Admin | Public |
|---|---|---|---|
| **reported** | "Waiting for Arun/Deepa" + *They're here — confirm now* | amber "1 of 2", one-tap Confirm, and **"Confirm all pending (4)"** | score shown in grey italic + **"unconfirmed"** — players want it now, but visibly provisional |
| **final** | "Final ✓" | green | plain; feeds the table and the bracket |
| **disputed** | "Scores don't match — an organiser will sort it out" | **red badge pinned to the top of the board**, both versions vertically aligned with the differing digit highlighted, three buttons: Use A · Use B · Enter the real score | **"Result under review"** — never either version. Publishing a contested score to forty people is how you get an argument |
| **corrected** | — | — | **"corrected at 14:32"** |

- **A reported result advances the bracket provisionally**, otherwise the tournament stalls at 2pm
  waiting for confirmations nobody remembers to give, the group never completes, and the knockout
  never populates.
- **Auto-confirm after 10 minutes** unless disputed, evaluated lazily at read time — no cron.
  Printed in the public footer: *"Scores go final 10 minutes after they're entered unless someone
  disputes them."* Knockout matches from the semis on never auto-confirm.
- **A disputed match blocks advancement.** Resolution is one admin action with a mandatory reason,
  logged. The governing rule is printed on the standings page: *in a dispute the organiser decides.*
- **Mirror detection**: if two submissions are exact reverses, surface *"possible side mix-up — did
  you mean 11-9?"* with a one-tap fix rather than a dispute. This will fire often.
- **Forty phones are the verification layer.** After a result, the *Find my match* card for every
  affected player flips to *"Result recorded: you lost 11-0, 11-0 — not right? Tell the organiser."*
  No accounts, and it makes a malicious or misattributed submission self-detecting.
- Soft validation only: *"11-10 isn't a legal score for this match — win by 2. Keep anyway?"*
  A capped or time-stopped score is always permitted, flagged with its reason.
- **An admin "pending results" screen** with inline score boxes, because realistic court-QR
  adoption is maybe 60% and the rest arrives on a clipboard.

### Rules engine — split at the right seam

- **Terminal logic ships in v1, pure and unit-tested:** `validateGames`, `isMatchComplete`,
  `winnerOf`, point-difference capping. Quick result entry needs all of it, so it cannot live in
  the rally-scoring phase or there will be two validators that disagree.
- **The rally state machine ships in v1.1** and terminates into the same terminal logic, so there
  is exactly one definition of "this match is over and X won".

Rules, now unambiguous:

- Best of 3 to 11, win by 2 (default); single game to 15; single to 21.
- **Hard cap wins by 1**: "to 11, cap at 15" means at 14-14 the next point takes it. Applying
  win-by-2 unconditionally builds a game that cannot end.
- **Time cap, fully defined:** the horn ends the **match**; the rally in progress is completed; the
  team leading in games wins; if games are level the team leading the current game wins; if that is
  level, next point. **A time-capped game's point difference is excluded from standings**, because
  a pool cannot compare a 7-5 against a 11-4.
- **Retirement:** the in-progress game is awarded at target (difference capped at ±8) and the
  remaining unplayed games are awarded 11-0 with **zero** difference contribution — so
  `games_won` stays coherent for a best-of-3.
- Side-out is default; rally mode is one server per side, no server number, target and win-by
  configurable.
- Scoring config: **category → stage/round → match**, keyed on stage + round index and surfaced as
  "Group stage / Quarter-finals / Semi-finals / Final". Pools at one game to 15 with knockouts at
  best-of-3 to 11 is the normal shape of a club day, and "shorten the remaining format" depends on
  this level existing.
- Result types: `normal | bye | walkover | retired | cancelled`. **`forfeit` is merged into
  `walkover`** — two enum values that behaved identically under one UI label guarantees
  inconsistent data.

## A6. Standings — the numbers that go on a public page

v1's "wins → head-to-head → point difference" was undefined for a three-way tie and would have
returned whatever the sort happened to do, in public, to an angry player. Locked procedure:

1. **Win ratio**, not raw wins — pools end up unequal after a withdrawal or a late entry, and
   comparing absolute wins then penalises the team whose opponent was voided.
2. Exactly two tied → **head-to-head**.
3. Three or more tied → a **mini-table of only the matches among the tied teams**: win ratio, game
   difference, point difference. If that separates some but not all, **restart from step 1** —
   which means a three-way tie reduced to two is then resolved by head-to-head, *not* by reading
   off the mini-table order. This is the trap implementers fall into by accident.
4. Overall game difference → point difference → points scored.
5. Documented draw by the organiser.

**Both game difference and point difference are capped at ±8 per game.** Walkovers record 11-0 11-0
but contribute **zero to both** — capping only point difference would let a walkover still swing the
tiebreak through the game-difference term. **Voided matches contribute zero to everything, including
matches played.** Time-capped and format-shortened games are excluded from difference columns and
noted on the table.

**Cross-pool comparison** (comparing best runners-up across pools of unequal size): drop each
team's results against the last-placed team in the larger pools before comparing. Without this,
qualification is wrong and indefensible in public.

The foot of every table prints **the rule in force and the result applied** — *"2nd on head-to-head
vs Arun/Deepa"*. The rule doesn't stop the argument; the reason does.

## A7. When things go wrong — shipped before tournament #1, not after

A Google Sheet's superpower is that it never refuses an edit. v2 declared these existential and
then scheduled them last; they now ship with the court board.

**"Edit this match"** is the universal escape hatch: change teams, court, scores, status, result
type — with a **mandatory reason**, fully audited. That is a capability superset of every button
below, at half a day's work. On top of it, one-tap shortcuts:

- **No-show** → walkover (the real result type, so §A6's zero-difference rule actually holds; a
  typed 11-0 would silently corrupt the tiebreak the spec worked hardest to get right)
- **Withdraw team** → voids results if the team has played under half its pool matches, forfeits
  after. **A withdrawal after the group stage completes is always forfeits, never a void** — that
  is the real TD rule and it deletes an entire class of "the bracket was built on a result that no
  longer exists". The policy applied is printed on the standings page.
- **Substitute in / swap partner** — results stay with the team slot, recorded in a change log
  rather than silently rewriting `team_players`
- **Late entry** → substitutes, then promoted. Never re-runs the draw.
- **Court out of action** → board filters, queue and finish estimate recompute
- **Shorten the remaining format** → rewrites rules for un-started matches only, and can drop a
  stage. The most-used emergency tool there is; without it the organiser shortens it on paper and
  every phone in the venue — and the TV — is confidently wrong for the rest of the day.
- **Pause tournament** (and a lunch block, which also feeds the finish estimate)
- **Revise draw** — free while zero results exist; afterwards, targeted surgery only. Versioned,
  with a public note: *"Draw revised 10:15 — 2 withdrawals."*
- **Move a live match to another court** — the current scorer's phone keeps working through a
  short-lived grant, rather than 409-ing mid-game in front of the players.

**Corrections:** recompute downstream; if a downstream match has already started the correction is
**refused with the blocking match named**, and offered as *"apply when Court 3 finishes"* — a
refusal with no next step is exactly the stuck organiser this is meant to prevent. A late submission
that arrives after final is never silently discarded; it goes to a conflicts list the admin can see.

## A8. Public site

**One scrolling page**, not six tabs — tabs on a 390px screen make a visitor pick a category before
they get an answer:

1. **LIVE** — court, teams, score
2. **Find my match** ← the most valuable thing here, and the first interactive element
3. **Up next** — the next 6 with court and queue position
4. Results · Table / Bracket · Players (collapsible; brackets are a round-by-round list on phones
   with the tree behind "View bracket")

**Find my match:** type your name → tap yourself → a card pins to the top —
*"You're on Court 3 next · 2 matches away"* — remembered in localStorage so the next visit is
already personal. **Queue position is the number**; a minutes estimate appears only once there is a
rolling actual duration to base it on, because a player told 25 minutes and called in 8 misses
their match. This card is also where the *"result recorded — not right?"* loop lands.

Plus: a printable **A4 QR poster** so people can get the link at all, **share to WhatsApp**
(plain text + link — WhatsApp is the distribution channel, not the competitor), and the
**per-court paper score sheet and master schedule**, which are the fallback when the wifi dies and
therefore ship with the thing they back up.

**Never public:** phone numbers, unpublished draws, paid status. Player pages are `noindex`.

## A9. Engineering decisions

**Stack:** Next.js 15 App Router · TypeScript · Tailwind · Prisma · Postgres (Neon) · Vercel.

**Schema shape.** `match_slots(match_id, slot, source_type: entry|winner_of|loser_of|group_rank|bye,
source_match_id?, source_group_id?, source_rank?, resolved_team_id?)` replaces v1's
`next_match_id`, which could not express a losers' bracket, a 3rd-place match or — critically —
groups → knockout, where a slot's source is "winner of Group A" and there is no match to point at.

`matches.result_state (none|reported|disputed|final|voided)` is **separate from `status`**, which
is the lifecycle. A bye is `status=completed, result_type=bye, result_state=final` — not a status
of its own, or the advancement code and the `UNIQUE INDEX ON matches(court_id) WHERE status='live'`
end up reasoning about different enums. That index makes double-booking structurally impossible;
the UI must render its violation as *"Court 2 already has a live match — end it first?"* and not a
500 on tournament morning. Moving a live match is a single atomic update.

`result_submissions` is the **inbox**; `games` is the **ledger** — only a confirmation writes the
ledger, which resolves most of the confirmation edge cases by itself. Agreement is one string
comparison on a `normalized_digest` (`sha256` of result type + winner + games sorted), never a
JSONB compare. `UNIQUE(match_id, attributor_key) WHERE active` makes double-submission a database
constraint rather than app logic. A device id is a "make the right thing easy" control, not a
security control — two "independent" submissions seconds apart from one IP set
`confirmation_confidence=low` and surface for review rather than being blocked.

Also: `tournament_id` denormalised onto matches (every public query is tournament-scoped);
`version` for optimistic locking; `client_event_id` for idempotency; `state_after` on match events
so undo is O(1) instead of replaying a fold; `court_tokens` + `court_sessions` + `match_scoring_grants`;
`draw_version` + `revision_note`; `court_closures`; `called_at`/`warmup_started_at` computed at read
time, never by a background job; `updated_at` everywhere; soft deletes on players/users/tournaments/
categories; `CHECK (winner_team_id IN (team_a_id, team_b_id))`; `sort_order` not `order`.

**Live updates.** Naive 5s polling is ~230,000 function calls and ~46 GB of egress **in one
tournament day**. Instead: a single monotonic **`tournaments.stream_version`** bumped in the same
transaction as any board-visible write — not `max(updated_at)`, which is a multi-table fan-out on
every poll and silently freezes a spectator's page when a soft delete bumps nothing or two writes
share a millisecond. Clients poll that one integer behind a CDN (`s-maxage=3,
stale-while-revalidate=30`) and fetch the payload only when it moves. Poll only while the tab is
visible; back off to 30s when nothing is live; never on completed pages. `/display` is exempt from
the backoff — a TV is always visible and always idle.

Public routes must be **strictly cookie-free** or the CDN silently stops caching. The new court
session cookie is the most likely thing to break this, so court and admin routes live in a separate
segment with no cookie-touching layout shared with the public one, and it is verified with
`curl -I` for `x-vercel-cache: HIT`.

**Auth.** DB-backed sessions, 32 random bytes with only the SHA-256 stored, `__Host-` prefix,
`HttpOnly; Secure; SameSite=Lax`, sliding refresh, revocable — Super Admin deactivating an account
has to actually take effect, which a stateless JWT cannot do. argon2id via `@node-rs/argon2` (the
native `argon2` package can fail to build on Vercel). No email service, so no self-serve reset:
Super Admin clicks Reset, the server shows an 8-character code **once**, hashed, single-use,
15-minute expiry, forced change on login. No SMS — India's DLT registration is a project of its own.
Rate limiting in Postgres, **locking the account, not the IP**, because every umpire is behind one
venue NAT. **The umpire PIN is a step-up on an existing court session, not a standalone
credential** — you must already hold the court's QR to be asked for it, which turns a 4-digit
password on the open internet into a second factor on a capability you already have. It is hashed
and lockout-counted per umpire.

Prisma on Neon's **pooled** host with `connection_limit=1` and a `globalThis` singleton, or
connections exhaust under exactly the load that matters. Neon free autosuspends after 5 minutes and
Vercel has no warm instances, so the first login of the morning feels broken — ping the site 10
minutes before start.

**Public responses are built by explicit `toPublicPlayer()` / `toPublicMatch()` mappers**, never
from a raw Prisma model. That is how the phone numbers stay unleaked.

**Tests, only where they earn it** — pure functions whose bugs are silent and land on a public
leaderboard: the round-robin circle method, group advancement, the full tiebreak procedure
including three-way ties and the restart rule, difference capping, and `validateGames` /
`isMatchComplete` including win-by-2, hard cap and the retirement scoreline. No tests on UI, CRUD
or auth plumbing.

## A10. Build order

Anchored to a named tournament date. Roughly 4–6 weeks of focused work; the estimate that matters
is the one made against a real date, not this one.

| Phase | What ships |
|---|---|
| 0 | Next.js + Prisma + Neon (pooled), full schema with constraints, seed, sessions/auth/roles/two-admin guard, **deployed to a URL on day one** |
| 1 | Roster + paste + review table, tournaments, categories, pairing, draft/go-live, **JSON+CSV export** (3 hours, and it is the entire disaster-recovery story) |
| 2 | Draw engine as pure tested functions: round robin, groups, standings + tiebreaks, `match_slots` resolution, terminal rules logic, table + bracket rendering |
| 3 | **Court board**, conflict detection + suggestion, court tokens/QR/session exchange, quick result + confirm + dispute, "Edit this match" + the chaos shortcuts, corrections with the downstream guard, **per-court score sheet print** |
| 4 | Public single-scroll page, Find my match + the "not right?" loop, `stream_version` polling + CDN verification, WhatsApp share, QR poster, master schedule print, **Quick Play wired end-to-end and timed** |
| 5 | **Full mock tournament on three real phones** — the highest-value day in the plan, and it happens *before* tournament #1, not after |

Phase 4 is the first demonstrable milestone; phase 3 alone can run a tournament that nobody can see.

---

# PART B — v1.1, right after tournament #1

Ordered by what tournament #1 will prove is needed:

- **Live rally scoreboard.** Tap the team that won the rally; the app decides point vs side-out vs
  second server. Per-**game** lineup capture (who serves first, each team's starting right-side
  player — captured per game, because players may switch and game 2's first server is not implied
  by game 1). **Doubles starts each game at server 2** — score call `0–0–2`, one service turn for
  the first serving team. **Switch ends at the end of every game, plus mid-game only in the
  deciding game** at 6 / 8 / 11 — and note that a single game to 15 or 21 *is* the deciding game.
  2 timeouts per team per game (3 to 21); medical timeouts separate. Cards sit where the teams
  stand and flip on end change. 24px dead gutter, 48px inert margins, 350ms tap guard, **auto-lock
  after 2–3 minutes** (45s was wrong — a timeout is 60 seconds and end changes routinely take
  longer) suspended during timeouts and end changes. Visible undo strip, last-eight ribbon,
  hold-to-confirm match end. **"Set the score"** override (admin or umpire PIN only) for when the
  paper score is authoritative. One writer per match with a claim and takeover. Wake lock — and a
  runbook line that the showcase court phone stays plugged in.
- **Flaky-network outbox**: rules engine client-side, taps queued in `localStorage`, flushed in
  idempotent batches with backoff, green/amber/red sync badge. Not offline-first — full offline is
  two weeks whose worst failure mode is silently overwriting an admin's correction.
- **Single elimination** with seed-position tables, byes as real rows, plate/consolation and
  3rd-place via `loser_of` edges.
- **Automatic group→knockout advancement** once the tiebreak code has survived a real day.
- **"Add everyone from last Sunday"** — one query, and the highest-value roster feature once there
  is a last Sunday.
- **Weekly Social mode**: attendance and courts, no format, no standings — who's here, what's on
  each court, who's next. About a day on top of the court board, and it is what makes the app a
  weekly habit rather than something relearned three times a year. Roster quality only compounds
  with frequency: ship for occasional tournaments only and every tournament starts from a cold
  paste of 40 names.
- **`/display` TV mode** — gated on the venue actually having a screen with a browser. Interim:
  `?display=1` on the public page with 3× type.
- The **clever half of the paste parser**, tested against five real lists from the venue's group.
- **Called / warming-up states**, the 5-minute timer and the "Now calling" board.
- **Merge duplicate players** tool.

---

# PART C — Parked, with reasons

Americano / Mexicano (a different product: fixed-target rally scoring, per-player standings, no
persistent teams — **and the claim that the schema absorbs it is untested, so it gets a real
sketch before anyone repeats it**) · Swiss · double elimination · compass draw · MLP-style team
ties · payments and refunds (a static UPI QR at the desk plus a paid checkbox — keep money out of
the app) · player self-registration · photos · push and SMS · DUPR API sync (the ID field is
captured now; re-keying 200 players by hand later is the expensive part) · multi-venue ·
career and season stats (deferred until roster identity is clean — a career record built on
duplicate rows is worse than none) · audit log viewer (rows are written; read them with SQL).

---

# PART D — The things that aren't code

## D1. Cost and ownership

**Vercel Hobby prohibits commercial use** and a venue charging entry fees is commercial. Budget
Vercel Pro at $20/mo plus a paid Postgres tier and the domain — roughly **₹1,500–2,500/month**,
paid by the venue. Under-budgeting is the most common cause of death for a project like this.

**Domain, Vercel, Neon and GitHub registered under Saurabh's own email and card**, developer as
collaborator. Lockfile committed, versions pinned. Health endpoint plus a free uptime monitor.
A one-page runbook in the repo: where the database is, how to redeploy, who owns the domain, where
the recovery code lives, how to reset a password with a SQL one-liner, and what to do when it's
down. **Export is a feature, not a nicety** — CSV and printable PDF per tournament, plus a weekly
automated dump, so the record survives the app.

## D2. Privacy (DPDP Act 2023)

Name, phone, gender and photos of identifiable people published to an unauthenticated internet.
So: phones admin-only and never rendered publicly; photos opt-in and default off; a one-paragraph
collection notice with a named contact and a delete-on-request path; `noindex` on player pages.
No date of birth is collected in v1, so the under-18 rule is stated honestly as *guardian consent
is handled at the desk*, not as a system check the app cannot perform.

## D3. Look and feel — constraints, not adjectives

*Legible at 1m in direct sun, one-handed, assuming a 20% brightness loss through a screen protector.*

- Public/admin: ink blue `#0E3A5E`, interactive `#1565C0`, accent **terracotta `#E2582B`** — lime
  is the worst possible accent for outdoor legibility and blue+lime is every sports SaaS template.
  **Green means one thing only: live.** Amber = waiting, grey = done.
- Scoreboard and `/display`: ground `#0B0F14`, white numerals, teams separated by **hue not
  shade** — blue `#2563EB` vs orange `#EA580C`, which survives every common colour-vision
  deficiency. Light-mode variants of that pair are defined once as tokens so there is one orange.
- Team colours consistent across phone, public page and TV.
- Barlow Semi Condensed tabular for scores, Inter for UI, `tabular-nums` anywhere a number updates
  live or the layout flickers on a TV.

## D4. Plain English

| Jargon | What the screen says |
|---|---|
| Event | Category (admin) / just "Mixed Doubles" (public) |
| Generate draw | **Create the matches** |
| Round robin | **Everyone plays everyone** *(round robin)* |
| Groups → knockout | **Groups first, then knockout** — "Groups of 4, top 2 go through" |
| Bye | **Sits out round 1** |
| Seed | avoided; *"strongest players first so they don't meet early"* |
| Standings | **Table** |
| Publish | **Go live** — "Players and spectators can see this. Share the link." |
| Walkover / forfeit | **No-show** |
| Retired | **Stopped mid-match** |
| Teams already built? | **Do you already know the pairs?** |

## D5. How we'll know it worked

Tournament #1 going well is not the test. The test is tournament #3, and it needs:

1. The app used on **≥6 ordinary club days** in between. If by week 4 it has been opened on fewer
   than 3 non-tournament days, it is failing regardless of how #1 went.
2. **Someone other than Saurabh** has run an event start to finish with no developer in the room.
3. **Players** — not the organiser — pasting the link into the WhatsApp group.
4. It survived one **bad** day (rain, a pileup, a wrong result) and the fix took under a minute.
   Trust is earned by recovery, never by the happy path.
5. **Nothing broke silently between events.** One "site is down" on the morning of #2 ends it.
6. The roster resolving to **one row per human** across events.

## D6. The one question only Saurabh can answer

**Are weekly socials the venue's main use, with tournaments occasional — or the reverse?**

If socials fill the courts and tournaments are marketing, then Quick Play and the Weekly Social
mode are the product and the whole priority order should shift toward them. If tournaments are the
brand and socials already work fine on WhatsApp, Part A is right as written. Part A is built
tournament-first with Quick Play protected as the fast path, which hedges both ways — but this
should be answered deliberately, not by default.
