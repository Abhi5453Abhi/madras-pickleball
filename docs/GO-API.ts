// ═══════════════════════════════════════════════════════════════════════════
//  GO-API.ts — the complete RPC contract for the Go + React port.
//
//  This file is the agreement between `server/` (Go) and `web/` (React). It
//  type-checks on its own: no imports, no dependencies. Every type here is a
//  wire shape, not a database row.
//
//  ── Conventions ──────────────────────────────────────────────────────────
//
//  Transport
//    POST /api/rpc/<module>.<function>
//      body: a JSON object — the `input` of the matching type below.
//            An RPC whose input is `Record<string, never>` still takes a body:
//            send `{}`.
//      →  200 <output as JSON>
//      →  400 {"error": "…"}  input rejected (the message is for a person)
//      →  401 {"error": "…"}  no session (the client goes to /login?next=…)
//      →  403 {"error": "…"}  wrong role
//      →  404 {"error": "…"}  no such tournament / match / token / player
//    Every POST checks `Origin` against the request host — that is the CSRF
//    defence. A refused *action* is NOT a transport error: it comes back 200
//    with `{ok: false, error}` so the screen can print the sentence.
//
//  Auth groups
//    public     — no session, no cookie read, never returns a phone number:
//                 `public.*`, `registration.resolveRegistrationToken`,
//                 `registration.submitRegistration`, `auth.login`,
//                 and the version pollers `GET /api/version/today`,
//                 `GET /api/version/t/{slug}`.
//    organiser  — a signed-in `owner` or `organiser`. Everything else.
//    owner      — `organisers.listOrganisers`, `organisers.addOrganiser`,
//                 `organisers.removeOrganiser`. A signed-in organiser who is
//                 not the owner gets 403; the client sends them to
//                 `/admin?denied=1`.
//
//  Version endpoints (GET, not RPC — they are polled every 5s per phone)
//    GET /api/version/today        (public)     → {version: string}
//    GET /api/version/t/{slug}     (public)     → {version: string}
//                                   404 when the slug is unknown or deleted
//    GET /api/version/venue        (organiser)  → {version: string}
//    The version a page renders with and the version this endpoint returns
//    MUST be computed by the same code path, or every phone in the venue
//    hard-refreshes every five seconds. The values are opaque strings:
//    compare for equality, never order them.
//
//  Auth RPCs
//    auth.login  {pin, next?} → {ok:true, redirect:string}
//                             | {ok:false, error:string}
//      Sets the session cookie: HttpOnly, SameSite=Lax, Path=/,
//      Secure when the request arrived over https.
//    auth.logout            → {ok:true}   (clears the cookie and the row)
//    auth.me                → {id, name, role:'owner'|'organiser',
//                              mustChangePin:boolean}   401 when signed out
//    Role mapping from the reference: super_admin → owner, admin → organiser.
//    The reference's `umpire` role is gone: v4 has no umpire accounts.
//
//  Shapes
//    Field names are camelCase, exactly as in the reference TypeScript,
//    except where a note says otherwise. Dates travel as ISO-8601 strings.
//    `null` is `null` — a field typed `T | null` is always present.
//    Maps travel as JSON objects (`Record<string, …>`), never as arrays of
//    pairs.
//
//  Renames forced by the new schema (`server/migrations/0001_init.sql`)
//    • There is no `categories` table. A tournament IS its category. Every
//      reference argument or field called `categoryId` is `tournamentId`
//      here; `events.primaryCategory` and `tournaments.getCategory` are gone
//      and their fields (discipline, gender, finalsStage, bestOf,
//      pointsToWin, advancePerGroup) live on the tournament.
//    • The reference's `tournament.startDate` / `endDate` pair is one column,
//      `day`, and travels as `"YYYY-MM-DD"` (the venue day, Asia/Kolkata).
//    • Tournament status is `setup | live | completed`. The reference's
//      `draft` and `registration` are both `setup`; `archived` is gone.
//      Paused is not a status: it is `pausedAt` + `pauseNote`.
//    • Dropped everywhere, because the columns no longer exist: bannerUrl,
//      sunsetAt, streamVersion (replaced by the opaque `version`),
//      scoringMode, umpireId, provisional, dispute*, confirmed*, reported*,
//      skill, dupr, paid, breakStartsAt/breakEndsAt, publishedAt,
//      result submissions, per-player `withdrawn` (withdrawal is per team).
//
//  Reference functions that are NOT RPCs, and why
//    events.formatWords / FORMAT_WORDS, events.categoryName,
//    registration.signupsClosed, scoring.projectedState,
//    organisers.normalizePin, lib/rules, lib/chips, lib/standings tieNote,
//    lib/estimate, lib/time  — pure, copied into `web/src/lib`.
//    server/bootstrap ensureReady        — runs at Go start-up.
//    board.flowVenue / board.flowTournament — never called from a screen; the
//      Go write RPCs call them where the notes below say so.
//    teams.settleTeams                   — folded into `events.hub`,
//      `teams.teamBoard` and `tournaments.generateDraw` (see their notes).
//    scoring.submitResult / scoring.adminSetResult — one RPC,
//      `scoring.saveResult`, picks between them exactly as the reference
//      action does.
//    registration.addPlayerByHand / addPlayersByHand — one RPC,
//      `registration.addByHand`, picks between them on the newline.
//    organisers.organiserForPin / setPin — inside `auth.login` and
//      `organisers.changePin`.
//    tournaments.getVenue / createTournament / importPlayers /
//      rosterSnapshot / createCategory / listCategories / setCategoryPlayers /
//      createTeams / pairingSeedFor / pairRandomly / persistDraw / clearDraw,
//      events.syncCategoryPlayers, registration.issueRegistrationLink /
//      currentRegistrationToken / addPlayer, board.boardData /
//      offersForFreeCourts / livePlayerConflict, scoring.rulesFor /
//      normalizedDigest / normalizeResult / isProvisional / outcomeFor /
//      resolveSlotsFor / correctionBlockers, chaos.* helpers — internal to
//      the Go package; no screen calls them.
//
//  Two decisions the integrator has taken
//    1. `tournaments` carries `best_of` (default 3), `points_to_win`
//       (default 11) and `advance_per_group` (default 0, set when the draw is
//       made) — they are in `0001_init.sql`. `chaos.shortenFormat` writes the
//       first two; `scoring.getMatchForScoring` and `events.hub` read them.
//    2. The sign-up link has no expiry column: it stops working by the
//       calendar. `registration.ensureRegistrationLink` returns null once the
//       tournament's day has ended in the venue's timezone (Asia/Kolkata), and
//       `registration.resolveRegistrationToken` treats such a token as
//       unknown. The reference's "The day has passed — the sign-up link stopped
//       working" card therefore stays, keyed on that null.
// ═══════════════════════════════════════════════════════════════════════════

// ─────────────────────────── shared vocabulary ───────────────────────────

/** A tournament is one category, so these three describe the tournament. */
export type Gender = 'mens' | 'womens' | 'mixed' | 'any'
export type Discipline = 'singles' | 'doubles'
/** The three formats: everyone plays everyone; …then a final; …then semis. */
export type FinalsStage = 'none' | 'final_only' | 'semis_and_final'

/** `setup` covers the reference's `draft` and `registration`. */
export type TournamentStatus = 'setup' | 'live' | 'completed'

export type MatchStatus = 'pending' | 'ready' | 'live' | 'completed' | 'cancelled'
export type ResultState = 'none' | 'final' | 'voided'
export type ResultType = 'normal' | 'bye' | 'walkover' | 'retired' | 'cancelled'
/** What a screen may send as a result. `bye` and `cancelled` are server-made. */
export type SubmittableResultType = 'normal' | 'walkover' | 'retired'
export type Stage = 'group' | 'knockout'

export type Role = 'owner' | 'organiser'

/** A court as every screen shows it: swatch, name. */
export type Court = {
  id: string
  name: string
  /** blue | orange | teal | violet | clay | indigo — the swatch and card edge. */
  colorKey: string
}

/** One game of a match. `timeCapped`: stopped by the horn, out of point diff. */
export type GameScore = {
  gameNo: number
  scoreA: number
  scoreB: number
  timeCapped?: boolean
}

/** v4 plays best of 3 to 11, win by 2, no cap. Sent so the entry screen is pure. */
export type ScoringRules = {
  /** 1 or 3. Best of 3 means first to 2 games. */
  bestOf: number
  pointsToWin: number
  winBy: number
  /** At the cap the next point wins, win-by-1. Null = no cap. */
  hardCap: number | null
}

/**
 * A match as the live board draws it. The venue board is the only screen that
 * reads this shape; it needs nothing more than the two names, the round and
 * how long it has been on.
 */
export type BoardMatch = {
  id: string
  roundName: string | null
  /** "Ravi Kumar / Priya S" — null when the slot is not resolved yet. */
  nameA: string | null
  nameB: string | null
  /**
   * Minutes it has been on court beyond what its format should take, or null.
   * Non-null is the signal for the amber "On for N min and no score" band and
   * the terracotta "Enter it for them" button.
   */
  overrunMinutes: number | null
}

/**
 * One tournament's line on the venue board. `board` in the reference is
 * flattened here to `remaining`, the only field the screen reads off it.
 */
export type VenueTournament = {
  id: string
  slug: string
  name: string
  /** "Men's Doubles" — categoryName(gender, discipline), computed, not stored. */
  categoryName: string
  /** "Men's", "Mixed" — the day strip has room for one word. */
  shortName: string
  /** status === 'live'. */
  running: boolean
  /** The note the organiser gave while the day is stopped, else null. */
  paused: string | null
  played: number
  total: number
  /** Not on a court yet: queue + waiting. Drives "has N to play". */
  toPlay: number
  /** Matches with no result at all (played + remaining === total). */
  remaining: number
  /** ISO date-time, or null when nothing can be estimated. */
  finishAt: string | null
  /** This tournament's courts, in venue order — see `events.assignCourts`. */
  courtIds: string[]
}

/** One court card on the venue board, in venue order. */
export type VenueCourt = {
  id: string
  name: string
  colorKey: string
  /** Who holds it today, running or not. Null: nobody — the hatched card. */
  tournament: VenueTournament | null
  /**
   * Always null in v4: the port has no court-closure table. Kept so the
   * "Out of action — <reason>" band survives if one is ever added.
   */
  closedReason: string | null
  live: BoardMatch | null
  /** What will go on here next, when it is known. */
  next: BoardMatch | null
  /** When `next` is not a match: "waiting on Court 1's result", or the exact
   *  strings "Nothing left for this court" / "This is the last one here",
   *  which the screen prints plain rather than after "Next here:". */
  nextNote: string | null
  /** A free court with a playable match nobody put on — the safety net. */
  offer: BoardMatch | null
  /** Why a free court is standing empty, in one sentence. */
  idleReason: string | null
}

// ═══════════════════════════════ auth ═══════════════════════════════

