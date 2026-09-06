import { and, asc, eq, inArray, isNull } from 'drizzle-orm'
import { db } from '@/db'
import {
  categories,
  courtClosures,
  courts,
  games,
  matches,
  players,
  teamPlayers,
  teams,
  tournaments,
} from '@/db/schema'
import { standings } from '@/lib/standings'
import { isProvisional, projectedState } from './scoring'

/**
 * Public reads — SPEC A8/A9.
 *
 * Everything here is built by explicit mappers, never from a raw row: phone
 * numbers are admin-only, and that is how they stay unleaked. This module must
 * stay cookie-free or the CDN silently stops caching the pages that use it.
 */

export type PublicMatch = {
  id: string
  /**
   * Identity for "Find my match". Matching a player to their match by NAME
   * puts both Karthiks in the same fixture; a team id is the only thing that
   * actually identifies a side.
   */
  teamAId: string | null
  teamBId: string | null
  categoryName: string
  roundName: string | null
  nameA: string | null
  nameB: string | null
  playersA: string[]
  playersB: string[]
  courtName: string | null
  courtColor: string | null
  status: string
  state: 'none' | 'reported' | 'disputed' | 'final' | 'voided'
  provisional: boolean
  gamesWonA: number
  gamesWonB: number
  winnerSide: 'A' | 'B' | null
  scoreLine: string | null
  startedAt: Date | null
}

/**
 * The number the page renders with and the number the poll endpoint returns
 * MUST be computed identically, or every spectator's phone hard-refreshes on
 * every tick — five seconds apart, all day, for forty people.
 *
 * The second term is not a clock. It counts results that have already crossed
 * the auto-confirm boundary: that transition writes nothing to the database, so
 * without it the day's last result stays labelled "provisional" on every phone
 * forever. It moves once per result, not once per minute.
 */
export function composeVersion(
  streamVersion: number | string,
  rows: Array<{ resultState: string; reportedAt: Date | null }>,
): number {
  let settled = 0
  for (const r of rows) {
    if (r.resultState === 'reported' && !isProvisional(r)) settled++
  }
  return Number(streamVersion) + settled
}

/** What the poll endpoint answers. Unpublished tournaments are not public. */
export async function publicVersion(slug: string): Promise<number | null> {
  const [row] = await db
    .select({ id: tournaments.id, v: tournaments.streamVersion, publishedAt: tournaments.publishedAt })
    .from(tournaments)
    .where(and(eq(tournaments.slug, slug), isNull(tournaments.deletedAt)))
    .limit(1)
  if (!row || !row.publishedAt) return null

  const rows = await db
    .select({ resultState: matches.resultState, reportedAt: matches.reportedAt })
    .from(matches)
    .where(and(eq(matches.tournamentId, row.id), eq(matches.resultState, 'reported')))

  return composeVersion(row.v, rows)
}

