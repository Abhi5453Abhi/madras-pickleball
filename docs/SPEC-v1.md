# Madras Pickleball — Tournament Site (Design Spec v1)

Single venue: **Madras Pickleball**. Built so a second venue can be added later without a rewrite.

## 1. Roles

| Role | Login | Can do |
|---|---|---|
| Super Admin (host) | yes | everything: create/delete tournaments, create admin & umpire accounts, edit finished scores, manage courts & club roster |
| Admin (organiser) | yes | register players, create events, form teams, generate draws, assign courts + umpires, correct live scores, publish results |
| Umpire | yes | see only matches assigned to them; run the scoreboard; submit final score |
| Public viewer | **no login** | schedule, live scores, brackets, standings, results, player pages |

No public sign-up anywhere. Accounts are created by Super Admin only.

## 2. Object hierarchy

```
Venue (Madras Pickleball)
  └── Courts (Court 1..N)
Club Player Roster  (reused across tournaments)
Tournament
  └── Event  (= one category, e.g. "Men's Doubles Open")
       ├── Teams / Entries
       └── Matches → Games
```

An **Event** is the unit that has a format, a draw, and a winner. A tournament can run several events at once.

## 3. Tournament lifecycle (admin flow)

1. **Create tournament** — name, dates, venue (fixed = Madras Pickleball), banner, description, which courts are in use.
2. **Register players** — pull from club roster or add new. Fields: name, gender, phone, skill level (optional 2.0–5.5), photo (optional). Bulk paste / CSV import supported. Mark paid / unpaid.
3. **Add events** — for each event choose:
   - Discipline: **Singles** or **Doubles**
   - Category: **Men's / Women's / Mixed / Open**
     (Mixed only allowed with Doubles; Open = anyone)
   - Name auto-fills, e.g. "Mixed Doubles" / "Men's Singles"
4. **Add players to the event** — pick from the tournament's registered players.
5. **Team formation** — the app asks: *are teams already built, or built on the go?*
   - **Already built** → admin pairs players manually (pick partner A + partner B, or import a list of pairs). Singles auto-creates one-player entries.
   - **Build on the go** → choose one:
     - *Random draw* — shuffle into pairs, re-roll allowed until locked
     - *Balanced* — snake pairing by skill (strongest with weakest)
     - *Rotating partners (Americano)* — no fixed teams at all; partners change every round, ranking is per player
   - Odd number of players → leftover goes to a **substitutes list**.
6. **Choose draw format** —
   - Single elimination (bracket, byes to top seeds)
   - Round robin (everyone plays everyone)
   - Groups → knockout (groups of 4–5, top N advance)
   - Americano (only for rotating partners)
   - Seeding: by skill, manual, or random
7. **Generate schedule** — creates all matches. Admin then either assigns fixed times, or uses the **Court Queue** (recommended for a local one-ground event): a live board of courts; drag the next ready match onto a free court.
8. **Assign umpires** — per match, or "any umpire on Court 2".
9. **Publish** — event becomes visible to the public. Before publish it's a draft.
10. **Run day** — scores flow in from umpires, standings/brackets update automatically.
11. **Complete** — winners recorded, results page frozen, tournament archived.

## 4. Scoring rules (per event, configurable)

- Format: **best of 3 games to 11, win by 2** (default) | single game to 15 | single game to 21
- Scoring type: **traditional side-out** (default — only the serving team scores) | rally scoring
- Doubles server number tracked (1 / 2) so the score call reads "5 – 3 – 2"
- Switch-ends reminder at 6 points (games to 11)
- 1 timeout per team per game (counter only)
- Non-standard results: walkover, retired, forfeit / no-show

## 5. Umpire scoreboard (phone-first)

- Login → **My matches today** → tap match → **Start**
- One screen: two huge team cards. **Tap the team that won the rally.** The app works out the rest — if they were serving it's a point, if not it's a side-out / second server. Umpires never have to think about the rule.
- Always visible: score call (5–3–2), who serves, and which player should be standing right/left in doubles.
- Big **Undo** button (undoes any number of steps, full event log kept).
- Game over → confirm → switch ends prompt → next game.
- Match over → **Confirm final score** → locked. Only admin can unlock and correct.
- Works offline: scoring continues with no signal, syncs when back, shows an "unsynced" badge.
- Add-to-home-screen (PWA) so it opens like an app.

## 6. Public site (no login)

- **Home** — Madras Pickleball branding, current tournament, a LIVE strip of matches in progress.
- **Tournament page** with tabs: Schedule · Live · Draws · Standings · Players · Results
- **Match page** — live score, game-by-game, court, umpire.
- **Player page** — their matches, results, record.
- Pages auto-refresh every ~5s while anything is live.
- Everything shareable by link, works well on a phone.

## 7. Data model (Postgres via Prisma)

```
users(id, name, username, phone, password_hash, role[super_admin|admin|umpire], active, created_at)
venues(id, name, slug)
courts(id, venue_id, name, order, active)
players(id, name, gender, phone, skill_level, photo_url, notes)
tournaments(id, name, slug, venue_id, start_date, end_date, status[draft|registration|live|completed], banner_url, description)
tournament_players(tournament_id, player_id, paid, registered_at)
events(id, tournament_id, name, discipline, category, team_mode, draw_type, scoring_json, status, seq)
event_players(event_id, player_id, substitute)
teams(id, event_id, name, seed, group_label, status)
team_players(team_id, player_id)
matches(id, event_id, round_index, round_name, seq, team_a_id, team_b_id, court_id, scheduled_at,
        started_at, ended_at, status[pending|ready|live|completed|walkover|cancelled],
        umpire_id, winner_team_id, result_type, next_match_id, next_slot)
games(id, match_id, game_no, score_a, score_b, completed)
match_events(id, match_id, seq, type[start|rally|sideout|timeout|undo|game_end|match_end], payload, at, by)
audit_log(id, user_id, action, entity, entity_id, before, after, at)
```

Standings are computed, not stored: wins → head-to-head → point difference → points scored.

## 8. Auth & security

- Username/phone + password, argon2 hashed. HTTP-only signed session cookie, 30-day "remember me" for umpires.
- Role checked server-side on every write. Umpires can only write to their own assigned matches.
- Login rate limiting; audit log on every score correction.

## 9. Stack

- **Next.js 15 (App Router) + TypeScript + Tailwind**
- **Postgres (Neon free tier) + Prisma**
- Live updates by 5s polling (no websocket infra to run)
- Deploy on **Vercel free tier**; custom domain later
- PWA manifest for the umpire screen

## 10. Look and feel

Clean, sporty, uncluttered. Court-blue primary with a lime accent, lots of white space, large readable type, rounded cards. Mobile-first — most people will open this on a phone at the court.

## 11. Explicitly out of scope for v1

Payments, player self-registration, multi-venue, live streaming, DUPR sync, photo galleries, push notifications.
