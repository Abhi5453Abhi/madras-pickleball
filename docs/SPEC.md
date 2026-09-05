# Madras Pickleball — Tournament Site
## Build spec — FINAL

Three design passes, three review rounds by five specialists (tournament director, product designer,
engineer, red-team, independent auditor). `docs/SPEC-v1.md`, `v2` and `v3` are the reasoning trail.
This file is what gets built.

**What the product is, in one sentence:** the only thing that knows four categories are sharing four
courts — a live court board that answers *what's on each court, who's next, and is anyone
double-booked* — wrapped in the smallest tournament manager that can feed it.

**Two premises that were wrong in the first draft and stay reversed:**

- Club pickleball is **self-refereed**. Scoring is opened by a court QR with no login. Umpire
  accounts exist as an optional named upgrade for the showcase court and the finals.
- **Nobody taps 60 rallies × 70 matches.** Typing the game scores (~10 seconds) is the default path;
  rally-by-rally scoring is opt-in and lands after tournament #1.

**Everything is anchored to a named tournament date**, and scope is cut backwards from it. Without a
date the build expands to fill the time.

---

# PART A — Tournament #1

## A1. Roles and access

| Who | How they get in | What they can do |
|---|---|---|
| **Super Admin** | username + password | everything + create accounts, reset passwords, manage courts and roster |
| **Admin** | username + password | run tournaments end to end |
| **Scorer** | **no account** — court QR | enter and confirm the score for a match on that court |
| **Umpire** | court QR **+ 4-digit PIN** (a step-up, not a standalone login) | same, named in the audit trail; required for knockout semis onward |
| **Public** | nothing | everything except phone numbers, paid status and unpublished draws |

**Two admin accounts** are required — but as a **one-time venue-setup gate**, checked once when the
club is first configured, not at every go-live. Per-tournament it would block Quick Play on a Sunday
and block tournament morning while the co-admin is in traffic. It is a nudge toward a second human,
not a proof of one; that is stated plainly rather than pretended otherwise. Super Admin gets a
printed one-time recovery code. No public sign-up, ever.

### Court tokens

- **One token per court per tournament**, printed on the card as `mpb.in/t/K7X4M-9RQ2`. 10
  characters of Crockford base32 (~50 bits, excludes I/O/0/1/U) because when the QR won't scan in
  the sun a human types it. Only `sha256(raw)` is stored, plus a 5-character prefix printed on the
  card so an admin can match a card to a row. **The card is reprinted per tournament** — one A5
  sheet. A stable self-resolving URL was considered and rejected: it would give the token zero
  entropy and quietly void rotation, revocation and the whole security story.
- Opening it **exchanges the token for a device-bound `HttpOnly` session cookie** and redirects to
  `/court/3`. The secret leaves the URL bar, browser history and screenshots. Revoking a token
  deletes every session issued from it in the same transaction.
- **Write scope, explicitly:** a court session may write to (a) the match currently on its court,
  (b) a match that was on its court and completed within the last 60 minutes — this is what makes
  opponent confirmation possible after the board has already sent the next pair on — or (c) a match
  covered by an active scoring grant. *Scoreable* means `status IN (live, completed)` and a **projected**
  `result_state IN (none, reported)` — evaluated against the derived state, not the stored one, so
  a submission arriving on a match that is already final by projection goes to the conflicts list
  and never sets `disputed`.
- **Writes carry `match_id` + `expected_version`.** The server never resolves "whatever is on this
  court now" at write time — that is exactly how a late-flushing submit lands on the next pair's
  match, which is the error this whole design exists to prevent.
- Court sessions expire at `tournament.end_date` 23:59 local. Tokens auto-expire 24h later.
  A **"Revoke all court tokens"** button exists for when the QR gets posted in a 200-person group.
  The board shows *"Court 3: 6 devices connected"* — visibility is the defence, not secrecy.
- Rate limits: **failed** token resolutions at 10/min per IP and 100/hour globally; successful ones
  limited per token, not per IP — the scanner *is* the venue behind its NAT, and a blanket per-IP
  cap would lock out the whole club on the busiest minute of the day. Identical response and timing
  for "no such token" and "revoked", so it is not an oracle.
- **Knockout matches from the semi-finals on default to `scoring_mode = authenticated`** — umpire
  PIN or admin, not an open token. Admin can turn this off per category (with a 4-team knockout it
  is only three matches, and an admin standing there is fine).
- The court page never dead-ends. No match on Court 3 shows *"Nothing on Court 3 right now — next
  up: Ravi/Priya v Arun/Deepa"* and a **"We just played — find our match"** link, which lists only
  matches inside the write scope above.

Blast radius, stated honestly: one court's recent and current matches, reversible and attributed.
That is a good trade against the certainty that per-scorer logins get shared in the WhatsApp group
and half the courts go unscored.

## A2. Setting up

The tournament page is a **checklist of cards**, not a wizard — players trickle in, two no-show,
someone brings a friend, a category gets added at 10am. Every card stays editable after go-live. A
persistent primary button always names the next step: *"Next: pair the players →"*.

