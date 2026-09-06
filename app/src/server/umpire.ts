import 'server-only'
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
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

export async function umpireQueue(): Promise<UmpireMatch[]> {
  const running = await db
    .select({ id: tournaments.id, name: tournaments.name })
    .from(tournaments)
    .where(and(isNull(tournaments.deletedAt), ne(tournaments.status, 'draft')))
  if (running.length === 0) return []

  const rows = await db
    .select({
      id: matches.id,
      tournamentId: matches.tournamentId,
      categoryName: categories.name,
      roundName: matches.roundName,
      courtName: courts.name,
      courtColor: courts.colorKey,
      teamAId: matches.teamAId,
      teamBId: matches.teamBId,
      status: matches.status,
      resultState: matches.resultState,
      reportedAt: matches.reportedAt,
      roundIndex: matches.roundIndex,
      seq: matches.seq,
    })
    .from(matches)
    .innerJoin(categories, eq(categories.id, matches.categoryId))
    .leftJoin(courts, eq(courts.id, matches.courtId))
    .where(
      and(
        inArray(matches.tournamentId, running.map((t) => t.id)),
        inArray(matches.status, ['live', 'ready']),
      ),
    )
    .orderBy(asc(matches.roundIndex), asc(matches.seq))

  const withTeams = rows.filter((r) => r.teamAId && r.teamBId)
  if (withTeams.length === 0) return []

  const teamRows = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(
      inArray(
        teams.id,
        [...new Set(withTeams.flatMap((r) => [r.teamAId!, r.teamBId!]))],
      ),
    )
  const teamName = new Map(teamRows.map((t) => [t.id, t.name]))
  const tName = new Map(running.map((t) => [t.id, t.name]))

  return withTeams
    // A result that is already in is not an umpire's business; corrections are
    // an organiser action and live behind the admin guard.
    .filter((r) => projectedState(r) === 'none')
    .map((r) => ({
      id: r.id,
      tournamentName: tName.get(r.tournamentId) ?? '',
      categoryName: r.categoryName,
      roundName: r.roundName,
      courtName: r.courtName ?? null,
      courtColor: r.courtColor ?? null,
      nameA: teamName.get(r.teamAId!) ?? '—',
      nameB: teamName.get(r.teamBId!) ?? '—',
      status: r.status,
      state: r.resultState,
    }))
    .sort((a, b) => (a.status === b.status ? 0 : a.status === 'live' ? -1 : 1))
}
