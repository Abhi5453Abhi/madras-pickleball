import 'server-only'
import { and, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { db, transact } from '@/db'
import {
  categories,
  courts,
  courtClosures,
  matchSlots,
  matches,
  players,
  teamPlayers,
  teams,
  tournaments,
  venues,
} from '@/db/schema'
import { bumpStreamVersion } from '@/lib/stream'
import { estimateDay, minutesPerMatch } from '@/lib/estimate'
import { VENUE_SLUG, getVenue } from './tournaments'

/**
 * The court board — SPEC A4.
 *
 * This is the reason to build the product at all: the only thing that knows
 * four categories are sharing four courts. With 40 players across 3 categories
 * about 12 are in two of them, so double-booking is the median case, not an
 * edge case.
 */

export type BoardMatch = {
  id: string
  categoryId: string
  categoryName: string
  roundName: string | null
  teamAId: string | null
  teamBId: string | null
  nameA: string | null
  nameB: string | null
  status: string
  resultState: string
  courtId: string | null
  startedAt: Date | null
  version: number
  /** Set when a player here is already on court somewhere else. */
  blockedBy: string | null
  /** Both slots resolved. */
  ready: boolean
  /**
   * For a match that isn't ready: what it is waiting for, in words —
   * "Winner of Semi-final 1". Hiding these made the board's own count of
   * matches left disagree with the list under it.
   */
  waitingOn: string | null
  /** Minutes it has been on court beyond what its format should take. */
  overrunMinutes: number | null
  /** Who is in it — so two courts are never offered matches sharing a player. */
  playerIds: string[]
}

export type BoardCourt = {
  id: string
  name: string
  colorKey: string
  closed: boolean
  closedReason: string | null
  live: BoardMatch | null
  /** Minutes this court has been standing empty. Idle courts are the cost. */
  freeSinceMinutes: number | null
}

export type BoardData = {
  courts: BoardCourt[]
  queue: BoardMatch[]
  /** Not yet playable: waiting on an earlier result. Shown, never hidden. */
  waiting: BoardMatch[]
  liveCount: number
  remaining: number
  /** Set while the day is stopped: the note the organiser gave. */
  pausedNote: string | null
  /** Courts actually available — the basis the finish estimate is computed on. */
  openCourts: number
  finishEstimateMinutes: number
  finishAt: Date | null
  pastSunset: boolean
}

/**
 * How long past its expected length a match has to be before the board asks
 * about it. Generous: the failure it catches is a pair who walked off for water
 * and never gave anyone a score, not a long third game.
 */
const OVERRUN_FACTOR = 1.6

type Roster = Map<string, Array<{ id: string; name: string }>>

function groupRoster(
  rows: Array<{ matchId: string; playerId: string; playerName: string }>,
): Roster {
  const out: Roster = new Map()
  for (const r of rows) {
    const list = out.get(r.matchId) ?? []
    list.push({ id: r.playerId, name: r.playerName })
    out.set(r.matchId, list)
  }
  return out
}

const rosterColumns = {
  matchId: matches.id,
  playerId: players.id,
  playerName: players.name,
}

/**
 * Side A first, then B, each in the order the pair was entered.
 *
 * Left to the query plan this is arbitrary, and it decides which name the board
 * prints in "Meera Krishnamurthy is on Court 1" when both halves of a pair are
 * double-booked. A blocker that names a different person each time the page
 * reloads is not something an organiser can act on. Written out rather than
 * built from column references because drizzle drops the table prefix inside a
 * raw fragment, and this one spans three tables.
 */
const ROSTER_ORDER = sql`case when "teams"."id" = "matches"."team_a_id" then 0 else 1 end`

async function playersByMatch(matchIds: string[]): Promise<Roster> {
  if (matchIds.length === 0) return new Map()
  return groupRoster(
    await db
      .select(rosterColumns)
      .from(matches)
      .innerJoin(teams, sql`${teams.id} = ${matches.teamAId} or ${teams.id} = ${matches.teamBId}`)
      .innerJoin(teamPlayers, eq(teamPlayers.teamId, teams.id))
      .innerJoin(players, eq(players.id, teamPlayers.playerId))
      .where(inArray(matches.id, matchIds))
      .orderBy(ROSTER_ORDER, teamPlayers.position),
  )
}

/**
 * The board's whole payload in one round trip.
 *
 * Every read here is scoped by the tournament rather than by a list of ids that
 * an earlier read produced, which is what lets all eight go out together and be
 * pipelined down the single connection a serverless instance gets. Chained
 * queries cost a network hop each, and eight hops is the difference between a
 * board that answers instantly and one an organiser waits on with four courts
 * standing idle.
 */
export async function boardData(tournamentId: string): Promise<BoardData> {
  // The first entry is deliberately dropped: getVenue is here only because it
  // throws when the venue was never seeded, which is a setup mistake that
  // should say so rather than render an empty board. Its id is not needed —
  // the courts query joins the venue by slug itself.
  const [, tournament, courtRows, closures, rows, teamNameRows, rosterRows, slotRows] =
    await Promise.all([
      getVenue(),

      db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1)
        .then((r) => r[0]),

      // Joined to the venue by slug rather than waiting for getVenue's id, so
      // this does not need a second round trip.
      db
        .select({
          id: courts.id,
          name: courts.name,
          colorKey: courts.colorKey,
          sortOrder: courts.sortOrder,
        })
        .from(courts)
        .innerJoin(venues, eq(venues.id, courts.venueId))
        .where(and(eq(venues.slug, VENUE_SLUG), eq(courts.active, true)))
        .orderBy(courts.sortOrder),

      db
        .select({ courtId: courtClosures.courtId, reason: courtClosures.reason })
        .from(courtClosures)
        .where(and(eq(courtClosures.tournamentId, tournamentId), isNull(courtClosures.until))),

      db
        .select({
          id: matches.id,
          categoryId: matches.categoryId,
          categoryName: categories.name,
          roundName: matches.roundName,
          teamAId: matches.teamAId,
          teamBId: matches.teamBId,
          status: matches.status,
          resultState: matches.resultState,
          courtId: matches.courtId,
          startedAt: matches.startedAt,
          endedAt: matches.endedAt,
          version: matches.version,
          bestOf: categories.bestOf,
          pointsToWin: categories.pointsToWin,
        })
        .from(matches)
        .innerJoin(categories, eq(categories.id, matches.categoryId))
        .where(eq(matches.tournamentId, tournamentId))
        .orderBy(matches.roundIndex, matches.seq),

      db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .innerJoin(categories, eq(categories.id, teams.categoryId))
        .where(eq(categories.tournamentId, tournamentId)),

      db
        .select(rosterColumns)
        .from(matches)
        .innerJoin(teams, sql`${teams.id} = ${matches.teamAId} or ${teams.id} = ${matches.teamBId}`)
        .innerJoin(teamPlayers, eq(teamPlayers.teamId, teams.id))
        .innerJoin(players, eq(players.id, teamPlayers.playerId))
        .where(eq(matches.tournamentId, tournamentId))
        .orderBy(ROSTER_ORDER, teamPlayers.position),

      // Only the matches that are still short of a side have anything to say
      // about what they are waiting for.
      db
        .select({
          matchId: matchSlots.matchId,
          slot: matchSlots.slot,
          sourceType: matchSlots.sourceType,
          sourceMatchId: matchSlots.sourceMatchId,
          sourceRank: matchSlots.sourceRank,
        })
        .from(matchSlots)
        .innerJoin(matches, eq(matches.id, matchSlots.matchId))
        .where(
          and(
            eq(matches.tournamentId, tournamentId),
            or(isNull(matches.teamAId), isNull(matches.teamBId)),
          ),
        ),
    ])

  const closedByCourt = new Map(closures.map((c) => [c.courtId, c.reason ?? 'Out of action']))
  const teamNames = new Map(teamNameRows.map((t) => [t.id, t.name]))
  const rosterByMatch = groupRoster(rosterRows)
  const waitingByMatch = waitingLabels(rows, slotRows)

  const courtNames = new Map(courtRows.map((c) => [c.id, c.name]))

  // Who is physically on a court right now, across every category.
  const busy = new Map<string, string>() // playerId → court label
  const liveByCourt = new Map<string, (typeof rows)[number]>()
  for (const r of rows) {
    if (r.status !== 'live') continue
    if (r.courtId) liveByCourt.set(r.courtId, r)
    const where = (r.courtId && courtNames.get(r.courtId)) || 'another court'
    for (const p of rosterByMatch.get(r.id) ?? []) busy.set(p.id, where)
  }

  const now = Date.now()

  const toBoardMatch = (r: (typeof rows)[number]): BoardMatch => {
    const ready = !!r.teamAId && !!r.teamBId
    let blockedBy: string | null = null
    if (ready && r.status !== 'live') {
      for (const p of rosterByMatch.get(r.id) ?? []) {
        const where = busy.get(p.id)
        if (where) {
          // The reason IS the button label. Naming the person is what turns
          // "blocked" into something the organiser can act on.
          blockedBy = `${p.name} is on ${where}`
          break
        }
      }
    }

    let overrunMinutes: number | null = null
    if (r.status === 'live' && r.startedAt) {
      const expected = minutesPerMatch({ bestOf: r.bestOf, pointsToWin: r.pointsToWin })
      const elapsed = Math.floor((now - r.startedAt.getTime()) / 60_000)
      if (elapsed > expected * OVERRUN_FACTOR) overrunMinutes = elapsed
    }

    return {
      id: r.id,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      roundName: r.roundName,
      teamAId: r.teamAId,
      teamBId: r.teamBId,
      nameA: r.teamAId ? (teamNames.get(r.teamAId) ?? null) : null,
      nameB: r.teamBId ? (teamNames.get(r.teamBId) ?? null) : null,
      status: r.status,
      resultState: r.resultState,
      courtId: r.courtId,
      startedAt: r.startedAt,
      version: r.version,
      blockedBy,
      ready,
      waitingOn: ready ? null : (waitingByMatch.get(r.id) ?? 'an earlier result'),
      overrunMinutes,
      playerIds: (rosterByMatch.get(r.id) ?? []).map((p) => p.id),
    }
  }

  // When a court last had a match end on it, so an idle court can say how long
  // it has been idle.
  const lastEndedByCourt = new Map<string, number>()
  for (const r of rows) {
    if (!r.courtId || !r.endedAt) continue
    const prev = lastEndedByCourt.get(r.courtId) ?? 0
    if (r.endedAt.getTime() > prev) lastEndedByCourt.set(r.courtId, r.endedAt.getTime())
  }

  const boardCourts: BoardCourt[] = courtRows.map((c) => {
    const live = liveByCourt.get(c.id)
    const lastEnded = lastEndedByCourt.get(c.id)
    return {
      id: c.id,
      name: c.name,
      colorKey: c.colorKey,
      closed: closedByCourt.has(c.id),
      closedReason: closedByCourt.get(c.id) ?? null,
      live: live ? toBoardMatch(live) : null,
      freeSinceMinutes:
        live || !lastEnded ? null : Math.max(0, Math.floor((now - lastEnded) / 60_000)),
    }
  })

  // Everything still to happen, INCLUDING what is on court right now. Leaving
  // live matches out made the board print "Done" with four matches in play, and
  // shortened the finish estimate by half an hour per court.
  const outstanding = rows.filter((r) => r.resultState === 'none')
  const unplaced = outstanding
    .filter((r) => r.status !== 'live' && !r.courtId)
    .map(toBoardMatch)
  const queue = unplaced.filter((m) => m.ready)
  const waiting = unplaced.filter((m) => !m.ready)

  const openCourts = boardCourts.filter((c) => !c.closed).length

  // Per category, with that category's OWN format. Estimating a best-of-3
  // singles pool at the doubles rate — or the reverse — is how the one number
  // whose job is to stop the day running past sunset becomes the cause of it.
  const byCategory = new Map<
    string,
    { name: string; matchCount: number; minutesPerMatch: number }
  >()
  for (const r of outstanding) {
    const entry = byCategory.get(r.categoryId) ?? {
      name: r.categoryName,
      matchCount: 0,
      minutesPerMatch: minutesPerMatch({ bestOf: r.bestOf, pointsToWin: r.pointsToWin }),
    }
    entry.matchCount++
    byCategory.set(r.categoryId, entry)
  }

  // A stopped day does not finish any earlier for standing still. Counting the
  // minutes since the pause is what makes the sunset warning tell the truth
  // while everyone is sheltering under the awning.
  const pausedMinutes = tournament?.breakStartsAt
    ? Math.max(0, Math.floor((now - tournament.breakStartsAt.getTime()) / 60_000))
    : 0

  const est = estimateDay({
    categories: [...byCategory.values()].map((c) => ({ ...c, minMatchesPerEntry: 0 })),
    courts: openCourts,
    startAt: new Date(now),
    breakMinutes: pausedMinutes,
    sunsetAt: tournament?.sunsetAt ?? null,
  })

  return {
    courts: boardCourts,
    queue,
    waiting,
    liveCount: boardCourts.filter((c) => c.live).length,
    remaining: outstanding.length,
    pausedNote: tournament?.pauseNote ?? null,
    openCourts,
    finishEstimateMinutes: est.minutes,
    finishAt: est.finishAt,
    pastSunset: est.pastSunset,
  }
}