**Quick Play** is what the empty state offers, and it is what makes this a weekly habit rather than
something relearned three times a year. One screen: name pre-filled *"Sunday Social — 14 Sep"*, a
paste box, three buttons (**Men's / Mixed / Everyone**), **Start** → pairs randomly, creates the
matches, goes live, hands back a share link. Format rule: **≤7 teams → round robin; ≥8 → groups per
§A3.** The Mixed button needs the gender strip first, so the **90-second budget is measured on the
Men's / Everyone path and timed on a real phone.** ("Open" is deliberately not used as a gender
label — in pickleball Open means the top skill division.)

**Players** — three input paths. Players can put themselves in, or the admin can:

0. **The registration link.** Each tournament gets a **registration link + QR**
   (`mpb.in/r/<token>`, same token pattern as the court cards) to drop in the WhatsApp group. The
   form asks: your name (search the roster or type a new one), phone (optional), which categories
   you want, and — for doubles — **your partner's name**, picked from players already registered or
   typed in. It is a form, not an account: no password, no login, nothing to remember.
   Submissions land as **pending entries** on a "Registrations (7)" card where the admin approves,
   merges with an existing roster row, or rejects. **If two players name each other, the team forms
   automatically on approval**; a player who registers without a partner goes into a *needs a
   partner* pool that the admin pairs by hand or fills randomly. The link is revocable and expires
   with the tournament, exactly like a court token.

1. **Roster search-as-you-type with chips.** One input pinned at the top; type three characters, tap,
   it becomes a chip, the field clears and keeps focus so the keyboard never dismisses. 20 regulars
   in ~40 taps.
2. **Paste the list from WhatsApp.** v1 parser: strip numbering, bullets and emoji; one name per
   line; a 10-digit number is a phone. Then a **review table** — every cell editable, ambiguous rows
   amber, possible duplicates flagged *"Same as Ravi Kumar? Link / Keep separate"* (matched on
   normalised phone where present, otherwise fuzzy name). **Never reject a paste.**

The clever parsing — `/` pair-splitting, M/F and skill inference — waits until we have five real
lists from the venue's group to test against. Writing a parser against an imagined format produces
a parser for an imagined format.

**Only `name` is required.** Gender is asked lazily, as a 3-tap toggle strip, only when a
Men's/Women's/Mixed category exists. Skill is worded **Strong / Regular / New**; the number behind
it is never shown back to the user, and its only consumer is the default seed order (§A3). Phone is
optional, admin-only, and never rendered on any public or scorer screen. Photos are not in the flow.

**Categories.** Discipline (Singles / Doubles) × gender (Men's / Women's / Mixed / Any). No age or
rating bounds — there is no birth date on a player, and "35+ Doubles" works fine as a name.

**Pairing.** Tap a player → sticky bar *"Pairing with Ravi ✕"* → the list filters to valid partners,
so in Mixed an invalid pair is literally unformable → tap the second. Two taps per team, identical
on phone and laptop. **"Pair the rest randomly"** at the bottom, because the real workflow is
hand-pair the four couples who always play together and let the app do the other eight. Re-roll
previews before committing, and **the RNG seed is stored with the draw** so any random result is
reproducible and auditable. Teams auto-name "Ravi / Priya". Live validation: *"Need 6 more women
for 12 mixed teams."* Odd numbers → substitutes list.

## A3. Formats, seeding, and the number that decides the day

**Formats: "League" and "Groups first, then knockout."**

**League** is the default and the one small fields use: everyone plays everyone, then an optional
finals stage — **none** (the table decides it), **final only** (top 2), or **semi-finals + final**
(top 4). Four teams is the worked example: each plays 3 matches, top 2 go to the final. This is what
a club Sunday runs, and it keeps bye generation, seed-position tables, plate draws and `loser_of`
edges off the critical path.

**Groups first, then knockout** is the same machinery with more than one pool, for larger fields. `match_slots` and every enum value still land in the schema, so single
elimination and consolation draws in v1.1 are additive, not a migration.

**Pool sizing rule:** below 8 entries it is always a single-group League. From 8 up: pools = 4 if
N ≥ 16, else 2; sizes as equal as possible; if any pool would have 3 or fewer, drop to the next
lower pool count. Top 2 from each pool advance, so the finals field is 2 (one group), 4 (two pools,
or one group with semis) or 8 (four pools).

**Seed order:** teams are seeded in one ordered list, pre-sorted by team skill mean where skill
exists and otherwise by the stored RNG seed. The admin can reorder it before locking the draw. Pools
are then filled serpentine (1,2,3,4 / 8,7,6,5 / …). The seed order and RNG seed are stored with the
draw version.

**Group → knockout advancement is admin-confirmed:** standings compute, the app proposes the
qualifiers, the admin taps to confirm, the bracket builds. Twenty lines instead of an engine — and
the tiebreak code gets to survive one real day before it is trusted to build a bracket unattended.

### The format picker's arithmetic

The first draft's estimates were wrong by ~2x and were computed per category, ignoring that
categories share courts. That was the most dangerous number in the document: the tool that exists to
stop the day running past sunset would have caused it. The estimate is now **tournament-wide and
cumulative**, recomputed every time a category is added:

> **Adding Mixed Doubles makes the day 7 hrs 34 across 4 courts.**
> Start 9:00 → finish about **16:34**. Sunset 18:20.
> 55 matches · everyone gets at least 3 matches

