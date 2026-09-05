# Madras Pickleball — Tournament Site (Design Spec v2)

v2 after review by four specialists (tournament director, product designer, engineer, red-team).
Two premises from v1 were **wrong** and are now reversed:

1. **v1 assumed an umpire on every match.** Club pickleball is self-refereed. Scoring is now open by
   a per-court QR/link with no login. Umpire accounts still exist, but as an optional upgrade for the
   showcase court, not the path everything depends on.
2. **v1 assumed rally-by-rally live scoring was the main way scores arrive.** Nobody taps 60 rallies
   for 70 matches. **Quick result entry (type the game scores, ~10 seconds) is now the default**;
   live rally scoring is an opt-in mode per match.

The reviews also agree on what makes this worth building at all, so it is now the home page:
**a live court board that answers "what's on each court, who's next, and is anyone double-booked" across all categories at once.** Challonge and a Google Sheet structurally cannot do this, because they have no idea the categories share four courts.

---

## 1. Roles and how people get in

| Who | How they get in | What they can do |
|---|---|---|
| **Super Admin** (venue owner) | username + password | everything, plus create accounts, reset passwords, manage courts and roster, delete things |
| **Admin** (organiser) | username + password | run tournaments end to end |
| **Scorer** | **no account** — opens the court's QR/link | score only the match currently on that court |
| **Umpire** (optional) | name + 4-digit PIN | same as scorer, but tied to a named person for the audit trail |
| **Public** | nothing | everything except phone numbers and unpublished draws |

Rules: no public sign-up ever. **Two admin accounts are mandatory** before a tournament can go live — if the one organiser is locked out mid-event the day stops. Super Admin gets a printed one-time recovery code at setup.

**Court tokens.** Each court gets a per-tournament secret link + QR, printed on a card taped to the net post. It only ever opens *the match currently assigned to that court*, so a leaked link is worth "someone can mess with Court 3's current match" — visible and fixable — not "someone can edit the tournament". Tokens are revocable and rotate per tournament. Every write is stamped with the device so attribution survives.

## 2. Object model

```
Venue (Madras Pickleball) → Courts (Court 1..N, each with availability windows)
Club roster (players — reused across every tournament)
Tournament
  └── Category  (e.g. "Mixed Doubles", "Men's Doubles 3.5")   ← called "Event" in v1; renamed
       ├── Groups (for group formats)
       ├── Teams / Entries
       └── Matches → Games
```

"Category" replaces "Event" — in a club, *the event is Sunday*. Public pages just say "Mixed Doubles".

## 3. Admin experience

### 3.1 Not a wizard — a dashboard checklist, plus a Quick Play path

Players trickle in, two no-show, someone brings a friend, a category gets added at 10am. A wizard makes all of that back-button archaeology. The tournament page is a **checklist of cards**, each opening a focused sheet, each re-editable after going live, with a persistent primary button that always says the next thing: *"Next: pair the players →"*, *"Next: create the matches →"*, *"Go live →"*. Cards show state inline: "24 players · 12 teams · needs 2 more women".

