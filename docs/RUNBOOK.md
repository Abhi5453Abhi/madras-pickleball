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

Node 20+ is the only requirement. **No database to install.**

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
npm run smoke          # end-to-end check driving a real browser
npm run test           # unit tests for the draw engine and scoring rules
npm run typecheck
npm run db:generate    # after editing src/db/schema.ts
```

**Against a real Postgres** (staging or production) set `DATABASE_URL` and `DIRECT_URL` in
`app/.env` and the app switches automatically. On Neon, `DATABASE_URL` must be the **pooled** host
(`...-pooler...`) with `connection_limit=1`, and `DIRECT_URL` the direct host for migrations.
Get this wrong and connections exhaust under exactly the load that matters.

Seeded accounts (all forced to change their password at first login):

| Username | Role | Temporary password |
|---|---|---|
| `saurabh` | super admin | `change-me-now` |
| `admin2` | admin | `change-me-too` |
| `umpire1` | umpire | `change-me-also`, PIN `4821` |

## Someone is locked out

There is no email service, so there is no self-serve password reset — deliberately.

1. **An admin or umpire is locked out** → the super admin opens *People*, clicks **Reset password**,
   and reads out the 8-character code shown once on screen. It is single-use and expires in 15
   minutes; the user is forced to pick a new password at login.
2. **The super admin is locked out** → use the printed one-time recovery code.
3. **Both are gone** → connect to the database and reset the hash directly:

```sql
-- generate the hash first:  node -e "require('@node-rs/argon2').hash('new-password').then(console.log)"
update users set password_hash = '<paste>', must_change_password = true,
                 locked_until = null, failed_login_count = 0
where username = 'saurabh';
```

Account lockout is on the **account**, not the IP — everyone at the venue shares one NAT, so
IP-based locking would lock out the whole club at once.

## Tournament morning

- **Ping the site about 10 minutes before the first match.** Neon autosuspends after a few minutes
  idle and the host has no warm instances, so the first login of the morning otherwise feels broken.
- Print the **court cards** (one per court, A5, laminated, cable-tied to the net post) and the
  **A4 QR poster** for the entrance. Cards carry a fresh token per tournament — reprint them.
- Print the **per-court paper score sheets**. When the wifi dies, the paper is the tournament.
- Check the finish estimate on the court board against sunset before the first serve.

## Something went wrong mid-day

| Symptom | Do this |
|---|---|
| Wrong score published | **Edit this match** on the court board — teams, court, scores, status, result type, with a reason. Everything downstream recomputes. |
| A correction is refused | It says which match is blocking it. Void that match first, or use *apply when Court 3 finishes*. |
| A court QR got posted in a big WhatsApp group | **Revoke all court tokens** on the tournament page, then reprint that court's card. |
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