**Basis:** `total matches across all categories ÷ total courts × per-match minutes × 1.10`, plus any
lunch block. Per-match minutes: 30 for best-of-3 to 11, 20 for one game to 15, 15 for one game to
11, including changeover; where categories use different formats it is the **match-weighted mean**.
The ×1.10 is a **deliberate flat allowance** for players entered in more than one category, not a
computed figure. Worked: 55 ÷ 4 = 13.75 per court × 30 = 412.5 min, ×1.10 = 454 min = 7h34.

During the day the per-match figure switches to the **rolling actual duration for that category
today**. A per-category number, if shown at all, is labelled *"if this category had all 4 courts."*

## A4. The court board — the run-day home screen

**Phone-first and phone-only.** The organiser is walking around; a second laptop layout for the one
screen used all day is not worth two days of build. The laptop gets the same layout, stretched.

All courts visible with no scroll is the load-bearing constraint; above five courts it becomes a
2-column grid rather than a list.

**Layout:** court cards stacked at the top → a **"Next 6"** band of already-checked matches each
with one-tap Send → the full queue behind a scroll, **defaulting to "Placeable only"** (with 60
queued across 3 categories, typically 8–12 are placeable; that default turns 60 into 10) → a sticky
bottom bar with the day's pulse: **"4 courts · 3 live · 60 to play · finishing about 18:15"**. That
finish figure is what triggers "shorten the format", so it is on screen all day. If the organiser is
ever scrolling 60 rows, the design has failed.

Definitions, because these were used interchangeably in an earlier draft and would have produced two
different queues: **`ready`** = both team slots resolved. **`placeable`** = ready and no hard
conflict.

**Court card states:**

- **Live** — green, "started 12 min ago"
- **Free** — grey, escalating to amber after 5 minutes, full-width **"Send next match →"**. An idle
  court is daylight burning; this is the highest-value micro-interaction on the screen.
- **Finished, no score** — the common failure is not a wrong score, it is *no* score, because the
  pair walked off for water; the court then stays occupied in the data and the queue jams.
  **Trigger:** a live match whose elapsed time exceeds 1.5× the category's per-match estimate.
  One tap: "Enter it for them."
- **Out of action** — *"Court 3 — puddle. Tap to restore."*

**Match lifecycle is four states: `pending → ready → live → completed`.** "Send to Court 2" sets
`live`. The `called` and `warming_up` enum values and `called_at` column exist in the schema but
are unused until v1.1 ships the calling board and its timer.

**Cross-category conflict detection** — the reason to build this at all. With 40 players across 3
categories about 12 are in two, so double-booking is the median case, not an edge case. Every player
in both teams is checked across all categories before a match can be sent:

- **hard block, red:** *"Ravi is on Court 1"* — and that sentence **is** the disabled button's
  label. The reason is the affordance, not a separate error message.
- **grey:** *"Waiting for the winner of Ravi/Priya v Karthik/Meera"* — never "unresolved slot".

**Detection alone is a nag**, so the board's default action is a suggestion: **"Next placeable:
Mixed QF3 — Send to Court 2 →"**, with blocked matches simply not offered.

Queue order, as one comparator: **placeable first → manual position → round index → seq.** Manual
moves are labelled *"moved up by you"*. Reordering is **"Send to Court…"** and **⋮ → Move to top /
Hold**. Hold matters: the organiser knows Ravi is in the car park and needs to park a match without
deleting it. Completed matches leave the board into a collapsed "Done (23)".

Rest-based ordering, category interleaving, per-category start windows, alternative-match proposals
and the blocking-player view are all **v1.1** — that is a scheduling optimiser designed before
anyone has watched one real day of queue behaviour, which is the part of this most likely to be
wrong in ways only observation reveals.

## A5. Scoring

### The default path: type the score, loser confirms at the net

1. **Printed court card** — A5, laminated, cable-tied to the net post. Giant QR, the short URL
   readable underneath, **COURT 3** at 100pt, colour-coded per court so a misplaced card is visible
   from a distance, one instruction: *"Scan when your match ends. Type the score."*
2. **"Is this your match?"** — court-coloured header, COURT 3 at 40px (a physical cross-check
   against the net post), both team names at 28px, **"Yes — enter the score"**, and a quiet **"This
   isn't our match"** listing the matches inside this court's write scope.
3. **Score entry is chosen, not typed.** No keyboard. Per game: *"Who won game 1?"* (two big
   buttons) → *"Their score"* (**target pre-selected**) → *"And the other side?"*
   (56px chip targets). **Chip sets are
   generated from the match's scoring config** — winner chips run `target … target+4` or up to the
   hard cap, loser chips `0 … winner−1` — so a game to 15, a game to 21 and a 15-14 cap finish are
   all enterable. About nine taps for a three-game match, one-handed, in sun. **A reversed score is
   unenterable**, which designs out the most common real error (entering 9-11 the wrong way round)
   instead of detecting it later. Never offers a game 3 row after a 2-0.
4. **"Who's submitting?"** — the two team names. Without this tap, "the opposing side also submits"
   is not implementable, because nothing knows which side you are.
5. Submit is a **600ms press-and-hold**.
6. **"Hand the phone to Arun / Deepa"** → they tap **Agree** or **Not right**. One device, five
   seconds, and it is the actual social protocol of self-refereed pickleball. Escape hatch: *"They've
   already left"* → stays reported. A second phone opening the same QR also works.
