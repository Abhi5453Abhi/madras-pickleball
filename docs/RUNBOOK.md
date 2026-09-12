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

## Daily games — the scheduler

Open play needs a clock. Three things happen without anybody pressing anything:

| When | What |
|---|---|
| 3 hours before | Confirmations open — every player's own link starts asking "still coming?" |
| 1 hour before | Spots nobody confirmed are released and the waitlist moves up |
| 30 min after the finish | A game nobody ended ends itself |
| 45 min after it ended | Who played is fixed. Nobody who was not ticked off is charged |

All of it is driven by **one URL**: `POST /api/cron/tick`, with
`Authorization: Bearer $CRON_SECRET`. **It wants running every 5 to 15 minutes.**

**Two environment variables on Vercel:**

- `CRON_SECRET` — any long random string. Without it the endpoint answers 401 to everybody,
  including Vercel, which is deliberate: an unguarded state-changing GET on a public URL is the
  bug this whole design avoids.
- `MPB_TOKEN_SECRET` — any long random string. It makes each player's own spot link unguessable
  even to somebody who has seen a database id. Not required; set it.

**Vercel's free plan runs a cron once a day and will not accept anything more often**, so
`app/vercel.json` carries a daily schedule and the `daily games tick` GitHub Action pings the
same URL every ten minutes for nothing. Two repository secrets make it work: `MPB_URL` (the
site, `https://…`, no trailing slash) and `MPB_CRON_SECRET` (the same value as `CRON_SECRET`).
When the project moves to Vercel Pro, change `app/vercel.json` to `*/10 * * * *` and delete the
workflow.

### The gate did not run

Every game screen shows how long ago the tick last finished, and goes red past thirty minutes.
**Missing ticks costs time, not correctness** — three missed weeks produce one catch-up, not
three replayed cycles, and a boundary whose moment has gone is recorded as missed rather than
fired late. Nobody loses a spot because of our outage.

What to do:

1. On any game, press **Run it now**. That does exactly what the tick would have done.
2. Check the GitHub Action's last run, and `CRON_SECRET` / `MPB_CRON_SECRET` still matching.
3. On a laptop pointed at the same database, `cd app && npm run tick` does the same thing.

### Somebody says they lost their spot

Their link is `/s/<token>` and the host's screen can send it to them again — there is a
**Nudge** button beside anybody who has not confirmed, and a **Tell them** button beside
anybody the waitlist promoted. Nothing is ever messaged automatically; in this stage the host
is the delivery channel.

### Nobody was charged for a game

Correct, if nobody was ticked off. The host taps who turned up, and anybody who was not ticked
off by the time the night closed is marked away, which produces no charge. Failing to charge is
recoverable; charging sixteen people who were not there is not.

## The money

Nothing is charged until the night closes. The gate moves a game to `locked` about
45 minutes after it ends, turns everybody ticked off into "played", and writes one charge per
person in the same transaction. Anybody not ticked off is marked away and is not charged.

**Before it locks**, the Tonight screen shows what each person is about to be charged and what
the night comes to. That number and the charge written afterwards come from the same function,
so what the screen promised is what gets billed. This is the window to fix a price, a payer or
an attendance tick — all three are refused once the night is locked.

**After it locks**, the game's own screen grows a Money section: who owes what, take the money,
correct it, waive it. `/admin/money` is the day's tally — cash on its own line, everything else
on theirs, credits separate again — and below it, everybody who owes anything at the venue,
longest waiting first.

### A charge is never edited

Not by anybody, not from anywhere. The amount, the reason and the time are what we said on the
night, and they stay. Everything that happens afterwards is a new row with a sign on it:

- **Charged the wrong amount** → *Correct it*. Type what it should be. If money has already
  landed on that charge, the app takes the payment back off first, in its own row, then posts
  the correction, then spreads whatever came loose over whatever else that person owes. What is
  left sits on their account and shows on their line.
- **Not charging them at all** → *Waive it*, with a reason. Only before anything has been paid
  towards it; after that it is a correction.
- **Giving up on a debt** → write it off. A recorded decision with your name on it, never a
  deletion, and never automatic.
- **They paid too much** → the extra stays on their account and lands on their next charge by
  itself. Send it back instead with a refund, against the payment it came from.

### Taking money at the desk

Tapping *Take the money* claims those charges first, then records the payment, then lets go —
all so that two phones at the same desk cannot both take the same ₹300. If the second one
tries, it says somebody else is collecting that right now, and nothing is taken twice.

An amount can be typed in if they are paying part of it. Blank means the whole thing.

### The books disagree with the rows

`/admin/money` shows a red notice if any of the running totals stop matching the rows they
summarise. It should never appear. If it does: **do not correct anything by hand** — the ids in
the notice say which rows, and the totals can be rebuilt from the rows, which are the truth.
Note what you last did before it appeared, because that is the bug.

### Who can see money

Organisers, and only on organiser screens. Nothing a player can open shows a balance, a charge
or a payment — the public game page shows the price and nothing else. That stays true until
players have verified phones and their own device sessions.

## Courts — who has what, and when

`/admin/courts/day` is the one screen that answers it: every court, hour by hour, what is
on it and what is left. It is also where a court goes out of action.

**A court is held for a time range, not for a day.** A tournament that runs nine to three
leaves the evening free for a game; two games can share an evening on different courts; a
game can be extended mid-evening if the court after it is free. All of that is one table,
`court_holds`, and the rule that stops two things being on one court is a unique index on
quarter-hour slots, not a check anybody has to remember.

Consequences worth knowing on a Tuesday:

- **Time is counted in quarter hours, rounded outward.** A hold from 19:05 to 19:10 takes
  19:00 to 19:15. If a screen says a court is free from 7:15 when the thing before it
  finished at 7:05, that is why, and it is deliberate: the other way round puts two games
  on one court.
- **A court cannot be held in the past.** Making a game for hours that have already gone is
  refused rather than quietly made with no court. A tournament assigned courts halfway
  through its day gets them from now, not from this morning.
- **Finishing a tournament or ending a game gives its courts back immediately**, at the
  minute it happened. That is real now — the old model only said so, and the next
  organiser met a constraint error instead of a court.
- **Blocks have an end.** "Out of action until further notice" is how a court quietly
  disappears for a month, so a block is always for a stated stretch and comes back on its
  own. Re-block it if the net is still broken.
- **Taking a court off a tournament with a live match on it is refused.** Let the match
  finish, or move it, first.

If you ran `npm run dev` on the daily-games branch while stage 2 was being built, delete
`app/.pglite` once: migration 0007 was corrected in place before it shipped anywhere, and an
embedded database that applied an earlier draft will not pick the correction up. A database
that has never seen the branch needs nothing.

If two people save the same court in the same second, one of them is told so and nothing is
half-written. If a save is refused, the sentence names who has the court and until when —
that is the next step, not "blocked".

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
