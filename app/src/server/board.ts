import 'server-only'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  categories,
  courts,
  courtClosures,
  matches,
  players,
  teamPlayers,
  teams,
  tournaments,
} from '@/db/schema'
import { bumpStreamVersion } from '@/lib/stream'
import { estimateDay, minutesPerMatch } from '@/lib/estimate'
import { getVenue } from './tournaments'

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
}

export type BoardCourt = {
  id: string
  name: string
  colorKey: string
  closed: boolean
  closedReason: string | null
  live: BoardMatch | null
  /** Finished here recently and still has no score — the common failure. */
  awaitingScore: BoardMatch | null
  freeSinceMinutes: number | null
}

export type BoardData = {
  courts: BoardCourt[]
  queue: BoardMatch[]
  liveCount: number
  remaining: number
  finishEstimateMinutes: number
  finishAt: Date | null
  pastSunset: boolean
}

async function playersByMatch(matchIds: string[]) {
  if (matchIds.length === 0) return new Map<string, Array<{ id: string; name: string }>>()
  const rows = await db
    .select({
      matchId: matches.id,
      playerId: players.id,
      playerName: players.name,
    })
    .from(matches)
    .innerJoin(
      teams,
      sql`${teams.id} = ${matches.teamAId} or ${teams.id} = ${matches.teamBId}`,
    )
    .innerJoin(teamPlayers, eq(teamPlayers.teamId, teams.id))
    .innerJoin(players, eq(players.id, teamPlayers.playerId))
    .where(inArray(matches.id, matchIds))

  const out = new Map<string, Array<{ id: string; name: string }>>()
  for (const r of rows) {
    const list = out.get(r.matchId) ?? []
    list.push({ id: r.playerId, name: r.playerName })
    out.set(r.matchId, list)
  }
  return out
}

export async function boardData(tournamentId: string): Promise<BoardData> {
  const venue = await getVenue()
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1)

  const courtRows = await db
    .select()
    .from(courts)
    .where(and(eq(courts.venueId, venue.id), eq(courts.active, true)))
    .orderBy(courts.sortOrder)

  const closures = await db
    .select()
    .from(courtClosures)
    .where(eq(courtClosures.tournamentId, tournamentId))
  const closedByCourt = new Map(
    closures.filter((c) => !c.until).map((c) => [c.courtId, c.reason ?? 'Out of action']),
  )

  const rows = await db
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
    .orderBy(matches.roundIndex, matches.seq)

  const teamNames = new Map(
    (
      await db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .innerJoin(categories, eq(categories.id, teams.categoryId))
        .where(eq(categories.tournamentId, tournamentId))
    ).map((t) => [t.id, t.name]),
  )

  const rosterByMatch = await playersByMatch(rows.map((r) => r.id))

  // Who is physically on a court right now, across every category.
  const busy = new Map<string, string>() // playerId → court label
  for (const r of rows) {
    if (r.status !== 'live') continue
    const court = courtRows.find((c) => c.id === r.courtId)
    for (const p of rosterByMatch.get(r.id) ?? []) {
      busy.set(p.id, court ? court.name : 'another court')
    }
  }

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
    }
  }

  const boardCourts: BoardCourt[] = courtRows.map((c) => {
    const live = rows.find((r) => r.courtId === c.id && r.status === 'live')
    const awaiting = rows.find(
      (r) => r.courtId === c.id && r.status === 'completed' && r.resultState === 'none',
    )
    return {
      id: c.id,
      name: c.name,
      colorKey: c.colorKey,
      closed: closedByCourt.has(c.id),
      closedReason: closedByCourt.get(c.id) ?? null,
      live: live ? toBoardMatch(live) : null,
      awaitingScore: awaiting ? toBoardMatch(awaiting) : null,
      freeSinceMinutes: null,
    }
  })

  const unplayed = rows.filter((r) => r.resultState === 'none' && r.status !== 'live')
  const queue = unplayed.filter((r) => !r.courtId).map(toBoardMatch)

  const openCourts = boardCourts.filter((c) => !c.closed).length
  const est = estimateDay({
    categories: [
      {
        name: 'all',
        matchCount: unplayed.length,
        minutesPerMatch: minutesPerMatch({
          bestOf: rows[0]?.bestOf ?? 3,
          pointsToWin: rows[0]?.pointsToWin ?? 11,
        }),
        minMatchesPerEntry: 0,
      },
    ],
    courts: openCourts,
    startAt: new Date(),
    sunsetAt: tournament?.sunsetAt ?? null,
  })

  return {
    courts: boardCourts,
    queue,
    liveCount: boardCourts.filter((c) => c.live).length,
    remaining: unplayed.length,
    finishEstimateMinutes: est.minutes,
    finishAt: est.finishAt,
    pastSunset: est.pastSunset,
  }
}

/**
 * Placing a match. The unique index on `matches(court_id) where status='live'`
 * makes double-booking structurally impossible; this turns the violation into a
 * sentence rather than a 500 on tournament morning.
 */
export async function sendToCourt(matchId: string, courtId: string) {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  if (!match) return { ok: false as const, error: 'That match no longer exists.' }
  if (!match.teamAId || !match.teamBId) {
    return { ok: false as const, error: 'This match is still waiting on an earlier result.' }
  }

  const [busyCourt] = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.courtId, courtId), eq(matches.status, 'live')))
    .limit(1)
  if (busyCourt) {
    return { ok: false as const, error: 'That court already has a live match — end it first.' }
  }

  await db
    .update(matches)
    .set({
      courtId,
      status: 'live',
      startedAt: new Date(),
      version: sql`${matches.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(matches.id, matchId))

  await bumpStreamVersion(match.tournamentId)
  return { ok: true as const }
}

export async function clearCourt(matchId: string) {
  const [match] = await db.select().from(matches).where(eq(matches.id, matchId)).limit(1)
  if (!match) return
  await db
    .update(matches)
    .set({
      status: 'ready',
      courtId: null,
      startedAt: null,
      version: sql`${matches.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(matches.id, matchId))
  await bumpStreamVersion(match.tournamentId)
}