7. Then, immediately: **"Your next match: 2 matches away · Court 1"** and *"Next on Court 3:
   Karthik/Meera"* — the moment after entering a score is exactly when players want that.

**Submissions and confirmations are different objects**, because in the hand-the-phone path — the
80% case — both taps come from the same device and would otherwise collide on the same attributor
key:

- A **submission** is a proposed result. `UNIQUE(match_id, attributor_key) WHERE active`, where the
  attributor key is `user:<id>` / `umpire:<id>` / `token:<court>:dev:<device>`, computed server-side.
- A **confirmation** is a separate row recording agreement with a submission's `normalized_digest`
  and the side agreed for. Same-device confirmation is allowed and recorded at
  `confirmation_confidence = low`; a matching submission from a different attributor key **that declares the
  other side** confirms at `high`. A second submission declaring the same side is a duplicate, not
  a confirmation — otherwise two members of one team on two phones would confirm each other.

### States, and who sees what

| State | Scorer | Admin | Public |
|---|---|---|---|
| **reported** | "Waiting for Arun/Deepa" + *They're here — confirm now* | amber "1 of 2", one-tap Confirm, and **"Confirm all pending (4)"** | score shown with a **provisional** marker |
| **final** | "Final ✓" | green | plain |
| **disputed** | "Scores don't match — an organiser will sort it out" | **red badge pinned to the top of the board**, both versions vertically aligned with the differing digit highlighted: Use A · Use B · Enter the real score | **"Result under review"** — never either version. Publishing a contested score to forty people is how you get an argument |
| **corrected** | — | — | **"corrected at 14:32"** |

**One rule for what feeds what, because an earlier draft had three answers:** a reported result
**writes a provisional ledger row**. Standings, the bracket, the qualifier proposal and the finish
estimate all include provisional rows **and label them provisional wherever they show**. Only
`disputed` is excluded. Confirmation clears the flag. **Provisional is always derived** —
`result_state = 'reported' AND reported_at + 10 min > now()`; the stored flag on the ledger row is
a cache written on confirmation or on the next board touch, and is never read for display or
standings, or a result that auto-confirmed at the 10-minute mark would stay labelled provisional
forever. A dispute or correction reverses the row and recomputes downstream — **subject to the same
downstream guard as a correction**: if a downstream match has already started nothing is reversed;
the dispute pins a red alert and the admin resolves it through *"apply when Court 3 finishes"*.
Provisional advancement makes *report → bracket advances → QF sent to a court → losing pair taps
"Not right"* an ordinary sequence, and it must never yank a team out of a live match. Without provisional advancement the tournament stalls at 2pm waiting for
confirmations nobody remembers to give — the group never completes, so the knockout never populates.
With it, a wrong advancement is at least *visible* on the board and in the bracket.

- **Auto-confirm after 10 minutes** unless disputed, as a **computed projection** — `final` is
  `reported AND reported_at + 10min < now()` in the query — with the row physically written only
  when an admin or a board action next touches it. It cannot be a write inside a public GET: those
  are CDN-cached and cookie-free, so the origin often never runs and nothing would ever finalise.
  Printed in the public footer: *"Scores go final 10 minutes after they're entered unless someone
  disputes them."* Knockout semis onward never auto-confirm.
- **A disputed match blocks advancement.** Resolution is one admin action with a mandatory reason,
  logged. The rule is printed on the standings page: *in a dispute the organiser decides.*
- **Forty phones are the verification layer.** After a result, the *Find my match* card for every
  affected player flips to *"Result recorded: you lost 11-0, 11-0 — not right? Tell the organiser."*
  That writes a `result_flags` row (match, player tapped, device id), surfaces pinned at the top of the
  court board alongside disputes, **does not change `result_state`**, and is limited to one flag per device per match. No
  accounts, and it makes a misattributed or malicious submission self-detecting.
- Soft validation only: *"11-10 isn't a legal score for this match — win by 2. Keep anyway?"* A
  capped or time-stopped score is always permitted, flagged with its reason.
- **An admin "pending results" screen** with inline score boxes, because realistic court-QR adoption
  is maybe 60% and the rest arrives on a clipboard.

Mirror detection, confidence-based review prompts and the "this isn't our match" drift signal are
**v1.1** — three subsystems for errors that "Edit this match" fixes in twenty seconds, on top of a
chip grid that already makes a reversed score hard to enter.

### Rules engine — split at the right seam

- **Terminal logic ships now, pure and unit-tested:** `validateGames`, `isMatchComplete`,
  `winnerOf`, point-difference capping. Quick result entry needs all of it, so it cannot live in the
  rally-scoring phase or there will be two validators that disagree.
- **The rally state machine ships in v1.1** and terminates into the same functions, so there is
  exactly one definition of "this match is over and X won".

Rules, unambiguous:

- Best of 3 to 11, win by 2 (default); single game to 15; single to 21.
- **Hard cap wins by 1:** "to 11, cap at 15" means at 14-14 the next point takes it. Applying
  win-by-2 unconditionally builds a game that cannot end.
