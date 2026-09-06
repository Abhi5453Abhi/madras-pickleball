# Madras Pickleball

Tournament site for a single pickleball venue: an organiser runs several tournaments at once, each
on its own courts, and enters every score; players sign up from a link and follow the results
without logging in.

- **`docs/RUNBOOK.md`** — accounts, tournament-morning checklist, what to do when it breaks.
- `docs/GO-API.ts` — the contract between the server and the screens: one call per function.
- `docs/SPEC.md` and the `SPEC-v*.md` trail — how the product was decided; `docs/GO-BRIEF.md` —
  how the port was built.
- `server/` — the Go server: the API, the database setup, and the built web app, in one binary.
- `web/` — the React app (Vite). `web/walks/` are the browser walks that prove the whole thing.
- `app/` — the earlier Next.js version, kept until the Go one has run its first tournament.

## Run it on a laptop

Go 1.24, Node 22 and a Postgres. Nothing else.

```bash
cd web && npm install && cd ..
make server        # the Go server on :8080 (DB=postgres://… to point it somewhere else)
make web           # in another terminal: Vite on :5173, proxying /api to :8080
```

The server creates its tables and seeds the venue, four courts and one organiser on first start.
Sign in at `/login` with the temporary PIN `123456` and choose your own.

`make build` builds the web app into the binary (`bin/mpb`); `make check` runs everything:
`go vet`, the Go tests (set `MPB_TEST_DATABASE_URL` for the database ones), `tsc`, and the web
build. The browser walks: `node web/walks/stage1.mjs` and friends against a running server.

## Deploying

One container (`Dockerfile`), one environment variable. On Google Cloud Run, "continuously deploy
from a repository" with the Dockerfile at the repo root, region Singapore, and `DATABASE_URL` set
to a Postgres (Neon's pooled connection string) — every push to `main` then deploys. The runbook
has the step-by-step.

## The one-sentence version

A court owner runs several tournaments at once, each on its own courts; matches flow onto free
courts by themselves, the organiser only enters scores, and everyone else watches a public page.
