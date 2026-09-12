# Madras Pickleball

Tournament site for a single pickleball venue: an organiser runs several tournaments at once, each
on its own courts, and enters every score; players sign up from a link and follow the results
without logging in.

- **`app/` — the app that is live.** Next.js on Vercel, with a Neon Postgres. Everything gets
  built here; this is the tree that takes real commits.
- **`docs/RUNBOOK.md`** — accounts, tournament-morning checklist, what to do when it breaks.
- `docs/SPEC.md` and the `SPEC-v*.md` trail — how the product was decided.
  `docs/SPEC-v4-daily-games.md` is the daily-games plan; `docs/ADR-daily-games.md` says how it
  lands in this repo and where it deliberately departs from the plan.
- `server/` and `web/` — a Go + Vite port, **paused**. It was going to replace `app/` on Cloud
  Run and that move was called off; the code is kept for whenever it is picked up again, and
  `docs/GO-API.ts` / `docs/GO-BRIEF.md` describe it. Nothing here is deployed. It wants moving
  to a branch of its own.

## What it does

**Tournaments** — an organiser runs several at once, each on its own courts, and enters every
score. Players sign up from a link; everyone else follows the results without logging in.

**Daily games** — open play. The host puts a Tuesday evening up, players join with a name and a
phone and no account, the host taps who turned up, and (from stage 4) the money follows
afterwards without anyone chasing it.

## Run it on a laptop

Node 22. Nothing else — with no `DATABASE_URL` the app brings its own embedded Postgres
(PGlite, in `app/.pglite`), applies its migrations and seeds the venue on first use.

```bash
cd app && npm install && npm run dev      # http://localhost:3000
```

Sign in at `/login` with the temporary PIN `123456` and choose your own.

```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest — pure logic, plus the database-backed daily-games suite
npm run lint
npm run build
npm run seed:games    # a Tuesday evening with a waitlist, a guest and last week's, closed
npm run tick          # run the daily-games reconciler once, by hand
```

The Go + Vite port in `server/` and `web/` is paused and is not deployed; `make check` still
builds it if you want to pick it up.

## Deploying

Vercel, project `madraspickleball`, root directory `app`. `DATABASE_URL` is the Neon **pooled**
connection string; `CRON_SECRET` guards `/api/cron/tick`, which daily games needs run every five
to fifteen minutes. See the runbook — the free plan only runs a cron once a day, and the
`daily games tick` GitHub Action fills that gap until the project is on Pro.

## The one-sentence version

A court owner runs several tournaments at once, each on its own courts; matches flow onto free
courts by themselves, the organiser only enters scores, and everyone else watches a public page.