/** auth.login — check a six-digit PIN and open a session. Auth: public.
 *  Used by: /login (the sign-in form)
 *  Reference: src/app/login/actions.ts login(), src/server/organisers.ts
 *    organiserForPin(), src/lib/session.ts createSession()
 *  Notes: the PIN is the whole credential — there is no username, and two
 *    organisers can never share a PIN. Rate-limited per client-IP hash: five
 *    wrong PINs in fifteen minutes and it refuses with
 *    "Too many wrong PINs. Try again in N minutes." A PIN that is not six
 *    digits is wrong before it is checked, and still counts, or the shape of
 *    the input becomes a free oracle. Otherwise the refusal counts down:
 *    "That's not it. N tries left before a fifteen-minute wait." and, at
 *    zero, "That's not it. Wait fifteen minutes before trying again."
 *    On success the cookie is set and `redirect` is `/admin/account?first=1`
 *    when the organiser still holds a temporary PIN, otherwise `next` — which
 *    is accepted ONLY when it starts with `/admin` and not `//`, else
 *    `/admin`. Always 200; a wrong PIN is `{ok:false}`, never 401. */
export type Auth_login = {
  input: { pin: string; next?: string | null }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

/** auth.logout — end this session. Auth: organiser.
 *  Used by: /admin/account ("Sign out of this phone")
 *  Reference: src/app/login/actions.ts logout(), src/lib/session.ts
 *    destroySession()
 *  Notes: deletes the session row and clears the cookie. The client then goes
 *    to /login. Never fails; a call with no session still returns {ok:true}. */
export type Auth_logout = {
  input: Record<string, never>
  output: { ok: true }
}

/** auth.me — who is signed in. Auth: organiser.
 *  Used by: /admin (layout — the initials button), /admin/account
 *  Reference: src/lib/session.ts getSessionUser(), src/lib/auth.ts requireUser()
 *  Notes: 401 with no session, an expired one, or an account that has been
 *    deactivated or deleted — sessions are DB-backed exactly so that takes
 *    effect at once. Sliding refresh: past half the 14-day TTL the session is
 *    extended, so an all-day organiser is never signed out mid-match.
 *    `mustChangePin` true means every screen except /admin/account is closed
 *    to them; the client redirects to /admin/account?first=1. */
export type Auth_me = {
  input: Record<string, never>
  output: {
    id: string
    name: string
    role: Role
    mustChangePin: boolean
  }
}

// ═══════════════════════════ organisers ═══════════════════════════

/** organisers.listOrganisers — the venue's organisers, for the owner. Auth: owner.
 *  Used by: /admin/account (the Organisers panel)
 *  Reference: src/server/organisers.ts listOrganisers()
 *  Notes: active organisers only, oldest first (creation order). The screen
 *    prints "you · venue owner" for the row whose id matches `auth.me`, else
 *    "last signed in <date>" or "has not signed in yet". Not called at all
 *    while the signed-in organiser still holds a temporary PIN. The reference
 *    also returns `role`; no screen reads it. */
export type Organisers_listOrganisers = {
  input: Record<string, never>
  output: Array<{
    id: string
    name: string
    /** ISO date-time, or null when they have never signed in. */
    lastLoginAt: string | null
  }>
}

/** organisers.addOrganiser — a second pair of hands, with a temporary PIN. Auth: owner.
 *  Used by: /admin/account (the "Add an organiser — their name" row)
 *  Reference: src/app/admin/account/actions.ts addOrganiserAction(),
 *    src/server/organisers.ts addOrganiser()
 *  Notes: `name` is the FormData field. The PIN comes back in this response
 *    and NOWHERE else — never in a URL, which would put it in browser history
 *    and in the host's logs. It is one of the fixed temporary PINs, and the
 *    new organiser must replace it on first sign-in before anything else
 *    opens. Refuses an empty or absurd name, and refuses when every temporary
 *    PIN is already spoken for. The reference also returns the new user's id;
 *    no screen reads it. */
export type Organisers_addOrganiser = {
  input: { name: string }
  output: { ok: true; name: string; pin: string } | { ok: false; error: string }
}

/** organisers.removeOrganiser — switch an organiser off. Auth: owner.
 *  Used by: /admin/account (Remove, behind a confirm)
 *  Reference: src/app/admin/account/actions.ts removeOrganiserAction(),
 *    src/server/organisers.ts removeOrganiser()
 *  Notes: off, not deleted — their name stays on everything they did, and
 *    their sessions are revoked so the PIN stops working straight away.
 *    Refuses removing yourself and refuses removing the last owner. On success
 *    the reference redirects to /admin/account?note=…; here the client just
 *    shows `note` as a done Notice and reloads the list.
 *    note === "Removed. Their PIN no longer works." */
export type Organisers_removeOrganiser = {
  input: { userId: string }
  output: { ok: true; note: string } | { ok: false; error: string }
}

/** organisers.changePin — choose your own PIN. Auth: organiser.
 *  Used by: /admin/account (both the forced first-run form and the normal one)
 *  Reference: src/app/admin/account/actions.ts changePin(),
 *    src/server/organisers.ts setPin()
 *  Notes: FormData fields `current`, `next`, `confirm` — all six digits; the
 *    inputs carry ids #current, #next, #confirm. Refusals, in order:
 *    "Type your current PIN — six digits." / "The new PIN needs to be six
 *    digits." / "Not that one — six of the same digit or a run like 123456 is
 *    the first thing anyone tries." / "The two new PINs don't match." /
 *    "Your current PIN is wrong." / "Another organiser already uses that PIN.
 *    Pick a different one." Rate-limited per user, five tries in fifteen
 *    minutes, because both "your current PIN is wrong" and "another organiser
 *    uses that one" are answers a patient guesser could learn from. On
 *    success every other device is signed out and THIS one is signed back in
 *    (a fresh cookie), `mustChangePin` becomes false, and redirect is
 *    "/admin". */
export type Organisers_changePin = {
  input: { current: string; next: string; confirm: string }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

// ═══════════════════════════════ venue ═══════════════════════════════

/** venue.venueCourts — every court at the venue, in order. Auth: organiser.
 *  Used by: /admin/courts
 *  Reference: src/server/venue.ts venueCourts()
 *  Notes: active courts only, ordered by sortOrder. `heldBy` is the names of
 *    the tournaments from today on that are counting on this court; empty
 *    means "Free" and only then does the screen offer "Take it out". */
export type Venue_venueCourts = {
  input: Record<string, never>
  output: Array<{
    id: string
    name: string
    colorKey: string
    /** Tournament names, e.g. ["Men's Doubles — September"]. */
    heldBy: string[]
  }>
}

/** venue.addCourt — put a court on the venue. Auth: organiser.
 *  Used by: /admin/courts (input[aria-label="Add a court"] + Add)
 *  Reference: src/app/admin/courts/actions.ts addCourtAction(),
 *    src/server/venue.ts addCourt()
 *  Notes: `name` is the FormData field, trimmed, max 40 characters. Refuses
 *    an empty name with 'Give the court a name — "Court 5", or whatever it is
 *    called.' and a duplicate with "There is already a <name>."  A court that
 *    was taken out and is added again by the same name comes back with its
 *    history rather than as a new row. The new court gets the next sortOrder
 *    and the next colorKey in the palette rotation.
 *    note === "<name> is in." */
export type Venue_addCourt = {
  input: { name: string }
  output: { ok: true; note: string } | { ok: false; error: string }
}

/** venue.renameCourt — rename a court. Auth: organiser.
 *  Used by: /admin/courts (one form per row)
 *  Reference: src/app/admin/courts/actions.ts renameCourtAction(),
 *    src/server/venue.ts renameCourt()
 *  Notes: refuses an empty name with "A court needs a name." and a clash with
 *    "There is already a <name>." The name changes on the board, the public
 *    page and every past result at once — the court is the row, not its name.
 *    note === "Renamed." */
export type Venue_renameCourt = {
  input: { courtId: string; name: string }
  output: { ok: true; note: string } | { ok: false; error: string }
}

/** venue.removeCourt — take a court out of the venue. Auth: organiser.
 *  Used by: /admin/courts (Take it out, behind a confirm)
 *  Reference: src/app/admin/courts/actions.ts removeCourtAction(),
 *    src/server/venue.ts removeCourt()
 *  Notes: soft — `active` goes false and everything played on it stays on the
 *    record. Refused while a match is on it ("There is a match on it right
 *    now."), while any tournament from today on holds it ("<name> belongs to
 *    <tournaments>. Take it off there first, under Schedule & courts."), and
 *    when it is the last one ("A venue needs at least one court.").
 *    note === "Taken out. Add it again any time and it comes back with its
 *    history." */
export type Venue_removeCourt = {
  input: { courtId: string }
  output: { ok: true; note: string } | { ok: false; error: string }
}

// ═══════════════════════════════ events ═══════════════════════════════

/** events.dashboard — everything on today, coming up, and finished. Auth: organiser.
 *  Used by: /admin
 *  Reference: src/server/events.ts dashboard()
 *  Notes: at most 40 tournaments, newest day first. Bucketing: `completed`
 *    goes to `finished`; a tournament whose day is today, or whose status is
 *    `live` whatever the day, goes to `today`; a later day goes to
 *    `upcoming`, sorted soonest first; a past day that was never closed off
 *    falls into `finished`. `winnerName` is set only for a finished
 *    tournament — the winner of its last knockout match, or, where the format
 *    is "everyone plays everyone", the top of its final table.
 *    `registrationOpen` is `status !== 'completed' && registrationClosedAt is
 *    null`. `format` is the tournament's finalsStage. `category` is
 *    categoryName(gender, discipline) — the screen drops it when the name
 *    already contains it. `teams` counts pairs that have not withdrawn.
 *    `courts` is in venue order. */
export type Events_dashboard = {
  input: Record<string, never>
  output: {
    today: Events_DashboardRow[]
    upcoming: Events_DashboardRow[]
    finished: Events_DashboardRow[]
  }
}

/** One card on /admin. Shared by the three buckets of events.dashboard. */
export type Events_DashboardRow = {
  id: string
  slug: string
  name: string
  /** ISO date, "YYYY-MM-DD" — the reference's startDate. */
  day: string
  status: TournamentStatus
  /** "Men's Doubles" — derived from gender + discipline. */
  category: string
  discipline: Discipline
  format: FinalsStage
  players: number
  teams: number
  courts: Court[]
  matchesTotal: number
  matchesPlayed: number
  matchesLive: number
  registrationOpen: boolean
  pendingSignups: number
  winnerName: string | null
}

/** events.courtCalendar — every court, and who holds which on which day. Auth: organiser.
 *  Used by: /admin/new (the court chips; the picked day filters them)
 *  Reference: src/server/events.ts courtCalendar()
 *  Notes: for the create form, which has no tournament yet. `held` covers
 *    from today on. The form greys a court whose `dayKey` matches the picked
 *    date and names who holds it; the server re-checks on submit, so the
 *    calendar going stale is a nuisance, not a hole. `dayKey` is
 *    "YYYY-MM-DD". The reference also returns the holder's slug; the form
 *    does not read it. */
export type Events_courtCalendar = {
  input: Record<string, never>
  output: {
    courts: Court[]
    held: Array<{
      courtId: string
      /** "YYYY-MM-DD" — the venue day this court is spoken for. */
      dayKey: string
      /** The tournament that holds it that day. */
      name: string
    }>
  }
}

/** events.createEvent — make a tournament, its courts and its sign-up link. Auth: organiser.
 *  Used by: /admin/new (Create · opens sign-ups)
 *  Reference: src/app/admin/new/actions.ts createTournamentAction(),
 *    src/server/events.ts createEvent()
 *  Notes: FormData field names, so `format` not `finalsStage`, and `courts`
 *    not `courtIds`. `date` is "YYYY-MM-DD" at the venue and becomes 08:00
 *    IST that morning. Validation, in this order, each message verbatim:
 *    "Give it a name — you can change it later." / "Pick the day it is on." /
 *    "That day has already gone." (date before today at the venue) /
 *    "Pick a category." / "Singles or doubles?" / "Pick a format."
 *    The tournament is created in status `setup` with sign-ups open. If a
 *    picked court turns out to belong to another tournament that day, the
 *    tournament is still made — better than the reverse — and the redirect
 *    carries the refusal: `/admin/t/<slug>?courts=<urlencoded message>`,
 *    still ok:true. Otherwise the redirect is `/admin/t/<slug>`. */
export type Events_createEvent = {
  input: {
    name: string
    /** "YYYY-MM-DD" at the venue. */
    date: string
    gender: Gender
    discipline: Discipline
    format: FinalsStage
    /** Court ids, in the order they were picked. May be empty. */
    courts: string[]
  }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

/** events.hub — one tournament's own page, in one call. Auth: organiser.
 *  Used by: /admin/t/[slug] (the whole page), /admin/t/[slug]/schedule
 *  Reference: src/server/events.ts hub()
 *  Notes: 404 when the slug is unknown or the tournament is deleted. Before
 *    anything is counted, and only while status is `setup`, this settles what
 *    can be settled without the organiser — mutual pairs, and singles' teams
 *    of one — exactly as the reference pages do by calling
 *    `teams.settleTeams` on the way in; without it the Teams step reads
 *    "0 of 4 pairs made" for a list where two pairs have already named each
 *    other.
 *    `phase`: completed → 'finished', live → 'running', else 'setup'.
 *    `teamsNeeded` = floor(players / (doubles ? 2 : 1)).
 *    `unpaired` = players who are in no pair.
 *    The four steps are always all four, in this order, with these exact
 *    titles and hrefs; the SCREEN hides the `teams` step for singles.
 *      registration  "Registration"  → /admin/t/<slug>/registration
 *        detail "N players in · link is open|sign-ups closed[ · N possible
 *               duplicate(s)]",  done once players >= 2 * teamSize
 *      teams         "Teams" ("Players" for singles) → …/teams
 *        detail singles: "N in the draw"; doubles: "Once players are in" when
 *               teamsNeeded is 0, else "M of N pairs made[ · K player(s)
 *               still to pair]"; done for singles when registration is done,
 *               for doubles when teamsMade >= 2 and unpaired is 0
 *      schedule      "Schedule & courts" → …/schedule
 *        detail "<court names>|no courts yet · N matches|schedule not made
 *               yet",  done when matchesTotal > 0 and there is a court
 *      start         "Start" → …/schedule
 *        detail "Everything is ready" | "Once the schedule is made";
 *               done once phase is not 'setup'
 *    A step is 'current' when the one before it is done and it is not;
 *    'todo' otherwise. The Start button shows when every step but `start` is
 *    done. */
export type Events_hub = {
  input: { slug: string }
  output: {
    tournament: {
      id: string
      slug: string
      name: string
      /** ISO date, "YYYY-MM-DD". */
      day: string
      status: TournamentStatus
      gender: Gender
      discipline: Discipline
      finalsStage: FinalsStage
      /** How many go through to the finals; 0 when everyone just plays everyone. */
      advancePerGroup: number
      /** Best of, and the target — see the migration note at the top. */
      bestOf: number
      pointsToWin: number
      /** ISO date-time, or null when sign-ups are open. */
      registrationClosedAt: string | null
      /** ISO date-time while the day is stopped, else null. */
      pausedAt: string | null
      pauseNote: string | null
      /** ISO date-time — the "finished <time>" line on a completed hub. */
      updatedAt: string
    }
    courts: Court[]
    players: number
    teamsMade: number
    teamsNeeded: number
    unpaired: number
    matchesTotal: number
    matchesPlayed: number
    matchesLive: number
    pendingSignups: number
    steps: Array<{
      key: 'registration' | 'teams' | 'schedule' | 'start'
      title: string
      detail: string
      state: 'done' | 'current' | 'todo'
      href: string
    }>
    phase: 'setup' | 'running' | 'finished'
  }
}

/** events.courtOptions — every venue court, with who holds it that day. Auth: organiser.
 *  Used by: /admin/t/[slug]/schedule (the court chips)
 *  Reference: src/server/events.ts courtOptions()
 *  Notes: venue order. A court another tournament holds on THIS tournament's
 *    day is shown, named and not pickable — to use it the organiser takes it
 *    off the other tournament first. No lending. `mine` marks the ones this
 *    tournament already holds; the checkbox is pre-checked from it. The
 *    reference's `takenBy` also carries the holder's id and slug; the screen
 *    reads only the name. */
export type Events_courtOptions = {
  input: { tournamentId: string }
  output: Array<{
    id: string
    name: string
    colorKey: string
    /** Set when another tournament holds it that day. */
    takenBy: { name: string } | null
    /** This tournament holds it. */
    mine: boolean
  }>
}

/** events.assignCourts — set a tournament's courts to exactly this list. Auth: organiser.
 *  Used by: /admin/t/[slug]/schedule (Save courts), /admin/live (Add <court>
 *    to <tournament> on an unassigned court card)
 *  Reference: src/app/admin/t/[slug]/schedule/actions.ts setCourtsAction(),
 *    src/app/admin/live/actions.ts addCourtFromBoard(),
 *    src/server/events.ts assignCourts()
 *  Notes: `courtIds` REPLACES the set — a court missing from the list is
 *    given up. The live board's button therefore sends
 *    `[...events.myCourts, courtId]`, never just the one. Refuses a court that
 *    is not at this venue ("That court is not at this venue.") and one
 *    another tournament holds that day ("<court> belongs to <tournament> that
 *    day. Take it off there first."). Refuses to drop a court that has a
 *    match on it right now: "There is a match on <court> right now. Let it
 *    finish, then take the court off." An empty list is allowed before the
 *    start. `count` is how many courts the tournament ends up with. On
 *    success the Go side flows the tournament, so a court that was just added
 *    gets the next match at once. */
export type Events_assignCourts = {
  input: { tournamentId: string; courtIds: string[] }
  output: { ok: true; count: number } | { ok: false; error: string }
}

/** events.myCourts — the courts this tournament holds, in venue order. Auth: organiser.
 *  Used by: /admin/t/[slug]/results, /admin/t/[slug]/more (shorten, delete),
 *    /admin/live (before events.assignCourts, for the "Add a court" button)
 *  Reference: src/server/events.ts myCourts()
 *  Notes: empty before any court is picked. */
export type Events_myCourts = {
  input: { tournamentId: string }
  output: Court[]
}

/** events.closeRegistration — stop the sign-up link taking names. Auth: organiser.
 *  Used by: /admin/t/[slug]/registration (Close sign-ups, behind a confirm)
 *  Reference: src/app/admin/t/[slug]/registration/actions.ts closeSignups(),
 *    src/server/events.ts closeRegistration()
 *  Notes: sets registrationClosedAt. Everyone already on the list stays, and
 *    the organiser can still add and remove people by hand. A player opening
 *    the link then sees "Sign-ups have closed — ask the organiser."
 *    Idempotent. */
export type Events_closeRegistration = {
  input: { tournamentId: string }
  output: { ok: true }
}

/** events.reopenRegistration — let the link take names again. Auth: organiser.
 *  Used by: /admin/t/[slug]/registration (Reopen sign-ups)
 *  Reference: src/app/admin/t/[slug]/registration/actions.ts reopenSignups(),
 *    src/server/events.ts reopenRegistration()
 *  Notes: clears registrationClosedAt. Refused once the tournament has
 *    started: "The tournament has started, so sign-ups stay closed." */
export type Events_reopenRegistration = {
  input: { tournamentId: string }
  output: { ok: true } | { ok: false; error: string }
}

/** events.startEvent — start the day. Auth: organiser.
 *  Used by: /admin/t/[slug] (Start the tournament), /admin/t/[slug]/schedule
 *  Reference: src/app/admin/t/[slug]/hub-actions.ts startEventAction(),
 *    src/server/events.ts startEvent()
 *  Notes: FormData carries `slug`; the client sends the tournament id it
 *    already has. Refuses with "Make the schedule first." when there are no
 *    matches and "Give it at least one court first." when there are no
 *    courts. On success: status → live, sign-ups close (the draw is made and
 *    a new name would have nowhere to go), the first matches flow onto the
 *    courts, and redirect is "/admin/live". On refusal the reference sends
 *    the organiser back to /admin/t/<slug>?err=…; here the screen prints
 *    `error` in the "Not done" Notice. */
export type Events_startEvent = {
  input: { tournamentId: string }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

/** events.finishEvent — everything is played; close it off. Auth: organiser.
 *  Used by: /admin/t/[slug] ("Finish the tournament"), /admin/live
 *    ("Finish <name>" at the top, once played === total)
 *  Reference: src/app/admin/t/[slug]/hub-actions.ts finishEventAction(),
 *    src/server/events.ts finishEvent()
 *  Notes: refuses while anything is outstanding: "N match has|matches have no
 *    result yet." On success: status → completed, the winner and runner-up
 *    are recorded, the courts come free for the day, and redirect is
 *    "/admin/t/<slug>" — from the live board too. */
export type Events_finishEvent = {
  input: { tournamentId: string }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

/** events.deleteEvent — take a tournament off every list. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=delete (Yes, delete it)
 *  Reference: src/app/admin/t/[slug]/actions.ts deleteEventAction(),
 *    src/server/events.ts deleteEvent()
 *  Notes: soft — the row keeps `deletedAt` and everything under it stays for
 *    the record, but it leaves every list and its public page stops
 *    answering (404). Its `tournament_courts` rows are HARD deleted, because
 *    the one-court-per-tournament-per-day index would otherwise keep courts
 *    held by something nobody can see. Refused while a match is on court:
 *    "There is a match on <court> right now. Let it finish, or take it off
 *    court, then delete." — those players are standing on it. On success
 *    redirect is "/admin". */
export type Events_deleteEvent = {
  input: { tournamentId: string }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

// ═══════════════════════════ tournaments ═══════════════════════════

/** tournaments.getTournamentBySlug — the tournament behind a URL. Auth: organiser.
 *  Used by: /admin/t/[slug]/registration, …/teams, …/teams/pair/[playerId],
 *    …/schedule, …/results, …/more
 *  Reference: src/server/tournaments.ts getTournamentBySlug() plus
 *    src/server/events.ts primaryCategory(), which this absorbs
 *  Notes: 404 when the slug is unknown or deleted. This is the only place a
 *    screen turns a slug into an id; every write RPC then takes the id.
 *    The port has no categories table, so the fields the reference read off
 *    `primaryCategory` — discipline, gender, finalsStage, bestOf,
 *    pointsToWin, advancePerGroup — are here, and `id` is the tournament id
 *    wherever the reference passed a `categoryId`.
 *    Sign-ups are closed when `registrationClosedAt` is non-null OR status is
 *    not 'setup' (the reference's `signupsClosed`, a pure helper on the web
 *    side). */
export type Tournaments_getTournamentBySlug = {
  input: { slug: string }
  output: {
    id: string
    slug: string
    name: string
    /** ISO date, "YYYY-MM-DD". */
    day: string
    status: TournamentStatus
    gender: Gender
    discipline: Discipline
    finalsStage: FinalsStage
    advancePerGroup: number
    bestOf: number
    pointsToWin: number
    /** ISO date-time, or null. */
    registrationClosedAt: string | null
    /** ISO date-time while the day is stopped, else null. */
    pausedAt: string | null
    pauseNote: string | null
    /** ISO date-time. */
    updatedAt: string
  }
}

/** tournaments.listMatches — every match, in play order. Auth: organiser.
 *  Used by: /admin/t/[slug] (table, played list, remaining), …/results,
 *    …/schedule (the order of play), …/more (fix a score, shorten, delete)
 *  Reference: src/server/tournaments.ts listMatches()
 *  Notes: ordered by roundIndex then seq — the order of play, which is what
 *    every screen numbers 1..N. Includes cancelled and voided matches; the
 *    screens filter. A match is "played" when resultState is 'final'.
 *    `categoryId` in the reference is gone: a match belongs to the
 *    tournament. `scoreSummary` is dropped; per-game scores come from
 *    `tournaments.gamesByMatch`. `startedAt` is when it went on court, and is
 *    what the played list sorts by, newest first. */
export type Tournaments_listMatches = {
  input: { tournamentId: string }
  output: Array<{
    id: string
    stage: Stage
    roundIndex: number
    /** "Round 3", "Semi-final", "Final" — null for a plain league match. */
    roundName: string | null
    seq: number
    status: MatchStatus
    resultState: ResultState
    resultType: ResultType
    teamAId: string | null
    teamBId: string | null
    winnerTeamId: string | null
    gamesWonA: number
    gamesWonB: number
    courtId: string | null
    /** ISO date-time, or null. */
    startedAt: string | null
  }>
}

/** tournaments.listTeams — the pairs in this tournament. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=withdraw (the list to tap)
 *  Reference: src/server/tournaments.ts listTeams()
 *  Notes: creation order — which is the order the pairs were made in, and the
 *    last-resort dead-heat order. Withdrawn pairs stay in the list with
 *    status 'withdrawn' so they can be put back. `seed` and `groupId` are
 *    dropped: no screen reads them. */
export type Tournaments_listTeams = {
  input: { tournamentId: string }
  output: Array<{
    id: string
    /** "Ravi Kumar / Priya S", or one name in singles. */
    name: string
    status: 'active' | 'withdrawn'
  }>
}

/** tournaments.listTournamentPlayers — the roster, as ids and names. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=swap (who can step in),
 *    /admin/t/[slug]/more?do=delete (how many go with it)
 *  Reference: src/server/tournaments.ts listTournamentPlayers()
 *  Notes: sign-up order. gender, skill, dupr and paid are gone from the port.
 *    So is the reference's per-player `withdrawn`: in v4 a withdrawal is a
 *    property of the PAIR (`teams.status`), so the swap screen filters by
 *    "already in a pair" alone. */
export type Tournaments_listTournamentPlayers = {
  input: { tournamentId: string }
  output: Array<{ id: string; name: string }>
}

/** tournaments.standingsFor — the table, straight from the ledger. Auth: organiser.
 *  Used by: /admin/t/[slug] (the Table / Final table)
 *  Reference: src/server/tournaments.ts standingsFor()
 *  Notes: takes the tournament id — the reference took a categoryId.
 *    `rows` is ORDERED: wins first, then total points scored, then the
 *    tiebreaks, and last of all the order the pairs were made in. Position is
 *    the array index, not a field. `reason` is set once the table is ordered
 *    and only where wins and points did not settle it, e.g. "2nd on
 *    head-to-head vs Arun / Deepa" — the screen suppresses reasons that only
 *    repeat the two visible columns, and turns "drawn…" into "level so far"
 *    or, once every league match is in, "level on everything — kept in the
 *    order the pairs were made". Voided matches count for nobody; a walkover
 *    counts as a win and adds no points, so a pair who go home at lunch
 *    cannot decide the pool on point difference. A withdrawn pair keeps its
 *    row for the record: `teams` carries the status so the screen can grey it
 *    and draw the cut line around it. The reference also returns the
 *    tiebreak `rule`; no screen reads it. */
export type Tournaments_standingsFor = {
  input: { tournamentId: string }
  output: {
    rows: Array<{
      teamId: string
      won: number
      /** Total points scored — the venue's headline tiebreak. */
      pointsFor: number
      /** Why this row sits here, when wins and points did not decide it. */
      reason: string | null
    }>
    teams: Array<{ id: string; status: 'active' | 'withdrawn' }>
  }
}

/** tournaments.teamNameMap — team id → shown name. Auth: organiser.
 *  Used by: /admin/t/[slug], …/results, …/schedule, …/more
 *  Reference: src/server/tournaments.ts teamNameMap()
 *  Notes: a JSON object, not an array of pairs. Every team in the tournament,
 *    withdrawn ones included. The screens print "—" for an id that is not in
 *    it. Kept separate from listMatches because the same map serves the
 *    table, the order of play and the played list on one screen. */
export type Tournaments_teamNameMap = {
  input: { tournamentId: string }
  output: Record<string, string>
}

/** tournaments.gamesByMatch — match id → its game scores. Auth: organiser.
 *  Used by: /admin/t/[slug] (the "11–9, 8–11, 11–6" line), …/results, …/more
 *  Reference: src/server/tournaments.ts gamesByMatch()
 *  Notes: a JSON object; each value is ordered by gameNo and is always from
 *    A's side, so a screen showing the winner first flips them itself. A
 *    match with no games — a bye, or one nobody has played — is simply
 *    absent. A walkover HAS generated games in the ledger; every screen
 *    prints the word "Walkover" instead of the numbers, because 11–0, 11–0
 *    reads as a thrashing nobody played. */
export type Tournaments_gamesByMatch = {
  input: { tournamentId: string }
  output: Record<string, Array<{ scoreA: number; scoreB: number }>>
}

/** tournaments.generateDraw — make (or remake) the order of play. Auth: organiser.
 *  Used by: /admin/t/[slug]/schedule (Make the schedule / Make it again)
 *  Reference: src/app/admin/t/[slug]/schedule/actions.ts makeScheduleAction(),
 *    src/server/tournaments.ts generateDrawForCategory() — the reference took
 *    a categoryId
 *  Notes: settles mutual pairs and singles' teams of one first, so a
 *    tournament whose Teams screen was never opened still has something to
 *    draw from. Refuses once ANY match has a result: "Results are already in
 *    — the schedule can't be remade now." Refuses with fewer than two teams:
 *    "You need at least two pairs before there is a schedule to make."
 *    Deletes the old matches and writes the new ones in one transaction — a
 *    half-written draw is a state no screen can explain. The shape follows
 *    finalsStage: everyone plays everyone; plus a final between 1st and 2nd;
 *    plus semis (1st v 4th, 2nd v 3rd) and a final of the two winners. Eight
 *    teams or more are split into pools. `count` is how many matches exist
 *    afterwards. */
export type Tournaments_generateDraw = {
  input: { tournamentId: string }
  output: { ok: true; count: number } | { ok: false; error: string }
}

// ═══════════════════════════════ teams ═══════════════════════════════

/** teams.teamBoard — the whole Teams screen in one call. Auth: organiser.
 *  Used by: /admin/t/[slug]/teams, /admin/t/[slug]/teams/pair/[playerId]
 *  Reference: src/server/teams.ts teamBoard() (which calls settleTeams)
 *  Notes: settles what can be settled without the organiser first — two
 *    people who named each other are a pair the moment the screen loads,
 *    singles get a team of one each, and a pair broken by someone leaving
 *    comes apart. Idempotent, and a no-op once the schedule exists.
 *    `needed` is how many pairs the roster makes (in singles, how many
 *    players). `locked` means the schedule exists and nothing on this screen
 *    can change any more; the screen then prints, verbatim,
 *    "The tournament has started. Changing a pair is under More."
 *    `how` is derived, not stored: 'mutual' when both members named each
 *    other — those rows carry no Split. `unpaired` is in sign-up order.
 *    `note` is the grey phrase on the right — "Suresh named Ganesh",
 *    "not mutual" — or null when there is nothing to say.
 *    The reference's `Unpaired.wishPlayerId` and `.mutual` are dropped; no
 *    screen reads them. */
export type Teams_teamBoard = {
  input: { tournamentId: string }
  output: {
    discipline: Discipline
    pairs: Array<{
      teamId: string
      name: string
      players: Array<{ id: string; name: string }>
      how: 'mutual' | 'organiser'
    }>
    unpaired: Array<{
      id: string
      name: string
      /** The partner they asked for, as typed; null when they named nobody. */
      wishText: string | null
      /** That wish resolved to a roster player who is still in, else null. */
      wishPlayerName: string | null
      note: string | null
    }>
    needed: number
    locked: boolean
  }
}

/** teams.pairWith — put two people from the pile together. Auth: organiser.
 *  Used by: /admin/t/[slug]/teams/pair/[playerId] (tap a name)
 *  Reference: src/app/admin/t/[slug]/teams/actions.ts pairWithAction(),
 *    src/server/teams.ts pairWith()
 *  Notes: FormData fields are `player` and `partner`; named here. Refuses:
 *    "Singles has no pairs to make." / the locked message once the schedule
 *    exists / "Pick two different people." / "One of them is no longer on the
 *    list." / "<name> is in a pair already. Split it first."
 *    On success the screen goes back to /admin/t/<slug>/teams. */
export type Teams_pairWith = {
  input: { tournamentId: string; playerA: string; playerB: string }
  output: { ok: true; teamId: string } | { ok: false; error: string }
}

/** teams.splitTeam — undo a pair. Auth: organiser.
 *  Used by: /admin/t/[slug]/teams (Split, inside the opened row)
 *  Reference: src/app/admin/t/[slug]/teams/actions.ts splitTeamAction(),
 *    src/server/teams.ts splitTeam()
 *  Notes: FormData field is `team`. Both people go back to the pile — but a
 *    MUTUAL pair re-forms on the next load, which is why the screen offers
 *    Split only on pairs the organiser made. Refuses with the locked message
 *    once the schedule exists, and "That pair is already gone." */
export type Teams_splitTeam = {
  input: { tournamentId: string; teamId: string }
  output: { ok: true } | { ok: false; error: string }
}

/** teams.pairRestRandomly — pair whoever is left, at random. Auth: organiser.
 *  Used by: /admin/t/[slug]/teams (Pair the rest at random, behind a confirm)
 *  Reference: src/app/admin/t/[slug]/teams/actions.ts pairRestAction(),
 *    src/server/teams.ts pairRestRandomly()
 *  Notes: uses the tournament's own stored seed, so the same pile always
 *    comes out the same way and "why am I with him" has one answer. An odd
 *    pile leaves one person out and says who, in `oddOut`. Refuses with the
 *    locked message, "Everyone is paired.", and "Only <name> is left — there
 *    is nobody to pair them with." */
export type Teams_pairRestRandomly = {
  input: { tournamentId: string }
  output:
    | { ok: true; made: number; oddOut: { id: string; name: string } | null }
    | { ok: false; error: string }
}

// ══════════════════════════ registration ══════════════════════════

/** registration.ensureRegistrationLink — the link for the group chat. Auth: organiser.
 *  Used by: /admin/t/[slug]/registration (the Sign-up link card)
 *  Reference: src/server/registration.ts ensureRegistrationLink()
 *  Notes: made the first time it is asked for, then stable — only the hash is
 *    stored. The client builds the address itself:
 *    `${location.origin}/r/${token}`; the reference did it from the request
 *    host for the same reason (the origin the organiser is looking at is the
 *    only one the app can vouch for). Returns null once the tournament's day
 *    has ended in the venue's timezone — the screen then shows "The day has
 *    passed — the sign-up link stopped working at the end of <date>" instead
 *    of a link. Closing sign-ups does NOT revoke the token: the link keeps
 *    resolving and says sign-ups have closed. */
export type Registration_ensureRegistrationLink = {
  input: { tournamentId: string }
  output: { token: string } | null
}

/** registration.listRoster — who is in, in the order they arrived. Auth: organiser.
 *  Used by: /admin/t/[slug]/registration
 *  Reference: src/server/registration.ts listRoster()
 *  Notes: arrival order. `duplicateOf` is somebody already on the list who
 *    looks like the same person — worked out the same way it was at sign-up,
 *    so the organiser's answer is about two names they can see. The SCREEN
 *    floats flagged rows to the top. `partner` is the roster player their
 *    wish resolved to, or the name exactly as they typed it, or null; it is
 *    shown only for doubles. `source` decides "via link" or "added by you".
 *    Never returns a phone number. The reference also returns
 *    `partnerOnList` and `registeredAt`; no screen reads them. */
export type Registration_listRoster = {
  input: { tournamentId: string }
  output: Array<{
    playerId: string
    name: string
    source: 'link' | 'hand'
    partner: string | null
    /** Somebody already on the list who looks like the same person. */
    duplicateOf: { playerId: string; name: string } | null
  }>
}

/** registration.addByHand — add one player, or paste the whole group list. Auth: organiser.
 *  Used by: /admin/t/[slug]/registration (textarea[name=text] + Add)
 *  Reference: src/app/admin/t/[slug]/registration/actions.ts addByHand(),
 *    src/server/registration.ts addPlayerByHand() / addPlayersByHand()
 *  Notes: the FormData field is `text`. ONE line goes through
 *    `addPlayerByHand`, which parses "Name 98400 12345" — the phone is
 *    optional. Text containing a newline goes through `addPlayersByHand`:
 *    numbering, ticks and phone numbers are all fine, and names already on
 *    the list are skipped and counted, not refused, because the paste is last
 *    week's list plus three new people. Refusals: "Put a name in — the phone
 *    number is optional." / "<name> is already on the list." (a single add
 *    that duplicates a phone number) / "Everyone in that list is already on
 *    it." (a paste where added === 0). On success `added` is 1 for the single
 *    case; `flagged` names the people who look like somebody already on the
 *    list — they are all ON the list regardless, with a flag for the
 *    organiser to settle. Adding is allowed whether sign-ups are open or
 *    closed, and refused once the tournament is completed. */
export type Registration_addByHand = {
  input: { tournamentId: string; text: string }
  output:
    | { ok: true; added: number; skipped: number; flagged: string[] }
    | { ok: false; error: string }
}

/** registration.removePlayer — take somebody off the list. Auth: organiser.
 *  Used by: /admin/t/[slug]/registration (Remove, behind a confirm)
 *  Reference: src/app/admin/t/[slug]/registration/actions.ts remove(),
 *    src/server/registration.ts removePlayer()
 *  Notes: a pair they are in that has not played is taken apart with them; a
 *    pair that HAS played is not ours to touch from here and the call is
 *    refused, naming what to do. Refuses "They are not on the list any more."
 *    `note` is the sentence the screen prints as a done Notice. */
export type Registration_removePlayer = {
  input: { tournamentId: string; playerId: string }
  output: { ok: true; note: string } | { ok: false; error: string }
}

/** registration.mergePlayers — "Same person". Auth: organiser.
 *  Used by: /admin/t/[slug]/registration (the Same person button on a flagged row)
 *  Reference: src/app/admin/t/[slug]/registration/actions.ts settleDuplicate(),
 *    src/server/registration.ts mergePlayers()
 *  Notes: `keepId` is the EARLIER row (`duplicateOf.playerId`) and `dropId`
 *    is the flagged one (`playerId`). The earlier row stays, the later one
 *    goes, and anything the earlier row lacked — a partner wish, a phone
 *    number — comes across. Anyone who had named the later row now points at
 *    the one that stays. Refuses "One of them is not on the list any more."
 *    and refuses once either of them has played. */
export type Registration_mergePlayers = {
  input: { tournamentId: string; keepId: string; dropId: string }
  output: { ok: true; note: string } | { ok: false; error: string }
}

/** registration.keepBoth — "Different". Auth: organiser.
 *  Used by: /admin/t/[slug]/registration (the Different button on a flagged row)
 *  Reference: src/app/admin/t/[slug]/registration/actions.ts settleDuplicate(),
 *    src/server/registration.ts keepBoth()
 *  Notes: the flag comes off and both stay — two Karthiks in one group is not
 *    unusual and the organiser knows which is which. Idempotent; a row that
 *    was never flagged is a no-op, not an error. */
export type Registration_keepBoth = {
  input: { tournamentId: string; playerId: string }
  output: { ok: true }
}

/** registration.resolveRegistrationToken — what a sign-up link opens. Auth: public.
 *  Used by: /r/[token]
 *  Reference: src/server/registration.ts resolveRegistrationToken()
 *  Notes: 404 for an unknown, revoked, day-has-passed or deleted-tournament
 *    token, and the screen prints "This link doesn't work any more" with
 *    "Sign-ups may have closed, or the organiser has sent a new link. Ask in
 *    the group." Rate-limited on the token prefix, like any capability URL.
 *    `closed` is true when the organiser closed sign-ups OR the tournament
 *    has started; the screen then shows only "Sign-ups have closed — ask the
 *    organiser." and no form. Reads no cookie and returns no phone number.
 *    The page must never be indexed. The reference also returns the
 *    tournament's id and slug; the form carries the token instead, so
 *    nothing on the wire is trusted. */
export type Registration_resolveRegistrationToken = {
  input: { token: string }
  output: {
    tournament: {
      name: string
      /** ISO date, "YYYY-MM-DD". */
      day: string
    }
    discipline: Discipline
    /** The organiser closed sign-ups, or the tournament has started. */
    closed: boolean
  }
}

/** registration.submitRegistration — the public sign-up form. Auth: public.
 *  Used by: /r/[token] (Sign me up)
 *  Reference: src/app/r/[token]/actions.ts signUp(),
 *    src/server/registration.ts submitRegistration()
 *  Notes: everything is re-resolved from the token; the form carries nothing
 *    that is trusted. `deviceId` is a per-browser id the form generates and
 *    keeps in localStorage — matched against /^[A-Za-z0-9_-]{8,64}$/, else
 *    null. It is deliberately NOT a cookie, so the page stays cookie-free.
 *    Straight onto the list unless they are on it already, which is the
 *    common case: people reload, or come back to add a partner. "Already" is
 *    the same phone number, or the same name from the same browser — that
 *    returns {ok:true, alreadyIn:true} and the screen says "You're already on
 *    the list." The same name from a DIFFERENT browser goes on with a
 *    duplicate flag for the organiser. Refusals, verbatim: "This link doesn't
 *    work any more. Ask the organiser." / "Sign-ups have closed — ask the
 *    organiser." / "Put your name in." / "That name is too long." / "That
 *    phone number doesn't look right — ten digits, or leave it blank."
 *    Rate-limited per token prefix and per device. Name and partner are cut
 *    to 200 characters and the phone to 40 before validation. */
export type Registration_submitRegistration = {
  input: {
    token: string
    name: string
    phone: string | null
    /** Doubles only; the form does not show the field for singles. */
    partnerName: string | null
    deviceId: string | null
  }
  output: { ok: true; alreadyIn: boolean } | { ok: false; error: string }
}

// ═══════════════════════════════ board ═══════════════════════════════

/** board.venueBoard — every court at the venue, across every tournament. Auth: organiser.
 *  Used by: /admin/live
 *  Reference: src/server/board.ts venueBoard()
 *  Notes: read-only — the auto-flow runs at the writes, never while a page
 *    renders. Courts are in venue order, one entry each, whoever holds them.
 *    `now` is the server's clock, and the screen dates the page from it.
 *    `liveCount` is every match on a court at the venue.
 *    `wants` is, for a court nobody holds, the running tournament that could
 *    use one (three or more still to play, not paused, and its courts are all
 *    busy) — the card then offers "Add <court> to <categoryName>".
 *    `offer` is the safety net: a free court with a playable match nobody put
 *    on. Two free courts are never offered matches that share a player, and
 *    never the same match twice. When `offer` is set the screen hides the
 *    "Next here" line.
 *    `overrunMinutes` on a live match drives the amber band "On for N min and
 *    no score — did they finish?" and turns "Enter the score" into "Enter it
 *    for them". */
export type Board_venueBoard = {
  input: Record<string, never>
  output: {
    /** ISO date-time — the server's now. */
    now: string
    /** Every tournament on today, running or not, in day order. */
    tournaments: VenueTournament[]
    courts: VenueCourt[]
    liveCount: number
    /** For a court nobody holds: the running tournament that could use it. */
    wants: VenueTournament | null
  }
}

/** board.moveOptions — the Move screen's data. Auth: organiser.
 *  Used by: /admin/live/move/[matchId]
 *  Reference: src/server/board.ts moveOptions()
 *  Notes: 404 when the match does not exist or is not on a court — a match
 *    with nothing to move; the client then goes to /admin/live, which says
 *    where it is. `courts` is the OTHER courts of the SAME tournament, in
 *    venue order — another tournament's court is not on the list at all. A
 *    busy court is shown, greyed and not pickable, with who is on it and for
 *    how long, because a row that is missing says less than a row that is
 *    greyed. `busy.minutes` under 1 is rendered "just started".
 *    `closedReason` is always null in v4 (no court-closure table).
 *    The reference also returns the tournament's id; the client sends the
 *    matchId and courtId, so it is dropped. */
export type Board_moveOptions = {
  input: { matchId: string }
  output: {
    match: {
      id: string
      nameA: string | null
      nameB: string | null
      /** The court it is on now. */
      courtName: string | null
    }
    tournament: {
      slug: string
      /** "Men's Doubles" — every row's meta line starts with it. */
      categoryName: string
    }
    courts: Array<{
      id: string
      name: string
      colorKey: string
      /** Who is on it, and for how long — a busy court is shown, not offered. */
      busy: { nameA: string | null; nameB: string | null; minutes: number } | null
      closedReason: string | null
    }>
  }
}

/** board.moveMatch — move a live match to another of its own courts. Auth: organiser.
 *  Used by: /admin/live/move/[matchId] (tap a free court)
 *  Reference: src/app/admin/live/move/[matchId]/actions.ts moveMatchAction(),
 *    src/server/board.ts moveMatch()
 *  Notes: the clock starts again on the new court — a moved match is a match
 *    that is starting, and a false "on for 52 min" is worse than a lost ten.
 *    Refuses: "That match no longer exists." / "That match isn't on a court."
 *    / "That court no longer exists." / "<court> isn't one of this
 *    tournament's courts — a match only goes on its own tournament's courts."
 *    / "<court> already has a match on it." On success the court it left is
 *    free, so the Go side flows the venue (this tournament first) before
 *    answering, and redirect is "/admin/live". */
export type Board_moveMatch = {
  input: { matchId: string; courtId: string }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

/** board.clearCourt — take a match off court without a result. Auth: organiser.
 *  Used by: /admin/live/move/[matchId] ("Back to the queue")
 *  Reference: src/app/admin/live/move/[matchId]/actions.ts backToQueueAction(),
 *    src/server/board.ts clearCourt()
 *  Notes: only a LIVE match — doing this to a completed one resurrected a
 *    finished match and erased which court it was played on. `later: true`
 *    (what the button sends) means "play it later": the match goes to the
 *    back of the order, and the court it left is filled with the NEXT match,
 *    not this one — so the Go side flows the venue with this match skipped.
 *    Refuses "That match no longer exists." and "That match isn't on a
 *    court." Redirect on success is "/admin/live". */
export type Board_clearCourt = {
  input: { matchId: string; later: boolean }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

/** board.sendToCourt — put an offered match on a free court. Auth: organiser.
 *  Used by: /admin/live (the terracotta "Put <pair> v <pair> on <court>")
 *  Reference: src/app/admin/live/actions.ts putOnCourt(),
 *    src/server/board.ts sendToCourt()
 *  Notes: the safety net. The auto-flow does this itself after every score;
 *    this is for a court that came free by a door the flow does not watch.
 *    The unique index on matches(court_id) where status='live' makes
 *    double-booking structurally impossible; this turns the violation into a
 *    sentence rather than a 500 on tournament morning. Refuses: "That match
 *    no longer exists." / "This match is still waiting on an earlier
 *    result." / "This match already has a result." / "This match is already
 *    on a court." / "That court no longer exists." / "<court> isn't one of
 *    this tournament's courts — a match only goes on its own tournament's
 *    courts." / "<court> already has a match on it." / a player conflict,
 *    which NAMES the player, because "blocked" is not actionable and a name
 *    is — and it counts every live match at the venue, not only this
 *    tournament's: one person can be in Men's and Mixed on the same Sunday
 *    and has one body. On success the Go side flows the tournament, and
 *    redirect is "/admin/live". */
export type Board_sendToCourt = {
  input: { matchId: string; courtId: string }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

// ══════════════════════════════ scoring ══════════════════════════════

/** scoring.getMatchForScoring — everything the score screen needs. Auth: organiser.
 *  Used by: /admin/m/[matchId]
 *  Reference: src/server/scoring.ts getMatchForScoring() plus the court
 *    lookup the page does itself
 *  Notes: 404 when the match is unknown OR either side is still unresolved —
 *    a score cannot be entered for "Winner of Semi-final 1".
 *    `courtName` and `courtColorKey` are non-null ONLY while the match is
 *    live: a correction an hour later has no business shouting COURT 1.
 *    `rules` is the tournament's format; v4 is best of 3 to 11, win by 2, no
 *    cap, and `shortenFormat` may have changed bestOf and pointsToWin.
 *    `games` is the ledger so far, ordered by gameNo, always from A's side.
 *    When `resultState` is not 'none' the screen reads as a CORRECTION: it
 *    shows what it is replacing and will not send without a reason. The label
 *    over that block is "The result is final" for 'final' and "This result
 *    was voided" for 'voided'. The reference's reported/disputed states,
 *    submissions and provisional flag are gone: the organiser is the only
 *    scorer and a score is final the moment it is saved.
 *    "Cancel this match" is offered only while `status` is not 'live'. */
export type Scoring_getMatchForScoring = {
  input: { matchId: string }
  output: {
    match: {
      id: string
      tournamentId: string
      roundName: string | null
      teamAId: string
      teamBId: string
      status: MatchStatus
      resultState: ResultState
      resultType: ResultType
      winnerTeamId: string | null
    }
    /** "Men's Doubles" — the eyebrow over the two names. */
    categoryName: string
    /** Non-null only while the match is live. */
    courtName: string | null
    courtColorKey: string | null
    nameA: string
    nameB: string
    rules: ScoringRules
    games: GameScore[]
  }
}

/** scoring.saveResult — enter a score, or correct one that is already in. Auth: organiser.
 *  Used by: /admin/m/[matchId] (the score entry's submit)
 *  Reference: src/app/admin/m/[matchId]/actions.ts saveResult(),
 *    src/server/scoring.ts submitResult() and adminSetResult()
 *  Notes: TWO different acts wear the same screen. Entering a result nobody
 *    has entered yet is scoring, and it is authoritative — no confirmation
 *    dance. Changing one that is already in is a CORRECTION: `reason` is
 *    required (3 characters or more — "Say what changed — it goes in the log
 *    next to your name."), it is refused while a downstream match has already
 *    started, and the refusal NAMES the blocking match. The server decides
 *    which of the two this is; the client always sends the same shape.
 *    Nothing structural is taken on trust: the winner is DERIVED from the
 *    games, a walkover's scoreline is GENERATED rather than accepted, and
 *    which games sit out of point difference is worked out on the server —
 *    that field decides the venue's headline tiebreak, so a phone must not be
 *    able to set it. For `retired`, send only the games actually PLAYED
 *    (including the part-game, if any); the server fills in the rest.
 *    For `walkover`, send `games: []` and the winner.
 *    On success the court is free, so the Go side flows the venue (this
 *    tournament first) before answering — the next match is on before the
 *    organiser is back on the board. The client then navigates to
 *    "/admin/live". */
export type Scoring_saveResult = {
  input: {
    matchId: string
    games: GameScore[]
    resultType: SubmittableResultType
    winnerTeamId: string | null
    retiredTeamId: string | null
    /** Required, and 3+ characters, when the match already has a result. */
    reason?: string
  }
  output: { ok: true } | { ok: false; error: string }
}

// ═══════════════════════════════ chaos ═══════════════════════════════

/** chaos.withdrawalEffect — what withdrawing a pair will do, before it does it. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=withdraw&team=<id>
 *  Reference: src/server/chaos.ts withdrawalEffect()
 *  Notes: 404 when the team is unknown or not this tournament's. The
 *    organiser is standing in front of the person asking, and "are you sure?"
 *    is not an answer — every number in the confirm comes from here, so it is
 *    the number the write will act on. `blocked` is downstream matches this
 *    cannot touch because they have started; the screen shows the first one's
 *    roundName (or "A match of theirs") and refuses to offer the button. The
 *    reference also returns teamName and categoryName; the screen already has
 *    the name from the list it tapped. */
export type Chaos_withdrawalEffect = {
  input: { tournamentId: string; teamId: string }
  output: {
    /** Matches this pair had already played, which stand. */
    played: number
    /** Matches not yet played, which become walkovers to the other side. */
    toWalkover: number
    /** Matches they were pencilled into, which simply lose their name again. */
    vacates: number
    blocked: Array<{ id: string; roundName: string | null }>
  }
}

/** chaos.withdrawTeam — a pair has pulled out. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=withdraw ("Yes, they're out")
 *  Reference: src/app/admin/t/[slug]/actions.ts withdrawTeamAction(),
 *    src/server/chaos.ts withdrawTeam()
 *  Notes: matches they played stand; matches they had left become walkovers
 *    to the other side — a win that adds no points, so a pair who go home at
 *    lunch cannot decide the pool on point difference for the people still
 *    playing. Refuses "That pair is no longer in the draw." / "They are
 *    already marked as withdrawn." / "<pair> is on court right now. Take it
 *    off court first, or let it finish." — the last one is the refusal an
 *    organiser will actually meet, and the screen offers a link to the live
 *    board with it. Their walkovers can make a later match ready, so the Go
 *    side flows the tournament. Reversible with reinstateTeam.
 *    note === "<pair> are out. N matches become walkovers to the other side."
 *    or "<pair> are out. Nothing they had left changes." */
export type Chaos_withdrawTeam = {
  input: { tournamentId: string; teamId: string }
  output:
    | { ok: true; walkovers: number; note: string }
    | { ok: false; error: string; fix?: 'board' }
}

/** chaos.reinstateTeam — put a withdrawn pair back. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=withdraw ("Put them back")
 *  Reference: src/app/admin/t/[slug]/actions.ts reinstateTeamAction(),
 *    src/server/chaos.ts reinstateTeam()
 *  Notes: their walkovers are UNDONE, not left standing, and those matches go
 *    back in the queue — so the Go side flows the tournament. The matches
 *    they actually played are untouched. Refuses "That pair is no longer in
 *    the draw." and "They are not marked as withdrawn."
 *    note === "<pair> are back in. N walkovers are undone." (the second
 *    sentence is dropped when nothing was undone). */
export type Chaos_reinstateTeam = {
  input: { tournamentId: string; teamId: string }
  output: { ok: true; restored: number; note: string } | { ok: false; error: string }
}

/** chaos.substitutionOptions — who could be swapped out. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=swap
 *  Reference: src/server/chaos.ts substitutionOptions()
 *  Notes: active pairs only, in table order. The screen renders one <select>
 *    of optgroups — the team is the group, its members are the options —
 *    because "Ravi, from a pair Ravi is not in" is a state two selects can
 *    reach and one cannot. Who can step IN is
 *    `tournaments.listTournamentPlayers` minus everybody who appears here.
 *    The reference also returns categoryId and categoryName; neither is read,
 *    and the port has no categories. */
export type Chaos_substitutionOptions = {
  input: { tournamentId: string }
  output: Array<{
    teamId: string
    teamName: string
    members: Array<{ id: string; name: string }>
  }>
}

/** chaos.substitutePlayer — swap one player for another, mid-day. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=swap ("Yes, swap them")
 *  Reference: src/app/admin/t/[slug]/actions.ts substituteAction(),
 *    src/server/chaos.ts substitutePlayer()
 *  Notes: the FormData `out` field is "<teamId>:<playerId>"; split here into
 *    two fields. The team keeps its identity: its results, its place in the
 *    table and its position in the draw all stand. Only the name changes, and
 *    it changes EVERYWHERE at once — a pair called "Ravi / Priya" on the
 *    board and "Ravi / Meera" on the public page is how an argument starts.
 *    Refuses: "Pick who is coming out and who is going in." / "That pair is
 *    no longer in the draw." / "That player is not in this pair." / "They are
 *    already in this pair." / "That player is not on the roster." (with
 *    fix:'signups', so the screen offers "Add the player first") /
 *    "Whoever is stepping in has to be on the roster first." / "<name> is
 *    already playing for <pair>." / "<name> is on <court> right now." /
 *    "That pair is on <court>. Swap them when the match finishes."
 *    note === "<old name> are now <new name>. Their results and their place
 *    in the table stand." */
export type Chaos_substitutePlayer = {
  input: {
    tournamentId: string
    teamId: string
    outPlayerId: string
    inPlayerId: string
  }
  output:
    | { ok: true; name: string; incoming: string; note: string }
    | { ok: false; error: string; fix?: 'signups' | 'board' }
}

/** chaos.pauseDay — stop the clock. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=pause (Pause it)
 *  Reference: src/app/admin/t/[slug]/actions.ts pauseDayAction(),
 *    src/server/chaos.ts pauseDay()
 *  Notes: rain, a missing net, lunch. Matches already on court carry on;
 *    NOTHING new goes on until it starts again, and the public page says why
 *    rather than leaving forty people looking at a board that has not moved.
 *    `note` is the input the screen defaults to "Rain — back shortly"; an
 *    empty note is accepted and stored as "Paused".
 *    Result note === "Paused. The public page says so." */
export type Chaos_pauseDay = {
  input: { tournamentId: string; note: string }
  output: { ok: true; note: string }
}

/** chaos.resumeDay — start again. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=pause ("Start again"), /admin/live
 *    (the "<name> is paused" notice's "Start again")
 *  Reference: src/app/admin/t/[slug]/actions.ts resumeDayAction(),
 *    src/app/admin/live/actions.ts resumeFromBoard(),
 *    src/server/chaos.ts resumeDay()
 *  Notes: clears pausedAt and pauseNote, then flows the next matches onto the
 *    courts that stood empty through the stop. From More the screen stays put
 *    and shows note === "Going again."; from the live board the client
 *    reloads /admin/live. Refuses "That tournament no longer exists." */
export type Chaos_resumeDay = {
  input: { tournamentId: string }
  output: { ok: true; note: string } | { ok: false; error: string }
}

/** chaos.shortenFormat — shorten what is left. Auth: organiser.
 *  Used by: /admin/t/[slug]/more?do=shorten (one confirm per option)
 *  Reference: src/app/admin/t/[slug]/actions.ts shortenFormatAction(),
 *    src/server/chaos.ts shortenFormat() — the reference took a categoryId
 *  Notes: the most-used emergency tool there is, because the sun sets at a
 *    fixed time and a day that started late cannot get the hours back. Only
 *    matches with NO result are touched: rewriting the format of a match
 *    already played would change what its score meant after the fact.
 *    Refuses "A match is best of one or best of three." (bestOf not 1 or 3),
 *    "Games run to between 7 and 21.", and "A match is on court. Change it
 *    when that one finishes." (with fix:'board'). The three shapes the screen
 *    offers, in the order they cost time, are {3,11}, {1,15}, {1,11}, and it
 *    offers only the ones actually shorter than what is being played now.
 *    NEEDS the `best_of` / `points_to_win` columns — see the top of this file.
 *    note === "What is left is now one game to 15." / "…best of 3 to 11." */
export type Chaos_shortenFormat = {
  input: { tournamentId: string; bestOf: number; pointsToWin: number }
  output: { ok: true; note: string } | { ok: false; error: string; fix?: 'board' }
}

/** chaos.voidMatch — cancel a match outright. Auth: organiser.
 *  Used by: /admin/m/[matchId] ("Cancel this match", behind a confirm)
 *  Reference: src/app/admin/m/[matchId]/actions.ts voidThisMatch(),
 *    src/server/chaos.ts voidMatch()
 *  Notes: cancelling is not correcting. The match counts for nobody
 *    afterwards — no winner, no points, in no table and no difference column.
 *    `reason` is required, 3 characters or more: "Say why it is being
 *    cancelled — it goes in the log next to your name." Refuses "That match
 *    no longer exists." / "That match is on court. Take it off court first."
 *    / "<match> was built off this result. Sort that one out first." — that
 *    last sentence is the only thing that tells the organiser what to fix, so
 *    it must reach the screen. Offered only while the match is not live.
 *    On success the client goes back to "/admin/live". */
export type Chaos_voidMatch = {
  input: { matchId: string; reason: string }
  output: { ok: true; redirect: string } | { ok: false; error: string }
}

// ═══════════════════════════════ public ═══════════════════════════════

/** public.publicToday — the venue's day: every court, every tournament. Auth: public.
 *  Used by: / (the front door)
 *  Reference: src/server/public.ts publicToday()
 *  Notes: cookie-free, like everything public — the CDN silently stops
 *    caching the page otherwise — and it never returns a phone number.
 *    Someone at the gate sees EVERY court regardless of which tournament it
 *    belongs to, in venue order, then a link to each tournament's own page.
 *    `courts[].tournament` is who holds it today, or null; `courts[].live` is
 *    the match on it right now, or null.
 *    `today` is every tournament on today; `upcoming` is later days, soonest
 *    first. The page prints, per tournament: "final table & results" when
 *    completed, "table & results" when live, "sign-ups open" when
 *    registrationOpen, else "not started yet".
 *    `version` is the same opaque string GET /api/version/today returns.
 *    The reference also returns `dayKey` and per-tournament played/total; the
 *    page reads none of them. */
export type Public_publicToday = {
  input: Record<string, never>
  output: {
    courts: Array<{
      id: string
      name: string
      colorKey: string
      /** Which tournament holds it today, if any. */
      tournament: { name: string; slug: string } | null
      /** The match on it right now. */
      live: {
        nameA: string | null
        playersA: string[]
        nameB: string | null
        playersB: string[]
      } | null
    }>
    today: Public_TodayTournament[]
    upcoming: Public_TodayTournament[]
    version: string
  }
}

/** One tournament row on the venue's Today page. */
export type Public_TodayTournament = {
  slug: string
  name: string
  /** ISO date, "YYYY-MM-DD". */
  day: string
  status: TournamentStatus
  /** Non-null while the day is stopped — the page shows a Paused notice. */
  pauseNote: string | null
  registrationOpen: boolean
}

/** public.publicTournament — the share link. Auth: public.
 *  Used by: /t/[slug]
 *  Reference: src/server/public.ts publicTournament()
 *  Notes: 404 when the slug is unknown or deleted — an unpublished
 *    tournament is not public, and its existence is not either. Cookie-free,
 *    built by explicit mappers and never from a raw row, because phone
 *    numbers are organiser-only and that is how they stay unleaked.
 *    `cut` is how many go through from the table; 0 when everyone just plays
 *    everyone. The page draws the cut line AROUND withdrawn pairs — the draw
 *    is built without them, so the line has to be too, or the page promises a
 *    final to a pair who have gone home.
 *    `matches` is in play order. The page derives from it: "On court now"
 *    (status 'live', ordered by court), "Up next" (the first two with
 *    state 'none', status 'ready' and both sides known), and "Played"
 *    (state 'final', resultType not 'bye', newest ended first). A bye is a
 *    row in the ledger, not something anybody scrolls a list to read.
 *    `scoreLine` is already from the WINNER's side — "11–7, 11–9" — and is
 *    null for a walkover, where the page prints the word instead.
 *    `players` is names only, in sign-up order, and is what the page shows
 *    before the start.
 *    `version` is the same opaque string GET /api/version/t/{slug} returns;
 *    it must be computed by the same code path.
 *    The reference's PublicTableRow also carries `played`; the table shows
 *    Won and Points only. */
export type Public_publicTournament = {
  input: { slug: string }
  output: {
    tournament: {
      name: string
      /** ISO date, "YYYY-MM-DD". */
      day: string
      status: TournamentStatus
      /** Non-null while the day is stopped. */
      pauseNote: string | null
      /** ISO date-time, or null — null and status 'setup' means sign-ups open. */
      registrationClosedAt: string | null
      /** ISO date-time — the "finished <time>" line on a completed page. */
      updatedAt: string
    }
    discipline: Discipline
    finalsStage: FinalsStage
    /** How many go through from the table; 0 when everyone just plays everyone. */
    cut: number
    /** This tournament's courts, in venue order. */
    courts: Array<{ id: string; name: string }>
    /** Names only. Never a phone number. */
    players: string[]
    matches: Public_Match[]
    table: Public_TableRow[]
    version: string
  }
}

/** One match on the public page. */
export type Public_Match = {
  id: string
  stage: Stage
  roundName: string | null
  teamAId: string | null
  teamBId: string | null
  nameA: string | null
  nameB: string | null
  playersA: string[]
  playersB: string[]
  courtId: string | null
  courtName: string | null
  courtColor: string | null
  status: MatchStatus
  state: ResultState
  gamesWonA: number
  gamesWonB: number
  winnerSide: 'A' | 'B' | null
  /** Game scores from the winner's side — "11–7, 11–9". Null for a walkover. */
  scoreLine: string | null
  /** ISO date-time, or null. */
  startedAt: string | null
  /** ISO date-time, or null. */
  endedAt: string | null
  /** So a no-show doesn't render as a match somebody actually played. */
  resultType: ResultType
}

/** One row of the public table, already in order. */
export type Public_TableRow = {
  teamId: string
  name: string
  players: string[]
  won: number
  pointsFor: number
  withdrawn: boolean
  /** Why this row sits where it does, when wins and points did not decide it. */
  note: string | null
}

// ═══════════════════════════════ registry ═══════════════════════════════

/**
 * Every RPC name → its type. The Go router and the React client both key off
 * this: a name that is not here is a 404 from the router and a compile error
 * in the client.
 */
export type Registry = {
  'auth.login': Auth_login
  'auth.logout': Auth_logout
  'auth.me': Auth_me

  'organisers.listOrganisers': Organisers_listOrganisers
  'organisers.addOrganiser': Organisers_addOrganiser
  'organisers.removeOrganiser': Organisers_removeOrganiser
  'organisers.changePin': Organisers_changePin

  'venue.venueCourts': Venue_venueCourts
  'venue.addCourt': Venue_addCourt
  'venue.renameCourt': Venue_renameCourt
  'venue.removeCourt': Venue_removeCourt

  'events.dashboard': Events_dashboard
  'events.courtCalendar': Events_courtCalendar
  'events.createEvent': Events_createEvent
  'events.hub': Events_hub
  'events.courtOptions': Events_courtOptions
  'events.assignCourts': Events_assignCourts
  'events.myCourts': Events_myCourts
  'events.closeRegistration': Events_closeRegistration
  'events.reopenRegistration': Events_reopenRegistration
  'events.startEvent': Events_startEvent
  'events.finishEvent': Events_finishEvent
  'events.deleteEvent': Events_deleteEvent

  'tournaments.getTournamentBySlug': Tournaments_getTournamentBySlug
  'tournaments.listMatches': Tournaments_listMatches
  'tournaments.listTeams': Tournaments_listTeams
  'tournaments.listTournamentPlayers': Tournaments_listTournamentPlayers
  'tournaments.standingsFor': Tournaments_standingsFor
  'tournaments.teamNameMap': Tournaments_teamNameMap
  'tournaments.gamesByMatch': Tournaments_gamesByMatch
  'tournaments.generateDraw': Tournaments_generateDraw

  'teams.teamBoard': Teams_teamBoard
  'teams.pairWith': Teams_pairWith
  'teams.splitTeam': Teams_splitTeam
  'teams.pairRestRandomly': Teams_pairRestRandomly

  'registration.ensureRegistrationLink': Registration_ensureRegistrationLink
  'registration.listRoster': Registration_listRoster
  'registration.addByHand': Registration_addByHand
  'registration.removePlayer': Registration_removePlayer
  'registration.mergePlayers': Registration_mergePlayers
  'registration.keepBoth': Registration_keepBoth
  'registration.resolveRegistrationToken': Registration_resolveRegistrationToken
  'registration.submitRegistration': Registration_submitRegistration

  'board.venueBoard': Board_venueBoard
  'board.moveOptions': Board_moveOptions
  'board.moveMatch': Board_moveMatch
  'board.clearCourt': Board_clearCourt
  'board.sendToCourt': Board_sendToCourt

  'scoring.getMatchForScoring': Scoring_getMatchForScoring
  'scoring.saveResult': Scoring_saveResult

  'chaos.withdrawalEffect': Chaos_withdrawalEffect
  'chaos.withdrawTeam': Chaos_withdrawTeam
  'chaos.reinstateTeam': Chaos_reinstateTeam
  'chaos.substitutionOptions': Chaos_substitutionOptions
  'chaos.substitutePlayer': Chaos_substitutePlayer
  'chaos.pauseDay': Chaos_pauseDay
  'chaos.resumeDay': Chaos_resumeDay
  'chaos.shortenFormat': Chaos_shortenFormat
  'chaos.voidMatch': Chaos_voidMatch

  'public.publicToday': Public_publicToday
  'public.publicTournament': Public_publicTournament
}

/** Convenience aliases for the client: `Input<'events.hub'>` etc. */
export type RpcName = keyof Registry
export type Input<N extends RpcName> = Registry[N]['input']
export type Output<N extends RpcName> = Registry[N]['output']

// ═══════════════════════════════ Pages ═══════════════════════════════
//
// Every route, the RPCs it calls for its initial data, and the RPCs behind
// each button — in the order the page uses them. The URLs are unchanged from
// the Next.js app. Everything under /admin needs a session; the client sends
// an unauthenticated visitor to /login?next=<path>.
//
// ── / — the venue's day (public) ────────────────────────────────────────
//   load    public.publicToday
//   poll    GET /api/version/today every 5s while any court is live, 30s
//           otherwise; refetch publicToday when `version` moves. Only while
//           the tab is visible; coming back to the tab checks at once.
//   links   /t/<slug> per tournament, /login ("Organiser sign in")
//
// ── /login (public) ────────────────────────────────────────────────────
//   load    auth.me — a signed-in visitor is redirected straight to /admin
//   submit  auth.login {pin, next}    #pin, six digits, hidden `next`
//           → ok: navigate to `redirect`; else print `error` under the field
//
// ── /r/[token] — the public sign-up form (public, never indexed) ────────
//   load    registration.resolveRegistrationToken {token}
//           404 → "This link doesn't work any more"
//           closed → the closed card only, no form
//   submit  registration.submitRegistration {token, name, phone, partnerName,
//           deviceId}  → the "You're on the list." card, in place
//
// ── /t/[slug] — the share link (public) ────────────────────────────────
//   load    public.publicTournament {slug}      404 → not found
//   poll    GET /api/version/t/<slug>: 5s while anything is on court, 30s
//           when nothing is, never once the tournament is completed
//
// ── /admin (layout) ────────────────────────────────────────────────────
//   load    auth.me — the initials button; mustChangePin sends the organiser
//           to /admin/account?first=1 and nothing else opens
//
// ── /admin — the tournament list ───────────────────────────────────────
//   load    events.dashboard
//   links   /admin/new, /admin/live (when anything is live),
//           /admin/t/<slug> per card
//
// ── /admin/new ─────────────────────────────────────────────────────────
//   load    events.courtCalendar
//   submit  events.createEvent {name, date, gender, discipline, format,
//           courts}  → navigate to `redirect`
//
// ── /admin/account ─────────────────────────────────────────────────────
//   load    auth.me
//           organisers.listOrganisers   (owner only, and only when the
//                                        organiser is not being forced to
//                                        change a temporary PIN)
//   submit  organisers.changePin {current, next, confirm}  #current #next
//           #confirm → navigate to `redirect`
//           organisers.addOrganiser {name}   input[aria-label="Add an
//           organiser"] → the PIN is shown once, here, in the response
//           organisers.removeOrganiser {userId}  → reload the list
//           auth.logout                          → navigate to /login
//   links   /admin/courts, /admin
//
// ── /admin/courts ──────────────────────────────────────────────────────
//   load    venue.venueCourts
//   submit  venue.renameCourt {courtId, name}      one form per row
//           venue.removeCourt {courtId}            only on a court with no
//                                                  holder
//           venue.addCourt {name}    input[aria-label="Add a court"]
//   after every one: reload venue.venueCourts and show `note` or `error`
//
// ── /admin/live — the one screen you look at while it is happening ──────
//   load    board.venueBoard
//           GET /api/version/venue          (rendered with, then polled)
//   poll    GET /api/version/venue every 5s; refetch when it moves, and
//           refetch anyway once a minute, because "on for 52 min" is a fact
//           about the clock, not the database
//   submit  chaos.resumeDay {tournamentId}         "Start again" on a paused
//                                                  tournament's notice
//           events.finishEvent {tournamentId}      "Finish <name>", shown
//                                                  when played === total
//           board.sendToCourt {matchId, courtId}   the terracotta offer
//           events.myCourts {tournamentId} then
//           events.assignCourts {tournamentId, courtIds: [...mine, courtId]}
//                                                  "Add <court> to <name>"
//   links   /admin/m/<matchId> ("Enter the score"),
//           /admin/live/move/<matchId> ("Move"),
//           /admin/t/<slug>/more, /admin/t/<slug>, /admin
//
// ── /admin/live/move/[matchId] ─────────────────────────────────────────
//   load    board.moveOptions {matchId}    404 → go to /admin/live
//   submit  board.moveMatch {matchId, courtId}   tapping a free court
//           board.clearCourt {matchId, later:true}   "Back to the queue"
//           both → navigate to `redirect` (/admin/live); on refusal stay and
//           print `error` in the "Not done" Notice
//
// ── /admin/m/[matchId] — enter a score ─────────────────────────────────
//   load    scoring.getMatchForScoring {matchId}   404 → not found
//   submit  scoring.saveResult {matchId, games, resultType, winnerTeamId,
//           retiredTeamId, reason?}  → on ok navigate to /admin/live
//           chaos.voidMatch {matchId, reason}   "Cancel this match", offered
//           only while the match is not live → navigate to `redirect`
//
// ── /admin/t/[slug] — the tournament hub ───────────────────────────────
//   load    events.hub {slug}                     404 → not found
//           then, only when phase is 'running' or 'finished':
//           tournaments.standingsFor {tournamentId}
//           tournaments.listMatches {tournamentId}
//           tournaments.teamNameMap {tournamentId}
//           tournaments.gamesByMatch {tournamentId}
//           (the four go out together)
//   submit  events.startEvent {tournamentId}      "Start the tournament"
//           events.finishEvent {tournamentId}     "Finish the tournament"
//           both → navigate to `redirect`
//   links   the four steps (…/registration, …/teams, …/schedule),
//           /admin/live, /admin/m/<id> per played row, …/results, …/more,
//           /t/<slug>, /admin
//
// ── /admin/t/[slug]/registration ───────────────────────────────────────
//   load    tournaments.getTournamentBySlug {slug}    404 → not found
//           registration.ensureRegistrationLink {tournamentId}
//           registration.listRoster {tournamentId}
//   submit  events.closeRegistration {tournamentId}   "Close sign-ups"
//           events.reopenRegistration {tournamentId}  "Reopen sign-ups"
//           registration.addByHand {tournamentId, text}
//                                              textarea[name=text] + Add
//           registration.removePlayer {tournamentId, playerId}   "Remove"
//           registration.mergePlayers {tournamentId, keepId:
//             duplicateOf.playerId, dropId: playerId}       "Same person"
//           registration.keepBoth {tournamentId, playerId}  "Different"
//   after every one: reload listRoster (and the tournament, for the closed
//   state) and show `note` or `error`
//
// ── /admin/t/[slug]/teams ──────────────────────────────────────────────
//   load    tournaments.getTournamentBySlug {slug}   404 → not found
//           teams.teamBoard {tournamentId}          (settles as it reads)
//   submit  teams.pairRestRandomly {tournamentId}   "Pair the rest at random"
//           teams.splitTeam {tournamentId, teamId}  "Split them"
//           both → reload teamBoard; on refusal print `error`
//   links   …/teams/pair/<playerId> ("Pair with…"), …/registration,
//           …/schedule, /admin/t/<slug>
//
// ── /admin/t/[slug]/teams/pair/[playerId] ──────────────────────────────
//   load    tournaments.getTournamentBySlug {slug}   404 → not found
//           teams.teamBoard {tournamentId}
//           singles, or locked, or the player is no longer unpaired →
//           go to /admin/t/<slug>/teams
//   submit  teams.pairWith {tournamentId, playerA: <playerId>, playerB}
//           → go to /admin/t/<slug>/teams
//
// ── /admin/t/[slug]/schedule — schedule & courts ───────────────────────
//   load    events.hub {slug}                    404 → not found; settles
//           events.courtOptions {tournamentId}
//           tournaments.listMatches {tournamentId}
//           tournaments.teamNameMap {tournamentId}
//   submit  events.assignCourts {tournamentId, courtIds}   "Save courts"
//           tournaments.generateDraw {tournamentId}
//                          "Make the schedule" / "Make it again"
//           events.startEvent {tournamentId}      "Start the tournament"
//   links   /admin/courts, /admin/t/<slug>
//
// ── /admin/t/[slug]/results — every match, grouped by round ────────────
//   load    tournaments.getTournamentBySlug {slug}   404 → not found
//           tournaments.listMatches {tournamentId}
//           tournaments.teamNameMap {tournamentId}
//           tournaments.gamesByMatch {tournamentId}
//           events.myCourts {tournamentId}
//   links   /admin/m/<id> for any match with both sides and no void,
//           /admin/t/<slug>
//
// ── /admin/t/[slug]/more — everything administrative ───────────────────
//   load    tournaments.getTournamentBySlug {slug}   404 → not found
//           then, by ?do=:
//     (list)      nothing more
//     ?do=fix     tournaments.listMatches, tournaments.teamNameMap,
//                 tournaments.gamesByMatch  → newest first, tap to
//                 /admin/m/<id>
//     ?do=withdraw          tournaments.listTeams {tournamentId}
//         &team=<teamId>    chaos.withdrawalEffect {tournamentId, teamId}
//                 submit chaos.withdrawTeam or chaos.reinstateTeam
//                        {tournamentId, teamId}
//     ?do=swap    chaos.substitutionOptions {tournamentId},
//                 tournaments.listTournamentPlayers {tournamentId}
//                 (who can step in = the roster minus everybody already in a
//                 pair)
//                 submit chaos.substitutePlayer {tournamentId, teamId,
//                        outPlayerId, inPlayerId}
//     ?do=shorten tournaments.listMatches, events.myCourts
//                 (the finish times on the buttons are computed on the client
//                 with lib/estimate from outstanding × courts)
//                 submit chaos.shortenFormat {tournamentId, bestOf,
//                        pointsToWin}
//     ?do=pause   nothing more — pauseNote comes from the tournament
//                 submit chaos.pauseDay {tournamentId, note} or
//                        chaos.resumeDay {tournamentId}
//     ?do=delete  tournaments.listTournamentPlayers, tournaments.listMatches,
//                 events.myCourts  (the counts in the confirm)
//                 submit events.deleteEvent {tournamentId} → navigate to
//                        `redirect` (/admin)
//   Every submit that succeeds shows its `note`; every refusal shows `error`,
//   and a refusal carrying fix:'board' offers a link to /admin/live while
//   fix:'signups' offers one to …/registration.
//
// ── /admin/t/[slug]/board ──────────────────────────────────────────────
//   No data. The per-tournament board is gone: redirect to /admin/live.
//
// ── version endpoints ──────────────────────────────────────────────────
//   GET /api/version/today        was /api/public/today/version
//   GET /api/version/t/{slug}     was /api/public/t/[slug]/version
//   GET /api/version/venue        was /admin/live/version   (organiser; 401
//                                 with no session, and the poller stops)
//   All three answer {"version": "<opaque string>"} with no-store on the
//   organiser one and a couple of seconds of CDN cache on the public two.