- **Time cap:** the horn ends the **match**; the rally in progress is completed; the team leading in
  games wins; if games are level the team leading the current game wins; if that is level, next
  point. The unfinished game is **recorded at its actual score and credited as won to the leader**
  (tied: credited to the match winner) so `games_won` agrees with `winnerOf`; its **point difference
  is excluded** from standings, because a pool cannot compare a 7-5 against an 11-4.
- **Retirement:** the in-progress game is recorded as **target vs the retiring team's actual
  points** (difference capped at ±8); remaining unplayed games are recorded 11-0 with **zero**
  difference contribution.
- Side-out is default; rally mode is one server per side, no server number, target and win-by
  configurable.
- Scoring config: **category → stage/round → match**, keyed on stage + round index and surfaced as
  "Group stage / Quarter-finals / Semi-finals / Final". Pools at one game to 15 with knockouts at
  best-of-3 to 11 is the normal shape of a club day, and "shorten the remaining format" depends on
  this level existing.
- Result types: `normal | bye | walkover | retired | cancelled`. **`forfeit` is merged into
  `walkover`** — two enum values that behaved identically under one UI label guarantees inconsistent
  data.

## A6. Standings

The first draft's "wins → head-to-head → point difference" was undefined for a three-way tie and
would have returned whatever the sort happened to do, in public, to an angry player. Locked:

1. **Win ratio**, not raw wins — pools end up unequal after a withdrawal or a late entry, and
   comparing absolute wins then penalises the team whose opponent was voided.
2. **Total points scored, highest qualifies** — the venue's stated rule: two teams both 2-1, the
   one with more total points goes through. This is the default and it is printed on the table.
   *Head-to-head first* is offered as a per-category alternative for anyone who wants the more
   conventional ordering; the steps below then run in the same order either way.
3. Exactly two still tied → **head-to-head**.
4. Three or more still tied → a **mini-table recomputed over only the matches among the still-tied teams**:
   win ratio, then game difference, then point difference. If that separates some but not all,
   **restart from step 1 with the remaining subset** — so a three-way tie reduced to two is then
   resolved by head-to-head, *not* by reading off the mini-table order. That is the trap
   implementers fall into by accident. A pass that separates nobody falls through to step 4.
5. Overall game difference → point difference.
6. Documented draw by the organiser.

**Point difference is capped at ±8 per game.** Walkovers and voided matches contribute **zero to
both game difference and point difference** — capping only point difference would let a walkover
still swing the tiebreak through the game-difference term. **Voided matches contribute zero to
everything, including matches played.** **A disputed match counts in matches played but not in
matches won**, and shows as *result under review* — otherwise disputing your own loss would improve
your position in the public table until someone resolved it. Time-capped and format-shortened games are excluded from the
point-difference column and noted on the table.

The foot of every table prints **the rule in force and the result applied** — *"2nd on head-to-head
vs Arun/Deepa"*. The rule doesn't stop the argument; the reason does.

## A7. When things go wrong

A Google Sheet's superpower is that it never refuses an edit. These ship *with* the court board, not
after it.

**"Edit this match"** is the universal escape hatch: change teams, court, scores, status, result type
— with a **mandatory reason**, fully audited. It is a capability superset of every button below, at
half a day's work, and it subsumes "move this result to the correct match". On top of it, one-tap
shortcuts:

- **No-show** → walkover (the real result type, so §A6's zero-difference rule holds; a typed 11-0
  would silently corrupt the tiebreak the spec worked hardest to get right)
- **Withdraw team** → voids results if the team has played under half its pool matches, walkovers
  after. **A withdrawal after the group stage completes is always walkovers, never a void** — that
  is the real TD rule and it deletes an entire class of "the bracket was built on a result that no
  longer exists". The policy applied is printed on the standings page.
- **Substitute in / swap partner** — results stay with the team slot, recorded in a change log
  rather than silently rewriting the team's players
- **Late entry** → substitutes, then promoted. Never re-runs the draw.
- **Court out of action** → board filters, queue and finish estimate recompute
- **Shorten the remaining format** → rewrites rules for un-started matches only, and can drop a
  stage. The most-used emergency tool there is; without it the organiser shortens it on paper and
  every phone in the venue is confidently wrong for the rest of the day.
- **Pause tournament**, and a lunch block that also feeds the finish estimate
- **Revise draw** — free while zero results exist; afterwards, targeted surgery only. Versioned,
  with a public note: *"Draw revised 10:15 — 2 withdrawals."*
- **Move a live match to another court** — a single atomic update, and the current scorer's phone
  keeps working through a short-lived scoring grant rather than failing mid-game in front of the
  players.

**Corrections** recompute downstream. If a downstream match has already started the correction is
**refused with the blocking match named**, and offered as *"apply when Court 3 finishes"* — a
refusal with no next step is exactly the stuck organiser this exists to prevent. A late submission
arriving after final is never silently discarded; it goes to a conflicts list the admin can see.

## A8. Public site

**One scrolling page**, not six tabs — tabs on a 390px screen make a visitor pick a category before
they get an answer:

1. **LIVE** — court, teams, score
2. **Find my match** ← the most valuable thing here, and the first interactive element
3. **Up next** — the next 6 with court and queue position
4. Results · Table / Bracket · **Teams** · **Players** (collapsible; brackets are a round-by-round
   list on phones with the tree behind "View bracket")

