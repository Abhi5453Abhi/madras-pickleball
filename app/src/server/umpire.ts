import 'server-only'
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { db } from '@/db'
import { categories, courts, matches, teams, tournaments } from '@/db/schema'
import { projectedState } from './scoring'

/**
 * What a signed-in umpire is allowed to see — SPEC A9.
 *
 * An umpire is a scorer, not an organiser: no draw, no board, no corrections.
 * This is the whole of their app: the matches that are on court right now and
 * the ones queued behind them, in every running tournament.
 */
export type UmpireMatch = {
  id: string
  tournamentName: string
  categoryName: string
  roundName: string | null
  courtName: string | null
  courtColor: string | null
  nameA: string
  nameB: string
  status: string
  state: string
}

/**
 * One query. The tournament this match belongs to and the two sides' names are
 * joins, not three chained lookups that each cost a network hop before an
 * umpire sees the list of what they are scoring.
 */
export async function umpireQueue(): Promise<UmpireMatch[]> {
  const teamA = alias(teams, 'team_a')
  const teamB = alias(teams, 'team_b')

  const rows = await db
    .select({
      id: matches.id,
      tournamentName: tournaments.name,
      categoryName: categories.name,
      roundName: matches.roundName,
      courtName: courts.name,
      courtColor: courts.colorKey,
      teamAId: matches.teamAId,
      teamBId: matches.teamBId,
      nameA: teamA.name,
      nameB: teamB.name,
      status: matches.status,
      resultState: matches.resultState,
      reportedAt: matches.reportedAt,
    })
    .from(matches)
    .innerJoin(categories, eq(categories.id, matches.categoryId))
    .innerJoin(tournaments, eq(tournaments.id, matches.tournamentId))
    .leftJoin(courts, eq(courts.id, matches.courtId))
    .leftJoin(teamA, eq(teamA.id, matches.teamAId))
    .leftJoin(teamB, eq(teamB.id, matches.teamBId))
    .where(
      and(
        isNull(tournaments.deletedAt),
        ne(tournaments.status, 'draft'),
        inArray(matches.status, ['live', 'ready']),
      ),
    )
    .orderBy(asc(matches.roundIndex), asc(matches.seq))

  const withTeams = rows.filter((r) => r.teamAId && r.teamBId)
  if (withTeams.length === 0) return []

  return withTeams
    // A result that is already in is not an umpire's business; corrections are
    // an organiser action and live behind the admin guard.
    .filter((r) => projectedState(r) === 'none')
    .map((r) => ({
      id: r.id,
      tournamentName: r.tournamentName,
      categoryName: r.categoryName,
      roundName: r.roundName,
      courtName: r.courtName ?? null,
      courtColor: r.courtColor ?? null,
      nameA: r.nameA ?? '—',
      nameB: r.nameB ?? '—',
      status: r.status,
      state: r.resultState,
    }))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'live' ? -1 : 1))
}
