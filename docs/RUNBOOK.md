# Madras Pickleball — runbook

One page. If the site is down and nobody has touched the code in six months, this is what you read.

## Who owns what

| Thing | Account | Note |
|---|---|---|
| Domain | Saurabh's registrar login | Auto-renew ON, and in Saurabh's calendar |
| Hosting (Vercel) | Saurabh's Vercel account | **Pro plan, ~$20/mo.** Hobby prohibits commercial use, and a venue charging entry fees is commercial |
| Database (Neon Postgres) | Saurabh's Neon account | Paid tier — the free tier autosuspends and its point-in-time recovery window is about a day |
| Code (GitHub) | Saurabh's GitHub | Developers are added as collaborators, never as owners |

Roughly **₹1,500–2,500/month** all in. If the venue won't own these accounts, the site has no owner
six months from now — that is the single most common way a project like this dies.

## Running it on a laptop

**Node 22 or 24** (24 LTS preferred) and nothing else. **No database to install.**
Odd-numbered releases such as Node 23 are not supported by several dependencies.

```bash
cd app
npm install
npm run dev            # http://localhost:3000
```

`npm run dev` applies migrations and seeds the venue, four courts and the starting accounts on
first run. With no `DATABASE_URL` it uses an embedded Postgres (PGlite) kept in `app/.pglite/` —
real Postgres, so the partial indexes and CHECK constraints behave exactly as they will in
production. Delete that folder to start clean.

Other commands:

```bash
npm run smoke:setup    # once: installs Playwright + a headless Chromium
npm run smoke          # end-to-end check driving a real browser
npm run test           # unit tests for the draw engine and scoring rules
npm run typecheck
npm run db:generate    # after editing src/db/schema.ts
```

**Against a real Postgres** (staging or production) set `DATABASE_URL` and `DIRECT_URL` in
`app/.env` and the app switches automatically. If `DATABASE_URL` is already exported in your shell
for some *other* project, it will hijack this app — force the embedded one with:

```bash
MPB_DB=embedded npm run dev
```

Every run prints which database it is using, so this is visible rather than mysterious. On Neon, `DATABASE_URL` must be the **pooled** host
(`...-pooler...`) with `connection_limit=1`, and `DIRECT_URL` the direct host for migrations.
Get this wrong and connections exhaust under exactly the load that matters.

**On the host** nothing is run by hand: the deployed app carries its migrations and, on the first
visit, creates whatever the database is missing and seeds the venue, four courts and one organiser
(temporary PIN `123456`). It keeps the same record drizzle's migrator keeps, so `npm run db:migrate`
from a laptop and the app never disagree about what has been applied. On Vercel the quickest way to
a database is *Storage → Create Database → Neon*, which sets `DATABASE_URL` for the project itself.

Sign-in is a six-digit PIN — no username. A fresh install seeds one organiser with the temporary
PIN **`123456`**, which must be replaced the first time it is used (set `MPB_SEED_PIN` to seed a
real one instead). Accounts from before PIN sign-in are given temporary PINs in order —
`123456`, `234567`, … — and `npm run dev` prints which account got which.

## The venue and the people with keys

- **Courts**: *Your account → The venue's courts* (`/admin/courts`). Rename, add, take out. A court a
  tournament is counting on cannot be taken out from there — take it off the tournament first under
  *Schedule & courts*. A court taken out comes back with its history if you add it by the same name.
- **A second organiser**: the venue owner adds them under *Your account → Organisers*. They get a
  temporary PIN shown once; they choose their own the first time they sign in. Removing them ends
  their PIN and signs them out everywhere. Every organiser can do everything except this list.
- **Players**: from the sign-up link, or pasted into *Registration* as the list from the group
  chat — one name per line, numbering and phone numbers fine, names already in are skipped.

## Someone is locked out

Five wrong PINs from one phone and that phone waits fifteen minutes. There is no email service,
so there is no self-serve reset — deliberately.

1. **An organiser has forgotten their PIN** → another organiser cannot see it either. Connect to
   the database and set a temporary one; they are forced to pick their own at sign-in:

```sql
-- generate the hash first:  node -e "require('@node-rs/argon2').hash('482913').then(console.log)"
update users set pin_hash = '<paste>', password_hash = '<paste>', must_change_password = true
where username = 'organiser';
```

2. **Locked out by wrong tries** → wait fifteen minutes, or `npm run db:reset-lockouts`.

## Tournament morning

- **Ping the site about 10 minutes before the first match.** Neon autosuspends after a few minutes
  idle and the host has no warm instances, so the first login of the morning otherwise feels broken.
- Open each tournament and check its checklist is all ticks: players in, pairs made, courts
  picked, schedule made. Then **Start** — the first matches go straight onto the free courts.
- Print the **per-court paper score sheets**. When the wifi dies, the paper is the tournament.
- Keep the **live board** open. It shows every court at the venue, whichever tournament is on it.

## Something went wrong mid-day

| Symptom | Do this |
|---|---|
| Wrong score published | **Edit this match** on the court board — teams, court, scores, status, result type, with a reason. Everything downstream recomputes. |
| A correction is refused | It says which match is blocking it. Void that match first, or use *apply when Court 3 finishes*. |
| Running late | **Shorten the remaining format** — it rewrites un-started matches only and can drop a stage. Never do this on paper; every phone in the venue would then be wrong. |
| A court is unusable | **Court out of action**. The queue and the finish estimate recompute. |
| Someone didn't show | **No-show** → walkover. Never type 11-0 by hand; a typed score corrupts the point-difference tiebreak. |

## Backups and disaster recovery

- **Export every finished tournament** (JSON + CSV) from its page. This is the record that survives
  the app.
- A weekly automated dump runs to the owner's storage. Verify it restores at least once.
- Take a manual dump before and after each tournament:
  `pg_dump "$DATABASE_URL" > mpb-$(date +%F).sql`

## When the site is down

1. Check the host's status page and the deployment log for a failed build.
2. Check the database is awake and not over its plan limits.
3. Check the domain has not expired.
4. Redeploy the last known-good commit.
5. `/health` returns the app and database status; a free uptime monitor watches it and emails the
   owner.

## Fonts

The score face is intended to be Barlow Semi Condensed. The build environment used to develop this
had no access to Google Fonts, so the stack falls back to the narrowest available system faces.
To switch: drop `Barlow-SemiCondensed.woff2` into `src/app/fonts/`, load it with `next/font/local`,
and point `--font-score` at the resulting variable in `globals.css`. Nothing else changes.