/**
 * "Winner of Semi-final 1", "2nd in Group B" — what an unready match is waiting
 * for. The board used to drop these rows entirely, so the header said 7 to play
 * above a list of 4.
 *
 * Pure: the round name of the source match is already in the board's own match
 * list — every slot source is a match in the same category, and therefore the
 * same tournament — so looking it up cost a second query for nothing.
 */
function waitingLabels(
  rows: Array<{ id: string; teamAId: string | null; teamBId: string | null; roundName: string | null }>,
  slots: Array<{
    matchId: string
    slot: string
    sourceType: string
    sourceMatchId: string | null
    sourceRank: number | null
  }>,
) {
  const out = new Map<string, string>()
  if (slots.length === 0) return out

  const byId = new Map(rows.map((r) => [r.id, r]))

  const ordinal = (n: number) =>
    n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`

  const bySlotMatch = new Map<string, string[]>()
  for (const s of slots) {
    const row = byId.get(s.matchId)
    if (!row) continue
    // Only describe the side that is actually still empty.
    const filled = s.slot === 'A' ? row.teamAId : row.teamBId
    if (filled) continue

    let label: string | null = null
    if (s.sourceType === 'winner_of' && s.sourceMatchId) {
      label = `winner of ${byId.get(s.sourceMatchId)?.roundName ?? 'an earlier match'}`
    } else if (s.sourceType === 'loser_of' && s.sourceMatchId) {
      label = `loser of ${byId.get(s.sourceMatchId)?.roundName ?? 'an earlier match'}`
    } else if (s.sourceType === 'group_rank' && s.sourceRank) {
      label = `${ordinal(s.sourceRank)} in the group`
    }
    if (!label) continue
    const list = bySlotMatch.get(s.matchId) ?? []
    list.push(label)
    bySlotMatch.set(s.matchId, list)
  }

  for (const [matchId, labels] of bySlotMatch) {
    // "Waiting for the 1st and 2nd in the group" — the shared tail is said
    // once. The board prints this on a card, and the long form wrapped off it.
    const tail = 'in the group'
    const short =
      labels.length === 2 && labels.every((l) => l.endsWith(tail))
        ? `${labels.map((l) => l.slice(0, -tail.length).trim()).join(' and ')} ${tail}`
        : labels.join(' and the ')
    out.set(matchId, `Waiting for the ${short}`)
  }
  return out
}

/**
 * Placing a match. The unique index on `matches(court_id) where status='live'`
 * makes double-booking structurally impossible; this turns the violation into a
 * sentence rather than a 500 on tournament morning.
 */
export async function sendToCourt(matchId: string, courtId: string, opts?: { force?: boolean }) {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  if (!match) return { ok: false as const, error: 'That match no longer exists.' }
  if (!match.teamAId || !match.teamBId) {
    return { ok: false as const, error: 'This match is still waiting on an earlier result.' }
  }
  if (match.resultState !== 'none') {
    return { ok: false as const, error: 'This match already has a result.' }
  }

  // Three independent checks; the organiser is standing on a court waiting for
  // the answer, so they go out together rather than one hop at a time.
  const [court, closed, busyCourt] = await Promise.all([
    db
      .select({ name: courts.name })
      .from(courts)
      .where(eq(courts.id, courtId))
      .limit(1)
      .then((r) => r[0]),
    db
      .select({ id: courtClosures.id, reason: courtClosures.reason })
      .from(courtClosures)
      .where(
        and(
          eq(courtClosures.courtId, courtId),
          eq(courtClosures.tournamentId, match.tournamentId),
          isNull(courtClosures.until),
        ),
      )
      .limit(1)
      .then((r) => r[0]),
    db
      .select({ id: matches.id })
      .from(matches)
      .where(and(eq(matches.courtId, courtId), eq(matches.status, 'live')))
      .limit(1)
      .then((r) => r[0]),
  ])

  if (!court) return { ok: false as const, error: 'That court no longer exists.' }
  if (closed) {
    return { ok: false as const, error: `${court.name} is out of action — ${closed.reason ?? 'closed'}.` }
  }
  if (busyCourt) {
    return { ok: false as const, error: 'That court already has a live match — end it first.' }
  }

  // The conflict check has to run HERE, not only when the board rendered.
  // Otherwise two sends from a stale board put the same player on two courts —
  // the one thing this product exists to prevent.
  if (!opts?.force) {
    const conflict = await livePlayerConflict(match.tournamentId, matchId)
    if (conflict) return { ok: false as const, error: conflict }
  }

  // One transaction: a match that went live without the board's version moving
  // is a board that never refreshes.
  await transact(async (tx) => {
    await tx
      .update(matches)
      .set({
        courtId,
        status: 'live',
        startedAt: new Date(),
        version: sql`${matches.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, matchId))
    await bumpStreamVersion(match.tournamentId, tx)
  })
  return { ok: true as const }
}

