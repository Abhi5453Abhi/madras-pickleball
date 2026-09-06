# Madras Pickleball — runbook

One page. If the site is down and nobody has touched the code in six months, this is what you read.

## Who owns what

| Thing | Account | Note |
|---|---|---|
| Domain | Saurabh's registrar login | Auto-renew ON, and in Saurabh's calendar |
| Hosting (Google Cloud Run) | Saurabh's Google Cloud account | Free at this venue's traffic (a few thousand page views a month); a card is on file but nothing is charged inside the always-free allowance |
| Database (Neon Postgres) | Saurabh's Neon account | Free plan, Singapore. It sleeps after a few idle minutes and wakes by itself on the first request |
| Code (GitHub) | Saurabh's GitHub | Developers are added as collaborators, never as owners. Every push to `main` deploys |

**₹0/month** at today's size. If the venue won't own these accounts, the site has no owner six
months from now — that is the single most common way a project like this dies.

## Running it on a laptop

**Go 1.24, Node 22, and a Postgres** (any — `brew install postgresql`, Docker, or a Neon branch).

```bash
cd web && npm install && cd ..
make server                     # the Go server on :8080
make web                        # another terminal: the screens on :5173 with hot reload
```

`make server` reads `DB=` (default `postgres://postgres@localhost:5433/mpb_go?sslmode=disable`),
creates the tables and seeds the venue, four courts and one organiser on first start. Sign in at
`/login` with the temporary PIN **`123456`** and choose your own (set `MPB_SEED_PIN` before the
first start to seed a real one instead).

Other commands:

```bash
make check                      # go vet, Go tests, tsc, web build — what a change must pass
make build                      # bin/mpb: the web app built and embedded into the binary
node web/walks/stage1.mjs       # a browser walk against BASE (default http://localhost:3200)
```

The Go tests that touch a database need `MPB_TEST_DATABASE_URL` and run one package at a time
(`go test -p 1 ./...`) because they share it.

## Deploying to Cloud Run — the whole procedure

Do this once; afterwards every push to `main` deploys by itself.

1. **Neon** (neon.tech): New project → name `madras-pickleball`, region **Singapore
   (ap-southeast-1)**, Postgres 16. On the project's dashboard press **Connect**, choose the
   **pooled** connection string (the host has `-pooler` in it), copy it. It looks like
   `postgresql://…@ep-…-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require…`.
2. **Google Cloud** (console.cloud.google.com): make a project `madras-pickleball`, turn on
   billing (a card is required; the always-free allowance covers this venue), then open
   **Cloud Run → Deploy container → Service**.
3. Pick **Continuously deploy from a repository (source or function)** → **Set up with Cloud
   Build** → connect GitHub, choose `Abhi5453Abhi/madras-pickleball`, branch `^main$`, build type
   **Dockerfile**, source location `/Dockerfile`. Save.
4. Service name `madras-pickleball`, region **asia-southeast1 (Singapore)**, authentication
   **Allow unauthenticated invocations**, billing **request-based**, minimum instances **0**,
   maximum **2**. Under *Container(s)*: port **8080**, memory 512 MiB, 1 CPU; under *Variables &
   secrets* add `DATABASE_URL` = the Neon string from step 1. Create.
5. The first build takes three or four minutes. Open the service URL: the sign-in page. PIN
   `123456`, then choose the real one. That's the site.

The server applies its own migrations at start (under a lock, so two instances starting at once
take turns) and seeds the venue on an empty database; nothing is ever run by hand against
production. A push to `main` builds the same Dockerfile again; a bad build never replaces the
running one. To roll back: Cloud Run → Revisions → pick the previous → *Manage traffic* → 100%.

**Custom domain**: Cloud Run → *Domain mappings* → add `madraspickleball.in` (or whatever is
bought) and set the records it shows at the registrar. The `Secure` cookie needs https, which
Cloud Run always provides.

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
-- from a laptop with the repo: go -C server run ./cmd/mpb -hash 482913   (prints the hash)
update users set pin_hash = '<paste>', must_change_pin = true where username = 'organiser';
```

2. **Locked out by wrong tries** → wait fifteen minutes, or clear them on the database:
   `psql "$DATABASE_URL" -c "delete from attempts"`.

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
| Running late | **Shorten the format** under *More* — best of one, or fewer points — for the matches not yet started; played ones keep the rules they were played under. Never do this on paper; every phone in the venue would then be wrong. |
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
5. `/api/health` answers `{"status":"ok"}` when the app can reach its database; a free uptime
   monitor can watch it and email the owner.

## Fonts

The three faces (Inter, and Barlow Semi Condensed for scores) are inlined into
`web/src/globals.css` as data URLs, so a page needs nothing from the network at load. To change
one: convert the `.woff2` to base64 and replace the matching `@font-face` `src`. Nothing else
changes.
