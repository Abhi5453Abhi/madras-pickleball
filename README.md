# Madras Pickleball

Tournament site for a single pickleball venue: an organiser sets up and runs the day, anyone
sitting out can score a match from the QR on the net post, and everyone else watches live without
logging in.

- **`docs/SPEC.md`** — the build spec. Read this first; it explains why things are the way they are.
- `docs/SPEC-v1.md`, `-v2.md`, `-v3.md` — the reasoning trail through three review rounds.
- **`docs/RUNBOOK.md`** — accounts, tournament-morning checklist, what to do when it breaks.
- `app/` — the Next.js application.

## The one-sentence version

The only thing that knows four categories are sharing four courts: a live court board that answers
*what's on each court, who's next, and is anyone double-booked*, wrapped in the smallest tournament
manager that can feed it.