/** Names the player, because "blocked" is not actionable and a name is. */
export async function livePlayerConflict(tournamentId: string, matchId: string) {
  const [live, courtNames] = await Promise.all([
    db
      .select({ id: matches.id, courtId: matches.courtId })
      .from(matches)
      .where(and(eq(matches.tournamentId, tournamentId), eq(matches.status, 'live'))),
    db
      .select({ id: courts.id, name: courts.name })
      .from(courts)
      .then((rows) => new Map(rows.map((c) => [c.id, c.name]))),
  ])
  if (live.length === 0) return null

  const rosters = await playersByMatch([matchId, ...live.map((m) => m.id)])
  const mine = new Set((rosters.get(matchId) ?? []).map((p) => p.id))

  for (const other of live) {
    for (const p of rosters.get(other.id) ?? []) {
      if (mine.has(p.id)) {
        return `${p.name} is on ${courtNames.get(other.courtId ?? '') ?? 'another court'}`
      }
    }
  }
  return null
}

/**
 * Take a match off court without recording a result. Only a LIVE match: doing
 * this to a completed one resurrected a finished match and erased which court
 * it was played on.
 */
export async function clearCourt(matchId: string) {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  if (!match) return { ok: false as const, error: 'That match no longer exists.' }
  if (match.status !== 'live') {
    return { ok: false as const, error: 'That match isn’t on a court.' }
  }
  await transact(async (tx) => {
    await tx
      .update(matches)
      .set({
        status: 'ready',
        courtId: null,
        startedAt: null,
        version: sql`${matches.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, matchId))
    await bumpStreamVersion(match.tournamentId, tx)
  })
  return { ok: true as const }
}