**Registrations, teams and scores are public and live from the moment the tournament is published** —
who has entered, who is paired with whom, and every score as it lands. Only the *unpublished draft*
of a draw is hidden, so the organiser can rework a bracket before showing it.

**Find my match:** type your name → tap yourself → a card pins to the top — *"You're on Court 3
next · 2 matches away"* — remembered in localStorage so the next visit is already personal. **Queue
position is the number**; a minutes estimate appears only once there is a rolling actual duration to
base it on, because a player told 25 minutes and called in 8 misses their match. This card is also
where the *"result recorded — not right?"* loop lands.

Plus a printable **A4 QR poster** so people can get the link at all, **share to WhatsApp** (plain
text + link — WhatsApp is the distribution channel, not the competitor), and the **per-court paper
score sheet and master schedule**, which are the fallback when the wifi dies and therefore ship with
the thing they back up.

**Never public:** phone numbers, unpublished draws, paid status. Player pages are `noindex`.

## A9. Engineering

**Stack:** Next.js 15 App Router · TypeScript · Tailwind · Prisma · Postgres (Neon) · Vercel.

**Time.** Store UTC, render **`Asia/Kolkata`**, never use the server's local date for "today".
Vercel runs UTC and every load-bearing time here is local — the finish-vs-sunset line, the 10-minute
confirm window, "started 12 min ago", the day's pulse bar. Getting this wrong is 5h30 of wrongness
on the public page all day, and it is the class of bug a 3pm dry run never catches.

**Schema.** `match_slots(match_id, slot, source_type: entry|winner_of|loser_of|group_rank|bye,
source_match_id?, source_group_id?, source_rank?, resolved_team_id?)` replaces a plain
`next_match_id`, which could not express a losers' bracket, a 3rd-place match or — critically —
groups → knockout, where a slot's source is "winner of Group A" and there is no match to point at.

`matches.result_state (none|reported|disputed|final|voided)` is **separate from `status`**, which is
the lifecycle. A bye is `status=completed, result_type=bye, result_state=final` — not a status of
its own, or the advancement code and the `UNIQUE INDEX ON matches(court_id) WHERE status='live'` end
up reasoning about different enums. That index makes double-booking structurally impossible; the UI
renders its violation as *"Court 2 already has a live match — end it first?"*, never a 500 on
tournament morning.

`result_submissions` is the **inbox**, `match_confirmations` records agreement, and `games` is the
**ledger** (rows carry `provisional`). Agreement is one string comparison on a `normalized_digest`
(`sha256` of result type + winner + games sorted), never a JSONB compare.

Also: `groups(name, advance_count)`; `tournament_id` denormalised onto matches (every public query
is tournament-scoped); `version` for optimistic locking; `client_event_id` for idempotency;
`queue_position`; `rules_override_json` and `category_round_rules`; `retired_team_id`;
`games_won_a/b` and `score_summary` as a cache written in exactly one place; `state_after` on match
events so undo is O(1) instead of replaying a fold; `court_tokens`, `court_sessions`,
`match_scoring_grants`; `registration_tokens` and `pending_registrations`
(name, phone, categories, partner name or id, status, merged player id); `result_flags`; `draw_version` + `revision_note` + `rng_seed` + `seed_order`;
`court_closures`; `players.dupr_id` and normalised phone as the dedupe key; `updated_at` everywhere;
soft deletes on players/users/tournaments/categories;
`CHECK (winner_team_id IN (team_a_id, team_b_id))`; `sort_order`, not `order` (reserved word).

**Live updates.** Naive 5s polling is ~230,000 function calls and ~46 GB of egress **in one
tournament day**. Instead: a single monotonic **`tournaments.stream_version`** bumped in the same
transaction as any board-visible write — not `max(updated_at)`, which is a multi-table fan-out on
every poll and silently freezes a spectator's page when a soft delete bumps nothing or two writes
share a millisecond. Clients poll that one integer behind a CDN (`s-maxage=3,
stale-while-revalidate=30`) and fetch the payload only when it moves. Poll only while the tab is
visible; back off to 30s when nothing is live; never on completed pages. **While a tournament has any
`reported` row the version endpoint includes `floor(now / 60s)`**, because the 10-minute
auto-confirm boundary writes nothing and would otherwise leave the day's last result marked
provisional on every phone in the venue. The display view is exempt
from the backoff — a TV is always visible and always idle.

Public routes must be **strictly cookie-free** or the CDN silently stops caching. The court session
cookie is the most likely thing to break this, so court and admin routes live in a separate segment
with no cookie-touching layout shared with the public one, verified with `curl -I` for
`x-vercel-cache: HIT`.

**Auth.** DB-backed sessions, 32 random bytes with only the SHA-256 stored, `__Host-` prefix,
`HttpOnly; Secure; SameSite=Lax`, sliding refresh, revocable — Super Admin deactivating an account
has to actually take effect, which a stateless JWT cannot do. argon2id via `@node-rs/argon2` (the
native `argon2` package can fail to build on Vercel). No email service, so no self-serve reset:
Super Admin clicks Reset, the server shows an 8-character code **once**, hashed, single-use,
15-minute expiry, forced change on login. No SMS — India's DLT registration is a project of its own.
Rate limiting in Postgres, **locking the account, not the IP**, because every umpire is behind one
venue NAT. **The umpire PIN is a step-up on an existing court session, not a standalone
credential** — you must already hold the court's QR to be asked for it, which turns a 4-digit
password on the open internet into a second factor on a capability you already have. Hashed, with
lockout counted per umpire.

