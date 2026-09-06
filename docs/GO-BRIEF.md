# The Go + React rewrite — shared brief for every agent

The Next.js app in `app/` is the reference implementation: it works, it is
deployed, and every behaviour in it was reviewed and tested. You are porting
it, not redesigning it. When the reference and this brief disagree, this
brief wins; when this brief is silent, do what the reference does.

`docs/BRIEF.md` (voice, design rules) and the "What the product is now"
section of `/home/claude/wt/AGENT-BRIEF.md` (v4 behaviour) still apply.

## Shape

- `server/` — one Go module (`mpb`), Go 1.24, **standard library plus
  `github.com/lib/pq` only**. No other dependency, ever. Router is
  `net/http`'s `ServeMux` with method + path patterns. Postgres via
  `database/sql`. PINs hashed with `crypto/pbkdf2` (stdlib). Logging with
  `log/slog`.
- `web/` — Vite + React 19 + TypeScript + Tailwind v4 + `react-router`.
  The design system (`src/app/globals.css`, `src/components/ui.tsx`,
  `match-row.tsx`, `score-entry.tsx`, `src/app/admin/_ui.tsx`) and the pure
  libraries the screens need (`chips.ts`, `rules.ts`, `time.ts`) are copied
  over verbatim, minus Next imports.
- The Go binary serves `/api/...` and the built React app (embedded from
  `server/assets/dist`; any unknown path returns `index.html`). One
  container, one URL, no cross-origin anything.
- **The URLs stay exactly the same** as the Next.js app (`/login`, `/admin`,
  `/admin/new`, `/admin/t/:slug`, `/admin/t/:slug/registration`, `/teams`,
  `/teams/pair/:playerId`, `/schedule`, `/results`, `/more`, `/admin/live`,
  `/admin/live/move/:matchId`, `/admin/m/:matchId`, `/admin/account`,
  `/admin/courts`, `/t/:slug`, `/r/:token`, `/`). The Playwright walks in
  `app/scripts/*.mjs` are the acceptance test of the port; they drive URLs,
  read `document.body.innerText`, and click by visible text — so the words
  on screen, the `id`s of inputs (`#pin`, `#current`, `#next`, `#confirm`,
  `#name`, `textarea[name=text]`, `input[aria-label="Add a court"]` …) and
  the order of things must survive the port.

## The API: one call per server function

The reference's server modules (`app/src/server/*.ts`) are the API. Every
exported function a page or action uses becomes one RPC:

    POST /api/rpc/<module>.<function>      body: JSON object of the arguments
    → 200 JSON result
    → 400 {"error": "…"}   input rejected (the message is for a person)
    → 401 {"error": "…"}   no session (the client goes to /login?next=…)
    → 403 {"error": "…"}   wrong role
    → 404 {"error": "…"}   no such tournament / match / token

`docs/GO-API.ts` is the contract: for each RPC, its input object and its
result type, trimmed to what the screens actually read. Field names are
camelCase exactly as in the TypeScript; dates travel as ISO-8601 strings;
`null` is `null`, never omitted when the contract says `T | null`.

Actions that used to `redirect()` return `{ ok: true, redirect: "/admin/…" }`
and the client navigates; actions that used to return `{ ok: false, error }`
still do, with a 200 status (a refused action is not a transport error).

Three groups need no session: `public.*`, `registration.resolveRegistrationToken`,
`registration.submitRegistration`, and the version pollers
`GET /api/version/today`, `GET /api/version/t/{slug}`. Everything else
requires a signed-in organiser; `organisers.addOrganiser` / `removeOrganiser`
/ `listOrganisers` require the owner.

Sign-in: `auth.login {pin, next?}` sets the session cookie (`HttpOnly`,
`SameSite=Lax`, `Secure` when the request came in over https) and returns
`{ ok, redirect }` or `{ ok:false, error }`; `auth.logout`; `auth.me` returns
the signed-in organiser or 401. Every POST checks `Origin` against the
request host — that is the CSRF defence.

## Database

`server/migrations/*.sql`, applied at start under an advisory lock (the
container may start twice at once). The schema in `0001_init.sql` is the
whole data model; read it before writing a query. If you truly need a
column, add `000N_<name>.sql` and say so in your report — never edit
`0001_init.sql` after it has been applied anywhere.

Tests that touch the database use the sandbox Postgres:
`postgres://postgres@localhost:5433/<your own database>` — create it with
`psql -h /tmp -p 5433 -U postgres -c "create database mpb_<name>"`. Each
test file may truncate everything at start. Set `MPB_TEST_DATABASE_URL`;
tests skip when it is unset.

## Rules that do not bend

1. No dependency beyond `lib/pq` on the Go side; no new npm packages beyond
   what `web/package.json` already lists.
2. Every RPC authorises independently. The HTTP layer checks the session and
   role by the registry entry; the function still checks the object belongs
   to the venue.
3. Inputs are untrusted JSON: copy fields out by hand, validate, refuse with
   a message a person can act on.
4. Public RPCs never read cookies and never return phone numbers.
5. Plain English on screen, never a raw enum or id. British spelling. No
   exclamation marks. Name the person or the court. Reuse the reference's
   words.
6. Comments explain why, especially where the obvious approach was wrong.
7. Keep it green: `go vet ./... && go test ./...` (server) and
   `npx tsc -b && npx vite build` (web) must pass before you finish.
8. Work only in your worktree, only in the files your section names. Commit
   as you go with `git -c user.name=Claude -c user.email=noreply@anthropic.com commit`.
   Do not merge, rebase, push or switch branches.

## Final report (the integrator reads only this)

What you built; every file created or changed; test results with counts;
bugs you found elsewhere (file:line); what you simplified away and why;
anything the integrator must do when merging. Short and honest.