**Quick Play** is the 80% path and is what the empty state offers:
one screen — name pre-filled *"Sunday Social — 14 Sep"*, a paste box, three big buttons (Men's Doubles / Mixed Doubles / Open Doubles), **Start**. The app picks the format, pairs randomly, creates the matches, goes live and hands back a share link with a Copy button. Everything stays editable afterwards.

### 3.2 Getting 40 players in

The list already exists — in a WhatsApp message. That is the input format we parse:

```
1. Ravi Kumar ✅
2. Priya S 9840012345
3. Arun / Deepa
4. Karthik 4.0
```

Strip numbering, bullets, emoji and ✅ paid-markers; a 10-digit number is a phone; `M`/`F` is gender; `2.0–5.5` is skill; `/` or `&` splits a **pair**, so a pre-paired list becomes teams in one paste. Then a **review table**, every cell editable, ambiguous rows flagged amber with the reason. **Never reject a paste.** Duplicates against the roster get a per-row "Same as Ravi Kumar? Link / Keep separate".

Also, in order of speed: **"Add everyone from last Sunday"** (one tap, then remove no-shows — ~80% right for a weekly club), roster **search-as-you-type with chips** (keyboard never dismisses), then paste.

**Only `name` is required.** Gender is asked lazily — only when a Men's/Women's/Mixed category exists, then as a 3-tap toggle strip over the players who are missing it. Skill is asked only if the admin picks balanced pairing or skill seeding, and is worded **Strong / Regular / New** (stored as 4.0 / 3.5 / 3.0). Photos are not in the add flow. Paid is a toggle column in the player list, admin-only. Phone is optional, admin-only, and **never rendered on any public or scorer screen**.

### 3.3 Categories

Discipline (**Singles / Doubles**) × gender (**Men's / Women's / Mixed / Any**) plus optional `rating_min/max` and `age_min/max`, because real club events are "Beginners Men's" and "35+ Doubles". Note: "Open" is not used for gender — in pickleball Open means the top skill division. Mixed enforces 1M + 1F at pairing time.

### 3.4 Pairing — "Do you already know the pairs?"

Tap a player → they lift into a sticky bar *"Pairing with Ravi ✕"* and the list filters to valid partners (in Mixed, an invalid pair is literally unformable). Tap the second → the team drops into the Teams column. **Two taps per team, identical on phone and laptop.** No drag-and-drop as the only mechanism — it fights scroll on a 390px screen and buys nothing for an unordered pair.

- **"Pair the rest randomly"** at the bottom of the unpaired column. The real workflow is *hand-pair the four couples who always play together, let the app do the other eight* — v1's yes/no binary was wrong.
- Balanced (snake by skill) available where skill data exists.
- Re-roll **previews before committing**: "Keep this" / "Try again". The RNG seed is stored.
- Teams auto-name "Ravi / Priya". Never ask for a team name.
- Live validation: *"Need 6 more women for 12 mixed teams."*
- Odd numbers → substitutes list, shown publicly.

### 3.5 Format picker — recommend, and show the cost in hours

The most consequential decision an organiser makes is whether the day finishes before dark, and v1 offered four equally-weighted jargon terms with no consequences. v2 shows three recommended cards computed from the entry count:

> **Groups first, then knockout** — *recommended for 12 teams*
> 30 matches · about 2 hrs 40 on 3 courts · everyone gets at least 3 games

> **Everyone plays everyone** *(round robin)*
> 66 matches · about 5 hrs 30 · everyone gets 11 games

> **Knockout — lose once and you're out**
> 11 matches · about 1 hr · half of them play once

Estimates: 30 min best-of-3 to 11, 20 min single game to 15, 15 min single to 11, including changeover.

Formats in v1 of the build: **round robin**, **groups → knockout**, **single elimination** with optional **plate/consolation** and **3rd-place match**. Straight knockout is only offered without a warning at ≤8 entries; above that the picker says half the field plays once. **Pools of 3 are never generated** — two guaranteed matches, and one walkover wrecks the pool. Seeds are distributed into pools serpentine (1,2,3,4 / 8,7,6,5 / …) and pool-mates are placed in opposite halves of the knockout.

Americano/Mexicano is **not in v1** — it is a different product (fixed-target rally scoring, per-player standings, no persistent teams). Its tables are reserved in the schema so adding it later is not a migration.

### 3.6 Seeding, byes and bracket positions

Bracket size = next power of 2; byes = size − N, assigned by **standard seed position table**, not "first N in the list":
`16 → [1,16,9,8,5,12,13,4,3,14,11,6,7,10,15,2]`, generated by the interleave recursion. So a 12-team draw plays 8v9, 5v12, 6v11, 7v10 in round 1 and seeds 1–4 get byes into the quarters — 11 matches. Unseeded entries are randomly distributed among non-seed positions from the stored RNG seed. **Byes are real match rows** (`status = bye`, winner pre-set) so brackets render "Ravi — BYE" and advancement has one code path.

### 3.7 Court board — the run-day home screen, phone-first

Not a scheduling tool: *the* admin screen from Go Live to the last match. For each court: what's live with its score, and the queue behind it. Assign by tapping **"Send to Court 2"** (not drag — a third of the effort and better on a phone).

**Cross-category conflict detection is the feature that makes this worth building.** With 40 players across 3 categories, ~12 people are in two categories — double-booking is the *median* case, not an edge case. Before a match can be sent to a court, every player in both teams is checked across **all** categories:

- **hard block** with a named reason if a player is in a live match — *"Ravi is on Court 1"*
- **soft warning** if a player finished under 10 minutes ago — *"Ravi finished 4 min ago"* (overridable)
- an "unavailable" badge on queued matches that can't be placed right now, so the eye skips them

Match states run `pending → ready → on deck → called → warming up → live → completed`, with a 5-minute warm-up timer and a public **"Now calling"** board. Calling players is where organisers lose 45 minutes a day.

### 3.8 The chaos buttons (each under 30 seconds, on a phone)

A Google Sheet's superpower is that it never refuses an edit. Every one of these must exist or the organiser opens Sheets at 2pm and never comes back:

- **No-show** → walkover / promote a named substitute / drop the match
- **Withdraw team** → prompts for the policy, then cascades. Rule: withdrawing before completing half its round-robin matches **voids** the team's results; after that, the rest become forfeits. The policy applied is printed on the standings page.
- **Substitute in / swap partner** — results stay with the team slot, the change is logged
- **Late entry** → substitutes list, then promoted into a bye slot or an extended pool. Never re-run the draw.
- **Revise draw** — free while zero matches are complete. Afterwards, bulk regeneration is refused and targeted surgery is offered (swap a team in place, re-seed unplayed rounds). Draws are versioned and a public note appears: *"Draw revised 10:15 — 2 withdrawals."*
- **Court out of action** (light fails, puddle) → queue rebalances to the remaining courts
- **Shorten the remaining format** — the single most-used emergency tool. Rewrites scoring for un-started matches only ("from now on, single game to 15"), and can drop the plate draw.
- **Pause tournament** → public banner
- **Move a live match to another court**

### 3.9 Corrections

Admin can unlock and correct any result. Rules:
- correcting recomputes everything downstream; if a downstream match has **already started**, the correction is refused until that match is explicitly voided. A bracket never silently flips under a live game.
- three distinct public states: **live (unconfirmed)**, **final**, **corrected at 14:32**. Only *final* feeds standings.
- "move this result to the correct match" exists as an action — misattribution is the common error, not a typo.
- every correction is in the audit log with before/after and who.

## 4. Scoring

### 4.1 Two ways a score arrives

**Quick result (default).** Open the court link → confirm the two team names → type game scores → submit. ~10 seconds. Lands as **`reported`**, not final. It becomes final when the opposing side also submits a matching score, or an admin taps confirm. Mismatched submissions raise a **dispute flag** on the admin dashboard rather than silently overwriting.

**Live rally scoring (opt-in per match).** For the showcase court, semis and finals — and for anyone who wants it. Details in §4.3.

### 4.2 Rules engine (corrected from v1)

- Best of 3 games to 11, win by 2 (default). Also: single game to 15, single to 21. **Hard cap** (e.g. to 11, cap at 15) and **time cap** ("play to the horn") supported — these are how organisers claw back a running-late day.
- Scoring type: **side-out** (default) or **rally** (one server per side, no server number, target and win-by configurable).
- **Doubles starts each game at server 2** — score call `0–0–2` — and the first serving team gets only one service turn. v1 missed this; it would have made every score call in every game wrong.
- **Switch ends: at the end of every game, plus mid-game only in the deciding game** at 6 (games to 11), 8 (to 15), 11 (to 21). v1's "switch at 6" would have marched teams across the court in games 1 and 2 for no reason.
- **Timeouts: 2 per team per game** (3 for games to 21). Medical timeout is separate and doesn't count.
- Scoring config lives on the **category (default) → round (override) → match (override)**, because pools at one game to 15 and knockouts at best-of-3 to 11 is the normal shape of a club day.
- Result types: normal, **bye**, **walkover** (opponent absent), **forfeit**, **retired** (records who retired), **cancelled**.

### 4.3 Live scoreboard — courtside, one hand, Chennai sun

**Tap the team that won the rally.** The app decides point vs side-out vs second server. This was v1's best idea and it survives untouched. What v2 adds:

- **A match-start step** — who serves first, which player of that team, and each team's starting right-side player. Without it the app cannot compute serve position at all, which v1 promised and could not deliver.
- **Cards sit where the teams stand**, and **flip when ends change**. Removes an entire class of mis-taps in game 3.
- Above the fold, nothing else: the spoken score call (`5–3–2` doubles, `5–3` singles), the named server and which side they serve from as a small **court diagram**, games won, timeouts remaining, big Undo, and the server-2 banner. No photos, seeds, ratings or event names.
- **Mis-tap protection**: 24px dead gutter between cards, 48px inert screen margins, 350ms rapid-tap guard, and **auto-lock after 45s idle** (a pocket is not a rally) needing a 400ms press-and-hold to re-arm.
- **Undo is visible**: a 4-second strip after every tap — *"Point — Ravi/Priya · 5–3–2 · UNDO"* — plus a ribbon of the last eight rallies. Undo across a completed game asks "Reopen Game 1?".
- **A match can never end on the gesture that scores a point.** Match end is **press-and-hold 600ms with a filling ring**.
- **"Set the score"** override: set score, server, and positions in one screen with a reason, logged. When a phone dies and the paper score is authoritative, or players served out of order 15 rallies ago, undo-N-times does not help. Without this escape hatch the app becomes un-correctable mid-tournament and gets abandoned — this is the number one killer of scoring apps.
- **One writer per match.** Opening a match claims it with a heartbeat; a second device sees *"Anjali is scoring this on Court 2 — Watch / Take over"* and taking over is logged.
- Wake Lock so the screen doesn't sleep between points, forced max brightness, score digits 96–120px, every control ≥56px, controls in the bottom third.
- Retire / no-show / walkover reachable from inside the scoreboard.

### 4.4 Flaky network, not offline-first

Full offline (service worker + IndexedDB + mergeable event log) is 2+ weeks and its worst failure mode is silently overwriting an admin's correction with a stale offline replay. Instead:

The rules engine runs **client-side**, so the UI never waits on the network. Every tap goes into a queue mirrored to `localStorage` (survives a reload, no service worker) and is flushed as a batch every ~2s with backoff, idempotent on a client-generated UUID and guarded by an optimistic `version`. A badge shows green *synced* / amber *saving (n)* / red *no connection — n unsent*, plus a warning if you try to close the tab with unsent taps. This survives multi-minute signal loss, backgrounding, server errors and double-taps. If a court genuinely has no signal, a wifi extender is the right fix.

## 5. Public site (no login)

**One scrolling page per tournament**, not six tabs — six tabs on a 390px screen forces the visitor to pick a category before they get an answer:

1. **LIVE** — court, teams, big score
2. **Find my match** ← the most valuable thing here
3. **Up next** — the next 6 matches with court and queue position
4. Results · Table / Bracket · Players (collapsible)

**Find my match**: type your name → tap yourself → a card pins to the top:

> **You're on Court 3 next**
> **2 matches away · about 25 min**
> v Arun / Deepa · Mixed Doubles QF

Remembered in localStorage so the next visit is already personal. **Queue position is the primary number, clock time secondary** — at a club event times always slip, and "2 matches away" is both more honest and more useful. This is how a no-login site still feels personal.

Also: **`/display`** TV mode for the screen at the venue — landscape, dark, courts grid, huge scores, "Up next" ticker, a QR in the corner so people can get the link at all. **Share to WhatsApp** buttons that pre-fill plain text plus the link (WhatsApp is the distribution channel, not a competitor). Brackets default to a round-by-round list on phones with the tree behind "View bracket". Printable pool cards, bracket sheets, per-court score sheets and a master schedule — when the wifi dies, the paper is the tournament.

**Never public: phone numbers, unpublished draws, paid status.** Player pages are `noindex`.

## 6. Data model (the parts that changed)

```
+ match_slots(match_id, slot A|B, source_type: entry|winner_of|loser_of|group_rank,
              source_match_id?, source_group_id?, source_rank?, resolved_team_id?)
```
This replaces v1's `next_match_id`/`next_slot`, which could not express a losers' bracket, a 3rd-place match, or — critically — **groups → knockout**, where a slot's source is "winner of Group A" and there is no match to point at. One table, and double elimination later is the same two edge types.

Other changes: `groups` table (name, advance_count); `matches` gains `tournament_id` (denormalised — every public query is tournament-scoped), `version` (optimistic lock), `queue_position`, `scoring_device_id` + claim timestamp, `games_won_a/b` + `score_summary` cache, `locked_at`, `retired_team_id`, `rules_override_json`; `games` gains `server_team_id`, `server_number`, each team's starting-right player, timeout counters; `match_events` gains `client_event_id` (idempotency), `device_id`, `client_seq`, and **`state_after`** so undo is O(1) instead of replaying a fold; `sessions`, `password_reset_tokens`, `login_attempts`, `court_tokens`, `sync_conflicts`, `event_standings_cache`; `players` gains normalised phone as a dedupe key, `dupr_id` + ratings (capturing the identifier is nearly free; re-keying 200 players by hand later is not); `updated_at` **everywhere** because this is a polling app; `deleted_at` soft deletes on players/users/tournaments/categories.

Constraints worth naming: `UNIQUE INDEX ON matches(court_id) WHERE status='live'` makes double-booking a court structurally impossible; `CHECK (winner_team_id IN (team_a_id, team_b_id))`; unique `(match_id, game_no)`, `(match_id, seq)`, `(match_id, client_event_id)`. `courts.order` renamed `sort_order` (reserved word).

### Standings and tiebreaks — defined, and printed on the page

v1's "wins → head-to-head → point difference" is **undefined for a 3-way tie** (A beats B beats C beats A) and would have returned whatever the sort happened to do, in public, to an angry player. Correct order:

1. matches won
2. exactly two tied → head-to-head
3. three or more tied → a **mini-table of only the matches among the tied teams**: wins, then game difference, then point difference. If that separates some but not all, restart the procedure on the remaining subset.
4. overall game difference → point difference → points scored
5. documented draw by the organiser

Per-game point difference is **capped at ±8** so a 11-0, 11-0 doesn't decide a pool on a match nobody played, and so nobody is incentivised to run up the score on a weak pair. **Walkovers and forfeits record an 11-0 11-0 result but contribute zero to point difference.** Retirements keep the points actually played and award the in-progress game at the target score. The rule in force is printed at the foot of every standings table.

## 7. Auth and security

- DB-backed sessions (32 random bytes, **SHA-256 of the token stored**, never the raw token), `HttpOnly; Secure; SameSite=Lax`, `__Host-` prefix, sliding refresh, revocable. Not JWT-only — Super Admin can deactivate an account and it has to take effect.
- **argon2id** via `@node-rs/argon2` (prebuilt; the native `argon2` package can fail to build on Vercel).
- **No email service, so no self-serve password reset.** Super Admin clicks "Reset", the server shows an 8-character code **once** on screen to read out or WhatsApp, hashed and single-use with a 15-minute expiry, and the user is forced to change it on login. No SMS — India's DLT registration for transactional SMS is a project of its own.
- Rate limiting in Postgres (`login_attempts` over 15 minutes + `users.locked_until`). **Lock the account, not the IP** — every umpire is behind one venue NAT, so IP-locking locks out the whole venue at once.
- Umpire sessions expire at end of tournament day, not 30 days — these are shared phones. Prominent "Not you? Switch".
- Public API routes are strictly cookie-free so the CDN actually caches them (touching `cookies()` silently disables caching — verified with `curl -I` for `x-vercel-cache: HIT`).
- Middleware is a cheap redirect only, never the authorization boundary; real checks in server actions.
- Public responses are built by explicit `toPublicPlayer()` / `toPublicMatch()` mappers, never from a raw Prisma model — that is how the phone numbers stay unleaked.

## 8. Live updates without burning the free tier

Naive 5s polling (v1) is ~230,000 function calls and ~46 GB of egress **in one tournament day** — half the monthly bandwidth, on the one day it must not fail. Instead:

1. Clients poll a **version digest** — `{v: max(updated_at)}`, ~30 bytes, 2s TTL — and only fetch the full payload when `v` changes. ~95% less egress.
2. Public reads go through **CDN-cached** route handlers: `s-maxage=3, stale-while-revalidate=30`. 40 viewers cost ~20 origin hits a minute instead of 480.
3. Poll only when the tab is visible; back off to 30s when nothing is live; don't poll completed pages at all.

All of it behind one `useLiveData()` hook, so swapping to Pusher/Supabase Realtime later is a one-file change.

Prisma + Neon must use the **pooled** host with `connection_limit=1` and a `globalThis` singleton, or connections exhaust under exactly the load that matters. Neon free autosuspends after 5 min and Vercel Hobby has no warm instances, so the first login of the morning feels broken — ping the site 10 minutes before start.

## 9. Stack, cost and ownership

Next.js 15 App Router · TypeScript · Tailwind · Prisma · Postgres (Neon) · Vercel.

**Vercel Hobby prohibits commercial use** — a venue charging entry fees is commercial. Budget **Vercel Pro at $20/mo** plus a paid Postgres tier and the domain: roughly **₹1,500–2,500/month**, paid by the venue. Under-budgeting is the most common cause of death for a project like this.

Bus factor, all before launch: **domain, Vercel, Neon and GitHub registered under Saurabh's own email and card**, developer as collaborator. Lockfile committed, versions pinned. Health endpoint plus a free uptime monitor. A one-page runbook in the repo. **Export is a feature, not a nice-to-have** — every finished tournament exports to CSV and a printable PDF, plus an automated weekly dump, so the record survives the app.

## 10. Privacy (DPDP Act 2023)

Name, phone, gender and photos of identifiable people, published to an unauthenticated internet. So: phones admin-only and never rendered publicly; photos opt-in, default off; a one-paragraph collection notice with a named contact and a delete-on-request path; `noindex` on player pages; **no under-18 registrations in v1** until a guardian-consent field exists. Cheap now, expensive to retrofit.

## 11. Look and feel

Written as constraints, not adjectives — *legible at 1m in direct sun, one-handed, assuming a 20% brightness loss through a screen protector.*

- Public/admin (light): ink blue `#0E3A5E`, interactive `#1565C0`, accent **terracotta `#E2582B`** (lime is the worst possible accent for outdoor legibility, and blue+lime is every sports SaaS template). **Green means one thing only: live.** Amber = waiting, grey = done.
- Umpire scoreboard (dark): ground `#0B0F14`, white numerals, the two teams separated by **hue not shade** — blue `#2563EB` vs orange `#EA580C`, which survives every common colour-vision deficiency.
- Team colours are consistent across phone, public page and TV, so it reads as one system.
- Barlow Semi Condensed tabular for scores, Inter for UI, `tabular-nums` everywhere a number updates live or the layout flickers on a TV.

## 12. Plain English everywhere

| Jargon | What the screen says |
|---|---|
| Event | Category (admin) / just "Mixed Doubles" (public) |
| Generate draw | **Create the matches** |
| Round robin | **Everyone plays everyone** *(round robin)* |
| Single elimination | **Knockout — lose once and you're out** |
| Groups → knockout | **Groups first, then knockout** |
| Bye | **Sits out round 1** |
| Seed | avoided; *"strongest players first so they don't meet early"* |
| Standings | **Table** |
| Publish | **Go live** — "Players and spectators can see this. Share the link." |
| Walkover / forfeit / retired | **No-show** and **Stopped mid-match** |
| Teams already built? | **Do you already know the pairs?** |

## 13. Build order

| Phase | What ships |
|---|---|
| 0 | Next.js + Prisma + Neon (pooled), schema, seed, sessions/auth/roles, deployed to a URL on day one |
| 1 | Roster + WhatsApp paste, tournaments, categories, pairing, draft/go-live |
| 2 | Draw engine as pure tested functions: round robin, single elim with seed positions and byes, groups → knockout, advancement via `match_slots`, standings + tiebreaks |
| 3 | **Court board** with conflict detection, court tokens/QR, quick result entry, confirm/dispute, corrections + audit |
| 4 | Public page, Find my match, digest polling + CDN caching, WhatsApp share, `/display` TV mode |
| 5 | Live rally scoreboard: rules engine, match-start lineup, undo, set-score override, claim, localStorage outbox, wake lock |
| 6 | Chaos buttons, print views, CSV/PDF export, runbook, full mock tournament on three real phones |

Phases 0–4 are a usable product on their own. Phase 5 is the showpiece and can land after tournament #1.

**Tested with real unit tests (the only code that gets them):** seed position tables for 8/16/32, round-robin circle method, group advancement, the tiebreak procedure including 3-way ties, and the scoring engine including the 0-0-2 start, win-by-2, hard cap and undo. These are pure functions, they run in milliseconds, and their bugs are silent and land on a public leaderboard.

## 14. Out of scope for v1 — parked, not lost

Americano/Mexicano · double elimination · Swiss · payments and refunds (a static UPI QR at the desk plus a paid checkbox) · player self-registration · player photos · push and SMS notifications · DUPR API sync (the ID field is captured now) · multi-venue · live streaming · career/season stats (deferred until roster identity is clean — a career record built on duplicate rows is worse than none) · audit log viewer (rows are written; read them with SQL).