Prisma on Neon's **pooled** host with `connection_limit=1` and a `globalThis` singleton, or
connections exhaust under exactly the load that matters. Neon free autosuspends after 5 minutes and
Vercel has no warm instances, so the first login of the morning feels broken — ping the site 10
minutes before start.

**Public responses are built by explicit `toPublicPlayer()` / `toPublicMatch()` mappers**, never
from a raw Prisma model. That is how the phone numbers stay unleaked.

**Tests, only where they earn it** — pure functions whose bugs are silent and land on a public
leaderboard: the round-robin circle method, group standings and the proposed qualifier list, the
full tiebreak procedure including three-way ties and the restart rule, difference capping, and
`validateGames` / `isMatchComplete` / `winnerOf` including win-by-2, the hard cap, the time cap and
the retirement scoreline. No tests on UI, CRUD or auth plumbing.

## A10. Build order

| Phase | What ships |
|---|---|
| **0** | Next.js + Prisma + Neon (pooled), full schema with constraints, seed, sessions/auth/roles, timezone rule, **deployed to a URL on day one** |
| **1** | Roster (search + paste + review table), **the registration link + pending-entry approval**, tournaments, categories, pairing, draft/go-live, **JSON + CSV export** (3 hours, and it is the entire disaster-recovery story) |
| **2** | Draw engine as pure tested functions: round robin, pools, seed order, standings + tiebreaks, `match_slots` resolution, terminal rules logic, **the cumulative finish estimator**, table + bracket rendering |
| **3** | **Court board**, conflict detection + "next placeable" suggestion, court tokens / QR / session exchange / revoke / rate limits, **umpire PIN + `scoring_mode`**, quick result + confirm + dispute, "Edit this match" + the chaos shortcuts, corrections with the downstream guard, **per-court score sheet print** |
| **4** | Public single-scroll page, Find my match + the "not right?" loop, `stream_version` polling + CDN verification, WhatsApp share, QR poster, master schedule print, **PDF export + weekly automated dump**, **Quick Play wired end-to-end and timed on a real phone** |
| **5** | **Full mock tournament on three real phones** — the highest-value day in the plan, and it happens *before* tournament #1, not after |

Phase 4 is the first demonstrable milestone; phase 3 alone can run a tournament that nobody can see.

**Honest estimate: 5–6 weeks of focused work**, and phase 3 is roughly a third of it. The estimate
that matters is the one made against the real date.

---

# PART B — v1.1, right after tournament #1

