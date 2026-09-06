import 'server-only'
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
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
  tournamentCourts,
  tournaments,
} from '@/db/schema'
import { bumpStreamVersion } from '@/lib/stream'
import { estimateDay, minutesPerMatch } from '@/lib/estimate'
import { venueDayKey } from '@/lib/time'
import { getVenue } from './tournaments'

/**
 * The court board — SPEC A4, v4.
 *
 * A tournament has its own courts and its matches never leave them. The next
 * match in order goes onto whichever of those courts is free, on its own,
 * so the organiser does nothing but enter scores. `boardData` is one
 * tournament's view; `venueBoard` is every court at the venue at once, which
 * is the screen the organiser actually looks at.
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
  /** Matches with a result in. Voided ones are in neither count. */
  played: number
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
 *
 * `courts` is THIS tournament's courts, not the venue's. Counting the venue's
 * four when the tournament holds two put the finish estimate an hour early
 * and offered Mixed Doubles a match on a Men's court.
 */
export async function boardData(tournamentId: string): Promise<BoardData> {
  // The first entry is deliberately dropped: getVenue is here only because it
  // throws when the venue was never seeded, which is a setup mistake that
  // should say so rather than render an empty board.
  const [, tournament, courtRows, closures, rows, teamNameRows, rosterRows, slotRows, elsewhere] =
    await Promise.all([
      getVenue(),

      db
        .select()
        .from(tournaments)
        .where(eq(tournaments.id, tournamentId))
        .limit(1)
        .then((r) => r[0]),

      db
        .select({
          id: courts.id,
          name: courts.name,
          colorKey: courts.colorKey,
          sortOrder: courts.sortOrder,
        })
        .from(tournamentCourts)
        .innerJoin(courts, eq(courts.id, tournamentCourts.courtId))
        .where(and(eq(tournamentCourts.tournamentId, tournamentId), eq(courts.active, true)))
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

      // Who is on a court in ANOTHER tournament right now. Ravi plays Men's
      // Doubles on Court 1 and Mixed on Court 3, and the one thing this board
      // exists to prevent is calling him to both at once.
      db
        .select({ playerId: players.id, courtName: courts.name })
        .from(matches)
        .innerJoin(teams, sql`${teams.id} = ${matches.teamAId} or ${teams.id} = ${matches.teamBId}`)
        .innerJoin(teamPlayers, eq(teamPlayers.teamId, teams.id))
        .innerJoin(players, eq(players.id, teamPlayers.playerId))
        .leftJoin(courts, eq(courts.id, matches.courtId))
        .where(and(eq(matches.status, 'live'), ne(matches.tournamentId, tournamentId))),
    ])

  const closedByCourt = new Map(closures.map((c) => [c.courtId, c.reason ?? 'Out of action']))
  const teamNames = new Map(teamNameRows.map((t) => [t.id, t.name]))
  const rosterByMatch = groupRoster(rosterRows)
  const waitingByMatch = waitingLabels(rows, slotRows)

  const courtNames = new Map(courtRows.map((c) => [c.id, c.name]))

  // Who is physically on a court right now, in this tournament or any other.
  const busy = new Map<string, string>() // playerId → court label
  for (const e of elsewhere) busy.set(e.playerId, e.courtName ?? 'another court')
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
    played: rows.filter((r) => r.resultState === 'final' || r.resultState === 'reported').length,
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
  // Two flows running at once — a score saved on each of two courts in the
  // same second — both pick the same next match from the same snapshot. The
  // second send must not quietly move a match that just went on.
  if (match.status === 'live') {
    return { ok: false as const, error: 'This match is already on a court.' }
  }

  // Four independent checks; the organiser is standing on a court waiting for
  // the answer, so they go out together rather than one hop at a time.
  const [court, held, closed, busyCourt] = await Promise.all([
    db
      .select({ name: courts.name })
      .from(courts)
      .where(eq(courts.id, courtId))
      .limit(1)
      .then((r) => r[0]),
    db
      .select({ id: tournamentCourts.id })
      .from(tournamentCourts)
      .where(
        and(
          eq(tournamentCourts.tournamentId, match.tournamentId),
          eq(tournamentCourts.courtId, courtId),
        ),
      )
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
  // A match only ever goes onto its own tournament's courts. Enforced here,
  // not in the screens: the Move list never offers another tournament's
  // court, but a form field is a wire value and this is the write.
  if (!held) {
    return {
      ok: false as const,
      error: `${court.name} isn’t one of this tournament’s courts — a match only goes on its own tournament’s courts.`,
    }
  }
  if (closed) {
    return { ok: false as const, error: `${court.name} is out of action — ${closed.reason ?? 'closed'}.` }
  }
  if (busyCourt) {
    return { ok: false as const, error: `${court.name} already has a match on it.` }
  }

  // The conflict check has to run HERE, not only when the board rendered.
  // Otherwise two sends from a stale board put the same player on two courts —
  // the one thing this product exists to prevent.
  if (!opts?.force) {
    const conflict = await livePlayerConflict(matchId)
    if (conflict) return { ok: false as const, error: conflict }
  }

  // One transaction: a match that went live without the board's version moving
  // is a board that never refreshes. The status is re-asserted in the WHERE
  // because it was read before the transaction opened.
  const placed = await transact(async (tx) => {
    const rows = await tx
      .update(matches)
      .set({
        courtId,
        status: 'live',
        startedAt: new Date(),
        version: sql`${matches.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(matches.id, matchId), ne(matches.status, 'live'), eq(matches.resultState, 'none')))
      .returning({ id: matches.id })
    if (rows.length) await bumpStreamVersion(match.tournamentId, tx)
    return rows.length > 0
  })
  if (!placed) return { ok: false as const, error: 'This match is already on a court.' }
  return { ok: true as const }
}

/**
 * Which match to offer each free court.
 *
 * Each free court is offered a DIFFERENT match — and never one that shares a
 * player with a match already offered somewhere else. Handing Court 1 and
 * Court 2 two matches that both contain Ravi meant the second was refused,
 * which is the exact collision the board exists to prevent.
 *
 * This is the one queue. The auto-flow places what it offers; the board's
 * "Next here" line predicts from the same rule; the More page's attention
 * block offers the same thing. Two functions that disagree about which pair
 * is next is worse than either answer.
 */
export function offersForFreeCourts(data: BoardData): Map<string, BoardMatch> {
  const placeable = data.queue.filter((m) => m.ready && !m.blockedBy)
  const freeCourts = data.courts.filter((c) => !c.closed && !c.live)

  const offers = new Map<string, BoardMatch>()
  const taken = new Set<string>()
  const spokenFor = new Set<string>()

  for (const court of freeCourts) {
    const pick = placeable.find(
      (m) => !taken.has(m.id) && !m.playerIds.some((p) => spokenFor.has(p)),
    )
    if (!pick) continue
    offers.set(court.id, pick)
    taken.add(pick.id)
    for (const p of pick.playerIds) spokenFor.add(p)
  }
  return offers
}

/**
 * Fill every free court this tournament holds with the next match in order.
 *
 * Idempotent and cheap: one board read, then one send per court that is
 * actually free and actually has something playable. Called after anything
 * that frees a court or adds one — a saved score, a move, a court added, a
 * pause lifted, the start of the day — so the organiser never sends a match
 * anywhere by hand. Nothing goes on while the tournament is paused.
 *
 * `skip`: a match the organiser has just taken off court. "Play it later"
 * means not this second; it is back in its place in the order for the next
 * court that frees up.
 */
/**
 * Flow every tournament running today, this one first. A saved score frees a
 * court in one tournament — and may free a PLAYER another tournament's court
 * was waiting on, because one person can be in Men's and Mixed on the same
 * Sunday. One tournament at a time, in order, so two flows never race.
 */
export async function flowVenue(opts?: { first?: string; skip?: string[] }) {
  const running = await db
    .select({ id: tournaments.id })
    .from(tournaments)
    .where(and(eq(tournaments.status, 'live'), isNull(tournaments.deletedAt)))
  const ids = running.map((t) => t.id).sort((a, b) => (a === opts?.first ? -1 : b === opts?.first ? 1 : 0))
  let placed = 0
  for (const id of ids) {
    const res = await flowTournament(id, id === opts?.first ? { skip: opts?.skip } : undefined)
    placed += res.placed
  }
  return { placed }
}

export async function flowTournament(tournamentId: string, opts?: { skip?: string[] }) {
  const [t] = await db
    .select({ status: tournaments.status, breakStartsAt: tournaments.breakStartsAt })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1)
  if (!t || t.status !== 'live' || t.breakStartsAt) return { placed: 0 }

  const data = await boardData(tournamentId)
  if (!data.courts.some((c) => !c.closed && !c.live)) return { placed: 0 }

  const skip = new Set(opts?.skip ?? [])
  const offers = offersForFreeCourts({
    ...data,
    queue: data.queue.filter((m) => !skip.has(m.id)),
  })

  // One at a time: each send re-checks the court and the players against the
  // database as it is now, not as the snapshot above had it.
  let placed = 0
  for (const [courtId, m] of offers) {
    const res = await sendToCourt(m.id, courtId)
    if (res.ok) placed++
  }
  return { placed }
}

/**
 * Move a live match to another of its own tournament's courts. The clock
 * starts again on the new court — a moved match is a match that is starting,
 * and a false "on for 52 min" is worse than a lost ten.
 */
export async function moveMatch(matchId: string, courtId: string) {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  if (!match) return { ok: false as const, error: 'That match no longer exists.' }
  if (match.status !== 'live') {
    return { ok: false as const, error: 'That match isn’t on a court.' }
  }
  if (match.courtId === courtId) return { ok: true as const }

  const [court, held, closed, busyCourt] = await Promise.all([
    db
      .select({ name: courts.name })
      .from(courts)
      .where(eq(courts.id, courtId))
      .limit(1)
      .then((r) => r[0]),
    db
      .select({ id: tournamentCourts.id })
      .from(tournamentCourts)
      .where(
        and(
          eq(tournamentCourts.tournamentId, match.tournamentId),
          eq(tournamentCourts.courtId, courtId),
        ),
      )
      .limit(1)
      .then((r) => r[0]),
    db
      .select({ reason: courtClosures.reason })
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
  if (!held) {
    return {
      ok: false as const,
      error: `${court.name} isn’t one of this tournament’s courts — a match only goes on its own tournament’s courts.`,
    }
  }
  if (closed) {
    return { ok: false as const, error: `${court.name} is out of action — ${closed.reason ?? 'closed'}.` }
  }
  if (busyCourt) {
    return { ok: false as const, error: `${court.name} already has a match on it.` }
  }

  await transact(async (tx) => {
    await tx
      .update(matches)
      .set({
        courtId,
        startedAt: new Date(),
        version: sql`${matches.version} + 1`,
        updatedAt: new Date(),
      })
      .where(and(eq(matches.id, matchId), eq(matches.status, 'live')))
    await bumpStreamVersion(match.tournamentId, tx)
  })
  return { ok: true as const }
}

export type MoveOption = {
  id: string
  name: string
  colorKey: string
  /** Who is on it, and for how long — a busy court is shown, not offered. */
  busy: { nameA: string | null; nameB: string | null; minutes: number } | null
  closedReason: string | null
}

export type MoveOptions = {
  match: { id: string; nameA: string | null; nameB: string | null; courtName: string | null }
  tournament: { id: string; slug: string; categoryName: string }
  /** The OTHER courts of the same tournament, in venue order. */
  courts: MoveOption[]
}

/** The Move screen's data: only this tournament's courts are ever on the list. */
export async function moveOptions(matchId: string): Promise<MoveOptions | null> {
  const [row] = await db
    .select({
      id: matches.id,
      tournamentId: matches.tournamentId,
      status: matches.status,
      courtId: matches.courtId,
      slug: tournaments.slug,
    })
    .from(matches)
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .where(eq(matches.id, matchId))
    .limit(1)
  if (!row || row.status !== 'live') return null

  const data = await boardData(row.tournamentId)
  const here = data.courts.find((c) => c.id === row.courtId)
  const live = here?.live ?? null
  if (!live) return null
  const now = Date.now()

  return {
    match: { id: live.id, nameA: live.nameA, nameB: live.nameB, courtName: here?.name ?? null },
    tournament: { id: row.tournamentId, slug: row.slug, categoryName: live.categoryName },
    courts: data.courts
      .filter((c) => c.id !== row.courtId)
      .map((c) => ({
        id: c.id,
        name: c.name,
        colorKey: c.colorKey,
        busy: c.live
          ? {
              nameA: c.live.nameA,
              nameB: c.live.nameB,
              minutes: c.live.startedAt
                ? Math.max(0, Math.floor((now - c.live.startedAt.getTime()) / 60_000))
                : 0,
            }
          : null,
        closedReason: c.closedReason,
      })),
  }
}

// ───────────────────────── the venue-wide board ─────────────────────────

export type VenueTournament = {
  id: string
  slug: string
  name: string
  categoryName: string
  /** "Men's", "Mixed" — the strip has room for one word. */
  shortName: string
  running: boolean
  /** Set while the day is stopped: the note the organiser gave. */
  paused: string | null
  played: number
  total: number
  /** Not yet on a court: what the day still has to get through. */
  toPlay: number
  finishAt: Date | null
  courtIds: string[]
  board: BoardData | null
}

export type VenueCourt = {
  id: string
  name: string
  colorKey: string
  /** Who holds it today, running or not. Null: nobody. */
  tournament: VenueTournament | null
  closedReason: string | null
  live: BoardMatch | null
  /** What will go on here next, when it is known. */
  next: BoardMatch | null
  /** When `next` is not a match: "waiting on Court 1's result". */
  nextNote: string | null
  /** A free court with a playable match nobody put on — the safety net. */
  offer: BoardMatch | null
  /** Why a free court is standing empty, in one sentence. */
  idleReason: string | null
}

export type VenueBoard = {
  now: Date
  tournaments: VenueTournament[]
  courts: VenueCourt[]
  liveCount: number
  /** For a court nobody holds: the running tournament that could use it. */
  wants: VenueTournament | null
}

/** Every tournament on today: running, or on today's date and not finished. */
async function todaysTournaments() {
  const todayKey = venueDayKey(new Date())
  const rows = await db
    .select({
      id: tournaments.id,
      slug: tournaments.slug,
      name: tournaments.name,
      status: tournaments.status,
      startDate: tournaments.startDate,
      pauseNote: tournaments.pauseNote,
      breakStartsAt: tournaments.breakStartsAt,
      streamVersion: tournaments.streamVersion,
      categoryName: categories.name,
    })
    .from(tournaments)
    .innerJoin(categories, eq(categories.tournamentId, tournaments.id))
    .where(
      and(
        isNull(tournaments.deletedAt),
        isNull(categories.deletedAt),
        ne(tournaments.status, 'completed'),
        ne(tournaments.status, 'archived'),
      ),
    )
    .orderBy(asc(tournaments.createdAt), asc(categories.seq))
  const seen = new Set<string>()
  return rows.filter((r) => {
    if (seen.has(r.id)) return false
    seen.add(r.id)
    return r.status === 'live' || venueDayKey(r.startDate) === todayKey
  })
}

/**
 * One number the board polls. Moves when anything board-visible moves in any
 * of today's tournaments, and when the set of them changes.
 */
export async function venueVersion(): Promise<string> {
  const rows = await todaysTournaments()
  return `${rows.length}:${rows.reduce((n, r) => n + Number(r.streamVersion), 0)}`
}

/** "Men's" from "Men's Doubles". */
function shortCategory(name: string) {
  return name.replace(/\s+(Doubles|Singles)$/i, '')
}

/**
 * Every court at the venue, one entry each, in venue order, across every
 * tournament on today. Read-only: the auto-flow runs at the writes, never
 * while a page renders.
 */
export async function venueBoard(): Promise<VenueBoard> {
  const venue = await getVenue()
  const [courtRows, todays] = await Promise.all([
    db
      .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
      .from(courts)
      .where(and(eq(courts.venueId, venue.id), eq(courts.active, true)))
      .orderBy(asc(courts.sortOrder)),
    todaysTournaments(),
  ])

  const ids = todays.map((t) => t.id)
  const [heldRows, boards] = await Promise.all([
    ids.length
      ? db
          .select({ tournamentId: tournamentCourts.tournamentId, courtId: tournamentCourts.courtId })
          .from(tournamentCourts)
          .where(inArray(tournamentCourts.tournamentId, ids))
      : Promise.resolve([]),
    Promise.all(todays.map((t) => (t.status === 'live' ? boardData(t.id) : Promise.resolve(null)))),
  ])

  const courtIdsBy = new Map<string, string[]>()
  for (const h of heldRows) {
    const list = courtIdsBy.get(h.tournamentId) ?? []
    list.push(h.courtId)
    courtIdsBy.set(h.tournamentId, list)
  }

  const venueTournaments: VenueTournament[] = todays.map((t, i) => {
    const board = boards[i]
    const total = board ? board.remaining + board.played : 0
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      categoryName: t.categoryName,
      shortName: shortCategory(t.categoryName),
      running: t.status === 'live',
      paused: t.breakStartsAt ? (t.pauseNote ?? 'Paused') : null,
      played: board?.played ?? 0,
      total,
      toPlay: board ? board.queue.length + board.waiting.length : 0,
      finishAt: board?.finishAt ?? null,
      courtIds: courtIdsBy.get(t.id) ?? [],
      board,
    }
  })

  const holder = new Map<string, VenueTournament>()
  for (const t of venueTournaments) for (const c of t.courtIds) holder.set(c, t)

  // Per running tournament: what each of its courts is doing and what comes
  // next there, from the same rule the flow places by.
  const perCourt = new Map<string, Omit<VenueCourt, 'id' | 'name' | 'colorKey' | 'tournament'>>()
  for (const t of venueTournaments) {
    if (!t.board) continue
    for (const [courtId, entry] of nextByCourt(t)) perCourt.set(courtId, entry)
  }

  const running = venueTournaments.filter((t) => t.running)
  const wants =
    [...running]
      .filter((t) => t.toPlay >= 3 && !t.paused && !!t.board && couldUseAnotherCourt(t.board))
      .sort((a, b) => b.toPlay - a.toPlay)[0] ?? null

  const venueCourts: VenueCourt[] = courtRows.map((c) => {
    const t = holder.get(c.id) ?? null
    const entry = perCourt.get(c.id)
    return {
      id: c.id,
      name: c.name,
      colorKey: c.colorKey,
      tournament: t,
      closedReason: entry?.closedReason ?? null,
      live: entry?.live ?? null,
      next: entry?.next ?? null,
      nextNote: entry?.nextNote ?? null,
      offer: entry?.offer ?? null,
      idleReason: entry?.idleReason ?? null,
    }
  })

  return {
    now: new Date(),
    tournaments: venueTournaments,
    courts: venueCourts,
    liveCount: venueCourts.filter((c) => c.live).length,
    wants,
  }
}

/**
 * Would one more court actually get a match on? Only when every court the
 * tournament holds is busy or closed AND a match is waiting whose players are
 * all free. "5 to play and a court sitting empty" used to show with four pairs
 * on two courts — all eight players already playing — and while the
 * tournament's own second court stood empty after a match was taken off it.
 */
function couldUseAnotherCourt(board: BoardData) {
  if (!board.courts.every((c) => c.live || c.closed)) return false
  const another: BoardCourt = {
    id: 'another',
    name: '',
    colorKey: '',
    closed: false,
    closedReason: null,
    live: null,
    freeSinceMinutes: null,
  }
  return offersForFreeCourts({ ...board, courts: [...board.courts, another] }).size > 0
}

/**
 * "Next here" for each of one tournament's courts.
 *
 * A free court is offered what the flow would put on it (which, if the flow
 * has done its job, is nothing — the offer is the safety net for a court that
 * came free by a door the flow does not watch). A busy court is told the
 * first match in order that could start once IT finishes: nothing sharing a
 * player with a match on another court, nothing already promised to a court
 * that will free up sooner.
 */
function nextByCourt(t: VenueTournament) {
  const board = t.board!
  const out = new Map<string, Omit<VenueCourt, 'id' | 'name' | 'colorKey' | 'tournament'>>()
  const offers = offersForFreeCourts(board)
  const promised = new Set([...offers.values()].map((m) => m.id))
  // Players in a match already promised to a court: two cards must never
  // both say Ravi is next, because only one of them can be right.
  const spokenFor = new Set<string>()
  for (const m of offers.values()) for (const p of m.playerIds) spokenFor.add(p)

  const liveCourts = board.courts.filter((c) => c.live)
  const liveCourtNames = liveCourts.map((c) => c.name)

  const waitingNote = (courtId: string | null) => {
    const others = liveCourts.filter((c) => c.id !== courtId).map((c) => c.name)
    const first = board.waiting[0]
    const label = first?.roundName ?? 'The next round'
    if (others.length) return `${label} · waiting on ${possessive(others)}`
    if (courtId && liveCourts.some((c) => c.id === courtId)) return `${label} · waiting on this result`
    return `${label} · ${(first?.waitingOn ?? 'waiting on an earlier result').replace(/^Waiting/, 'waiting')}`
  }

  // Busy courts in the order they are likely to free up.
  const busyInOrder = [...liveCourts].sort(
    (a, b) => (a.live!.startedAt?.getTime() ?? 0) - (b.live!.startedAt?.getTime() ?? 0),
  )
  for (const c of busyInOrder) {
    const onOtherCourts = new Set<string>()
    for (const o of liveCourts) if (o.id !== c.id) for (const p of o.live!.playerIds) onOtherCourts.add(p)
    const pick = board.queue.find(
      (m) =>
        !promised.has(m.id) &&
        !m.playerIds.some((p) => onOtherCourts.has(p) || spokenFor.has(p)),
    )
    if (pick) {
      promised.add(pick.id)
      for (const p of pick.playerIds) spokenFor.add(p)
    }
    let nextNote: string | null = null
    if (!pick) {
      if (board.queue.some((m) => !promised.has(m.id))) {
        const others = liveCourts.filter((o) => o.id !== c.id).map((o) => o.name)
        nextNote = others.length ? `waiting on ${possessive(others)}` : null
      } else if (board.waiting.length) nextNote = waitingNote(c.id)
      else nextNote = 'This is the last one here'
    }
    out.set(c.id, {
      closedReason: c.closedReason,
      live: c.live,
      next: pick ?? null,
      nextNote,
      offer: null,
      idleReason: null,
    })
  }

  for (const c of board.courts) {
    if (c.live) continue
    const offer = offers.get(c.id) ?? null
    let idleReason: string | null = null
    let next: BoardMatch | null = null
    let nextNote: string | null = null
    if (c.closed) {
      idleReason = null
    } else if (offer) {
      // The flow should have placed this. It did not, so the board offers it.
      next = offer
    } else if (board.queue.length) {
      idleReason = 'Everyone who could play next is already on a court'
      // Not the raw head of the queue: a busy court may already be promised
      // it, and the same pair cannot be next on two courts at once.
      next = board.queue.find((m) => !promised.has(m.id)) ?? null
      if (next) promised.add(next.id)
      if (t.paused) idleReason = null
    } else if (board.waiting.length) {
      nextNote = waitingNote(c.id)
    } else if (board.remaining === 0) {
      idleReason = `Every ${t.categoryName} match has been played`
    } else if (liveCourtNames.length) {
      nextNote = 'Nothing left for this court'
    }
    out.set(c.id, {
      closedReason: c.closedReason,
      live: null,
      next,
      nextNote,
      offer: t.paused ? null : offer,
      idleReason,
    })
  }
  return out
}

/** "Court 1’s result", "Court 1 and Court 2", "Court 1, Court 2 and Court 3". */
function possessive(names: string[]) {
  if (names.length <= 1) return `${names[0] ?? ''}’s result`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Names the player, because "blocked" is not actionable and a name is. Every
 * live match at the venue counts, not only this tournament's: a person can be
 * entered in two tournaments on the same day, and has one body.
 */
export async function livePlayerConflict(matchId: string) {
  const [live, courtNames] = await Promise.all([
    db
      .select({ id: matches.id, courtId: matches.courtId })
      .from(matches)
      .where(eq(matches.status, 'live')),
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
export async function clearCourt(matchId: string, opts?: { later?: boolean }) {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  if (!match) return { ok: false as const, error: 'That match no longer exists.' }
  if (match.status !== 'live') {
    return { ok: false as const, error: 'That match isn’t on a court.' }
  }

  // "Play it later" has to mean something the next flow can see, or the
  // court it just left offers the same match straight back. The order of
  // play is (round, seq): a league match goes to the back of its stage and
  // takes that round's tag. A knockout match can only go to the back of its
  // OWN round — sending a semi-final behind the final renamed it "Final" and
  // listed it after the match it feeds.
  let order: { roundIndex: number; seq: number; roundName?: string | null } | null = null
  if (opts?.later) {
    const knockout = match.stage === 'knockout'
    const [last] = await db
      .select({ roundIndex: matches.roundIndex, seq: matches.seq, roundName: matches.roundName })
      .from(matches)
      .where(
        and(
          eq(matches.categoryId, match.categoryId),
          eq(matches.stage, match.stage),
          knockout ? eq(matches.roundIndex, match.roundIndex) : undefined,
        ),
      )
      .orderBy(desc(matches.roundIndex), desc(matches.seq))
      .limit(1)
    if (last && (last.roundIndex !== match.roundIndex || last.seq !== match.seq)) {
      order = knockout
        ? { roundIndex: last.roundIndex, seq: last.seq + 1 }
        : { roundIndex: last.roundIndex, seq: last.seq + 1, roundName: last.roundName }
    }
  }

  await transact(async (tx) => {
    await tx
      .update(matches)
      .set({
        status: 'ready',
        courtId: null,
        startedAt: null,
        ...(order ?? {}),
        version: sql`${matches.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, matchId))
    await bumpStreamVersion(match.tournamentId, tx)
  })
  return { ok: true as const }
}
