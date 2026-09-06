# Madras Pickleball

Tournament site for a single pickleball venue: an organiser runs several tournaments at once, each
on its own courts, and enters every score; players sign up from a link and follow the results
without logging in.

- **`docs/SPEC.md`** — the build spec. Read this first; it explains why things are the way they are.
- `docs/SPEC-v1.md`, `-v2.md`, `-v3.md` — the reasoning trail through three review rounds.
- **`docs/RUNBOOK.md`** — accounts, tournament-morning checklist, what to do when it breaks.
- `app/` — the Next.js application.

## Run it

```bash
cd app
npm install
cd ..
npm run dev     # http://localhost:3000 — works from the repo root too
```

Node 22 or 24 and nothing else — it brings up its own embedded Postgres on first run and seeds a venue
with four courts and one organiser. Sign in at `/login` with the temporary PIN `123456` and choose
your own.

If you already have `DATABASE_URL` exported in your shell for another project, it takes precedence
and this app will try to use that server. Force its own database with `MPB_DB=embedded npm run dev`.

## Deploying

Deployed with no `DATABASE_URL` it runs as a demo: an embedded database per instance that resets
when the host recycles it, seeded with a sample Sunday, PIN `123456`. For real use set
`DATABASE_URL` to a Postgres (Neon's pooled host) in the host's environment — see the runbook.

## The one-sentence version

A court owner runs several tournaments at once, each on its own courts; matches flow onto free
courts by themselves, the organiser only enters scores, and everyone else watches a public page.