export async function publicTournament(slug: string) {
  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.slug, slug), isNull(tournaments.deletedAt)))
    .limit(1)
  if (!tournament || !tournament.publishedAt) return null

  const cats = await db
    .select()
    .from(categories)
    .where(and(eq(categories.tournamentId, tournament.id), isNull(categories.deletedAt)))
    .orderBy(asc(categories.seq))

  const teamRows = await db
    .select({ id: teams.id, name: teams.name, categoryId: teams.categoryId })
    .from(teams)
    .innerJoin(categories, eq(categories.id, teams.categoryId))
    .where(eq(categories.tournamentId, tournament.id))
  const teamName = new Map(teamRows.map((t) => [t.id, t.name]))

  const memberRows = teamRows.length
    ? await db
        .select({ teamId: teamPlayers.teamId, name: players.name })
        .from(teamPlayers)
        .innerJoin(players, eq(players.id, teamPlayers.playerId))
        .where(inArray(teamPlayers.teamId, teamRows.map((t) => t.id)))
    : []
  const membersByTeam = new Map<string, string[]>()
  for (const m of memberRows) {
    const list = membersByTeam.get(m.teamId) ?? []
    list.push(m.name)
    membersByTeam.set(m.teamId, list)
  }

  const matchRows = await db
    .select({
      m: matches,
      categoryName: categories.name,
      courtName: courts.name,
      courtColor: courts.colorKey,
    })
    .from(matches)
    .innerJoin(categories, eq(categories.id, matches.categoryId))
    .leftJoin(courts, eq(courts.id, matches.courtId))
    .where(eq(matches.tournamentId, tournament.id))
    .orderBy(asc(matches.roundIndex), asc(matches.seq))

  const gameRows = matchRows.length
    ? await db
        .select()
        .from(games)
        .where(inArray(games.matchId, matchRows.map((r) => r.m.id)))
        .orderBy(asc(games.gameNo))
    : []
  const gamesByMatch = new Map<string, typeof gameRows>()
  for (const g of gameRows) {
    const list = gamesByMatch.get(g.matchId) ?? []
    list.push(g)
    gamesByMatch.set(g.matchId, list)
  }

  const toPublicMatch = (r: (typeof matchRows)[number]): PublicMatch => {
    const state = projectedState(r.m) as PublicMatch['state']
    const gs = gamesByMatch.get(r.m.id) ?? []
    // A contested score is never published — showing either version to forty
    // people is how you get an argument (SPEC A5).
    const showScore = state === 'final' || state === 'reported'
    return {
      id: r.m.id,
      teamAId: r.m.teamAId,
      teamBId: r.m.teamBId,
      categoryName: r.categoryName,
      roundName: r.m.roundName,
      nameA: r.m.teamAId ? (teamName.get(r.m.teamAId) ?? null) : null,
      nameB: r.m.teamBId ? (teamName.get(r.m.teamBId) ?? null) : null,
      playersA: r.m.teamAId ? (membersByTeam.get(r.m.teamAId) ?? []) : [],
      playersB: r.m.teamBId ? (membersByTeam.get(r.m.teamBId) ?? []) : [],
      courtName: r.courtName ?? null,
      courtColor: r.courtColor ?? null,
      status: r.m.status,
      state,
      provisional: state === 'reported',
      gamesWonA: showScore ? r.m.gamesWonA : 0,
      gamesWonB: showScore ? r.m.gamesWonB : 0,
      winnerSide: !showScore
        ? null
        : r.m.winnerTeamId === r.m.teamAId
          ? 'A'
          : r.m.winnerTeamId === r.m.teamBId
            ? 'B'
            : null,
      scoreLine: showScore && gs.length ? gs.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ') : null,
      startedAt: r.m.startedAt,
    }
  }

  const allMatches = matchRows.map(toPublicMatch)

  const tables = cats.map((c) => {
    const catTeams = teamRows.filter((t) => t.categoryId === c.id).map((t) => t.id)
    const input = matchRows
      .filter((r) => r.m.categoryId === c.id && r.m.stage === 'group' && r.m.teamAId && r.m.teamBId)
      .filter((r) => projectedState(r.m) !== 'none')
      .map((r) => ({
        matchId: r.m.id,
        teamAId: r.m.teamAId!,
        teamBId: r.m.teamBId!,
        winnerTeamId: r.m.winnerTeamId,
        state: projectedState(r.m) as 'final' | 'reported' | 'disputed' | 'voided',
        resultType: r.m.resultType as 'normal' | 'bye' | 'walkover' | 'retired' | 'cancelled',
        games: (gamesByMatch.get(r.m.id) ?? []).map((g) => ({
          scoreA: g.scoreA,
          scoreB: g.scoreB,
          excludeFromDiff: g.excludeFromDiff,
          timeCapped: g.timeCapped,
        })),
      }))
    return {
      category: c,
      rows: standings(catTeams, input, c.tiebreakRule),
      advance: c.finalsStage === 'none' ? 0 : c.advancePerGroup,
    }
  })

  return {
    tournament,
    categories: cats,
    teamName,
    membersByTeam,
    matches: allMatches,
    live: allMatches.filter((m) => m.status === 'live'),
    upNext: allMatches.filter((m) => m.status === 'ready' && m.state === 'none').slice(0, 6),
    results: allMatches.filter((m) => m.state === 'final' || m.state === 'reported'),
    tables,
    courtsInPlay: await openCourtCount(tournament.id),
    streamVersion: composeVersion(
      tournament.streamVersion,
      matchRows.map((r) => ({ resultState: r.m.resultState, reportedAt: r.m.reportedAt })),
    ),
  }
}

/**
 * How many courts are actually running. "You're 5 matches away" counted every
 * unplayed match in the venue, including the ones that will run beside yours on
 * the other three courts.
 */
async function openCourtCount(tournamentId: string): Promise<number> {
  const all = await db.select({ id: courts.id }).from(courts).where(eq(courts.active, true))
  const closed = await db
    .select({ courtId: courtClosures.courtId })
    .from(courtClosures)
    .where(and(eq(courtClosures.tournamentId, tournamentId), isNull(courtClosures.until)))
  const closedIds = new Set(closed.map((c) => c.courtId))
  return Math.max(1, all.filter((c) => !closedIds.has(c.id)).length)
}

/** Everyone in this tournament, for "Find my match". */
export async function publicPlayers(tournamentId: string) {
  const rows = await db
    .select({ id: players.id, name: players.name, teamId: teamPlayers.teamId })
    .from(teamPlayers)
    .innerJoin(players, eq(players.id, teamPlayers.playerId))
    .innerJoin(teams, eq(teams.id, teamPlayers.teamId))
    .innerJoin(categories, eq(categories.id, teams.categoryId))
    .where(eq(categories.tournamentId, tournamentId))
    .orderBy(asc(players.name))

  const byPlayer = new Map<string, { id: string; name: string; teamIds: string[] }>()
  for (const r of rows) {
    const entry = byPlayer.get(r.id) ?? { id: r.id, name: r.name, teamIds: [] }
    entry.teamIds.push(r.teamId)
    byPlayer.set(r.id, entry)
  }
  return [...byPlayer.values()]
}