- **Live rally scoreboard.** Tap the team that won the rally; the app decides point vs side-out vs
  second server. Per-**game** lineup capture (who serves first, each team's starting right-side
  player — per game, because players may switch and game 2's first server is not implied by game 1).
  **Doubles starts each game at server 2** — score call `0–0–2`, one service turn for the first
  serving team. **Switch ends at the end of every game, plus mid-game only in the deciding game** at
  6 / 8 / 11 — and a single game to 15 or 21 *is* the deciding game. 2 timeouts per team per game (3
  to 21); medical separate. Cards sit where the teams stand and flip on end change. 24px dead
  gutter, 48px inert margins, 350ms tap guard, **auto-lock after 2–3 minutes** (45s was wrong — a
  timeout is 60 seconds and end changes routinely take longer), suspended during timeouts and end
  changes. Visible undo strip, last-eight ribbon, hold-to-confirm match end. **"Set the score"**
  override, admin or umpire PIN only. One writer per match with claim and takeover. Wake lock — and
  a runbook line that the showcase court phone stays plugged in.
- **Flaky-network outbox** — rules engine client-side, taps queued in `localStorage`, flushed in
  idempotent batches with backoff, green/amber/red sync badge. Not offline-first: full offline is
  two weeks whose worst failure mode is silently overwriting an admin's correction.
- **Weekly Social mode** — attendance and courts, no format, no standings. About a day on top of the
  court board, and it is what makes the app a weekly habit. See D6 — this may belong in Part A.
- **"Add everyone from last Sunday"** — one query, highest-value roster feature once there is a last
  Sunday.
- **Single elimination** with seed-position tables, byes as real rows, plate/consolation and
  3rd-place via `loser_of` edges — and with them, cross-pool comparison of best runners-up (drop
  each team's results against the last-placed team in the larger pools before comparing).
- **Automatic group→knockout advancement**, once the tiebreak code has survived a real day.
- **Queue intelligence** — longest-rested ordering, category interleaving, per-category start
  windows, **player-load soft warnings** (*"Ravi: 3 matches in the last 90 min"* — Part A's hard
  block only catches simultaneous matches), alternative-match proposals when a court goes free with
  everything blocked, and the blocking-player view. Deliberately after one day of observation.
- **Called / warming-up states**, the 5-minute timer, the "Now calling" board.
- **Dispute detection layer** — mirror detection, confidence review prompts, wrong-match drift signal.
- **`/display` TV mode** — gated on the venue actually having a screen with a browser. Interim:
  `?display=1` on the public page at 3× type.
- The **clever half of the paste parser**, tested against five real lists from the venue's group.
- **Merge duplicate players** tool.

---

# PART C — Parked, with reasons

Americano / Mexicano — a different product (fixed-target rally scoring, per-player standings, no
persistent teams), **and the claim that the schema absorbs it is untested, so it gets a real sketch
before anyone repeats it** · Swiss · double elimination · compass draw · MLP-style team ties ·
payments and refunds (a static UPI QR at the desk plus a paid checkbox — keep money out of the app) ·
player self-registration · photos · push and SMS · live streaming · DUPR API sync (the ID field is
captured now; re-keying 200 players by hand later is the expensive part) · multi-venue · career and
season stats (deferred until roster identity is clean — a career record built on duplicate rows is
worse than none) · audit log viewer (rows are written; read them with SQL).

---

# PART D — The things that aren't code

## D1. Cost and ownership

**Vercel Hobby prohibits commercial use** and a venue charging entry fees is commercial. Budget
Vercel Pro at $20/mo plus a paid Postgres tier and the domain — roughly **₹1,500–2,500/month**, paid
by the venue. Under-budgeting is the most common cause of death for a project like this.

**Domain, Vercel, Neon and GitHub registered under Saurabh's own email and card**, developer as
collaborator. Lockfile committed, versions pinned. Health endpoint plus a free uptime monitor. A
one-page runbook in the repo: where the database is, how to redeploy, who owns the domain, where the
recovery code lives, how to reset a password with a SQL one-liner, and what to do when it's down.
**Export is a feature, not a nicety** — CSV and printable PDF per tournament plus a weekly automated
dump, so the record survives the app.

## D2. Privacy (DPDP Act 2023)

Name, phone, gender and photos of identifiable people, published to an unauthenticated internet. So:
phones admin-only and never rendered publicly; photos opt-in and default off; a one-paragraph
collection notice with a named contact and a delete-on-request path; `noindex` on player pages. No
date of birth is collected, so the under-18 position is stated honestly as *guardian consent is
handled at the desk* — not as a system check the app cannot perform.

## D3. Look and feel — constraints, not adjectives

*Legible at 1m in direct sun, one-handed, assuming a 20% brightness loss through a screen protector.*

- Public/admin: ink blue `#0E3A5E`, interactive `#1565C0`, accent **terracotta `#E2582B`** — lime is
  the worst possible accent for outdoor legibility and blue+lime is every sports SaaS template.
  **Green means one thing only: live.** Amber = waiting, grey = done.
- Scoreboard and display view: ground `#0B0F14`, white numerals, teams separated by **hue not
  shade** — blue `#2563EB` vs orange `#EA580C`, which survives every common colour-vision
  deficiency. Light-mode variants of that pair are defined once as tokens, so there is one orange.
- Team colours consistent across phone, public page and TV.
- Barlow Semi Condensed tabular for scores, Inter for UI, `tabular-nums` anywhere a number updates
  live or the layout flickers on a TV.

## D4. Plain English

| Jargon | What the screen says |
|---|---|
| Event | Category (admin) / just "Mixed Doubles" (public) |
| Generate draw | **Create the matches** |
| Round robin | **League — everyone plays everyone** |
| Groups → knockout | **Groups first, then knockout** — "top 2 go through" |
| Bye | **Sits out round 1** |
| Seed | avoided; *"strongest players first so they don't meet early"* |
| Standings | **Table** |
| Publish | **Go live** — "Players and spectators can see this. Share the link." |
| Walkover | **No-show** |
| Retired | **Stopped mid-match** |
| Teams already built? | **Do you already know the pairs?** |

## D5. How we'll know it worked

Tournament #1 going well is not the test. The test is tournament #3:

1. The app used on **≥6 ordinary club days** in between. If by week 4 it has been opened on fewer
   than 3 non-tournament days, it is failing regardless of how #1 went.
2. **Someone other than Saurabh** has run an event start to finish with no developer in the room.
3. **Players** — not the organiser — pasting the link into the WhatsApp group.
4. It survived one **bad** day (rain, a pileup, a wrong result) and the fix took under a minute.
   Trust is earned by recovery, never by the happy path.
5. **Nothing broke silently between events.** One "site is down" on the morning of #2 ends it.
6. The roster resolving to **one row per human** across events.

## D6. The open question — and the biggest risk

**Are weekly socials the venue's main use, with tournaments occasional — or the reverse?**

This is not a preference; it decides the build order. Part A spends five to six weeks on a
tournament manager, and D5 already concedes that tournament #1 going well proves nothing — survival
is decided by whether the app gets opened on the ordinary Sundays in between, because a tool used
three times a year is relearned from scratch every time and abandoned the first time it is
inconvenient. But the two features that make ordinary Sundays work — **Weekly Social mode** and
**"add everyone from last Sunday"** — are currently in Part B. So as written the plan builds the
part that proves nothing first and defers the part that decides everything.

That is a defensible bet only with a specific commitment: *the venue runs its socials on this from
week one, and here is who does it when I'm not there.* Without that, the honest alternative is to
invert the order — ship Quick Play + the court board + a share link as a four-week weekly-social
tool, run it for six Sundays, and build the tournament machinery on top of a roster and a habit that
already exist.

The ₹1,500–2,500/month with the accounts in the venue's own name is the same question in a different
form: if the venue won't own it, it has no owner six months from now.
