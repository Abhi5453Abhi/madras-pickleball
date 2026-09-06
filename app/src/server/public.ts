import { cache } from 'react'
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  categories,
  courts,
  games,
  matches,
  players,
  teamPlayers,
  teams,
  tournamentCourts,
  tournamentPlayers,
  tournaments,
} from '@/db/schema'
import { tieNote, standings } from '@/lib/standings'
import { venueDayKey } from '@/lib/time'
import { AUTO_CONFIRM_MINUTES, isProvisional, projectedState } from './scoring'

/**
 * Public reads — the share link and the venue's "Today" page.
 *
 * Everything here is built by explicit mappers, never from a raw row: phone
 * numbers are admin-only, and that is how they stay unleaked. This module must
 * stay cookie-free or the CDN silently stops caching the pages that use it.
 */

export type PublicMatch = {
  id: string
  stage: string
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
  status: string
  state: 'none' | 'reported' | 'disputed' | 'final' | 'voided'
  gamesWonA: number
  gamesWonB: number
  winnerSide: 'A' | 'B' | null
  /** Game scores from the winner's side — "11–7, 11–9". */
  scoreLine: string | null
  startedAt: Date | null
  endedAt: Date | null
  /** So a no-show doesn't render as a match somebody actually played. */
  resultType: 'normal' | 'bye' | 'walkover' | 'retired' | 'cancelled'
}

export type PublicTableRow = {
  teamId: string
  name: string
  players: string[]
  played: number
  won: number
  pointsFor: number
  withdrawn: boolean
  /** Why this row sits where it does, when wins and points did not decide it. */
  note: string | null
}

export type PublicCourt = { id: string; name: string; colorKey: string }

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

/**
 * The instant a `reported` result stops counting as provisional. Both halves of
 * the version number are derived from this one value — the page counts rows in
 * JS, the poll endpoint counts them in SQL, and taking the boundary from the
 * application clock in both is what keeps the two answers identical.
 */
function settledBefore(): Date {
  return new Date(Date.now() - AUTO_CONFIRM_MINUTES * 60_000)
}

/** What the poll endpoint answers. Unpublished tournaments are not public. */
export async function publicVersion(slug: string): Promise<number | null> {
  const cutoff = settledBefore()
  const [row] = await db
    .select({
      v: tournaments.streamVersion,
      publishedAt: tournaments.publishedAt,
      // Written out rather than composed from column references: drizzle drops
      // the table prefix on a column inside a raw fragment, and a correlated
      // subquery is exactly where the prefix carries the meaning.
      settled: sql<number>`(
        select count(*)::int from "matches"
        where "matches"."tournament_id" = "tournaments"."id"
          and "matches"."result_state" = 'reported'
          and "matches"."reported_at" is not null
          and "matches"."reported_at" <= ${cutoff.toISOString()}::timestamptz
      )`,
    })
    .from(tournaments)
    .where(and(eq(tournaments.slug, slug), isNull(tournaments.deletedAt)))
    .limit(1)
  if (!row || !row.publishedAt) return null

  return Number(row.v) + row.settled
}

/**
 * Everything the public page shows, in two round trips.
 *
 * Memoised per request because Next calls this twice for one page view — once
 * for `generateMetadata` and once for the render.
 *
 * Inside, only the tournament lookup has to happen first; the reads that hang
 * off it are independent of each other and are issued together, so the driver
 * pipelines them down the single connection instead of paying a round trip
 * each.
 */
export const publicTournament = cache(async function publicTournament(slug: string) {
  const [tournament] = await db
    .select({
      id: tournaments.id,
      name: tournaments.name,
      slug: tournaments.slug,
      startDate: tournaments.startDate,
      status: tournaments.status,
      pauseNote: tournaments.pauseNote,
      registrationClosedAt: tournaments.registrationClosedAt,
      publishedAt: tournaments.publishedAt,
      updatedAt: tournaments.updatedAt,
      streamVersion: tournaments.streamVersion,
    })
    .from(tournaments)
    .where(and(eq(tournaments.slug, slug), isNull(tournaments.deletedAt)))
    .limit(1)
  if (!tournament || !tournament.publishedAt) return null

  const [[category], teamRows, memberRows, matchRows, gameRows, courtRows, rosterRows] =
    await Promise.all([
      db
        .select({
          id: categories.id,
          discipline: categories.discipline,
          finalsStage: categories.finalsStage,
          advancePerGroup: categories.advancePerGroup,
          tiebreakRule: categories.tiebreakRule,
        })
        .from(categories)
        .where(and(eq(categories.tournamentId, tournament.id), isNull(categories.deletedAt)))
        .orderBy(asc(categories.seq))
        .limit(1),

      db
        .select({ id: teams.id, name: teams.name, status: teams.status, seed: teams.seed })
        .from(teams)
        .innerJoin(categories, eq(categories.id, teams.categoryId))
        .where(eq(categories.tournamentId, tournament.id))
        .orderBy(asc(teams.seed)),

      // Ordered by position, not left to the query plan. `team_players.position`
      // is what "Ravi / Priya" was generated from, so a team whose two names
      // come back the other way round reads as a different pair to the person
      // looking for themselves on the page.
      db
        .select({ teamId: teamPlayers.teamId, name: players.name })
        .from(teamPlayers)
        .innerJoin(players, eq(players.id, teamPlayers.playerId))
        .innerJoin(teams, eq(teams.id, teamPlayers.teamId))
        .innerJoin(categories, eq(categories.id, teams.categoryId))
        .where(eq(categories.tournamentId, tournament.id))
        .orderBy(asc(teamPlayers.position)),

      // Named columns, not the whole row: a match carries forty columns of
      // scheduling and audit state that the public page never reads.
      db
        .select({
          m: {
            id: matches.id,
            stage: matches.stage,
            roundName: matches.roundName,
            teamAId: matches.teamAId,
            teamBId: matches.teamBId,
            status: matches.status,
            resultState: matches.resultState,
            resultType: matches.resultType,
            reportedAt: matches.reportedAt,
            winnerTeamId: matches.winnerTeamId,
            gamesWonA: matches.gamesWonA,
            gamesWonB: matches.gamesWonB,
            courtId: matches.courtId,
            startedAt: matches.startedAt,
            endedAt: matches.endedAt,
          },
          courtName: courts.name,
          courtColor: courts.colorKey,
        })
        .from(matches)
        .leftJoin(courts, eq(courts.id, matches.courtId))
        .where(eq(matches.tournamentId, tournament.id))
        .orderBy(asc(matches.roundIndex), asc(matches.seq)),

      db
        .select({
          matchId: games.matchId,
          scoreA: games.scoreA,
          scoreB: games.scoreB,
          excludeFromDiff: games.excludeFromDiff,
          timeCapped: games.timeCapped,
        })
        .from(games)
        .innerJoin(matches, eq(matches.id, games.matchId))
        .where(eq(matches.tournamentId, tournament.id))
        .orderBy(asc(games.gameNo)),

      // The tournament's own courts, in venue order. "Courts 1, 2" in the
      // header and one card per court with a match on it.
      db
        .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
        .from(tournamentCourts)
        .innerJoin(courts, eq(courts.id, tournamentCourts.courtId))
        .where(eq(tournamentCourts.tournamentId, tournament.id))
        .orderBy(asc(courts.sortOrder)),

      // Names only. The roster row has a phone on it and this is the one
      // place it must never come through.
      db
        .select({ name: players.name })
        .from(tournamentPlayers)
        .innerJoin(players, eq(players.id, tournamentPlayers.playerId))
        .where(
          and(eq(tournamentPlayers.tournamentId, tournament.id), eq(tournamentPlayers.withdrawn, false)),
        )
        .orderBy(asc(players.name)),
    ])

  const teamName = new Map(teamRows.map((t) => [t.id, t.name]))
  const withdrawnTeams = new Set(
    teamRows.filter((t) => t.status === 'withdrawn' || t.status === 'disqualified').map((t) => t.id),
  )

  const membersByTeam = new Map<string, string[]>()
  for (const m of memberRows) {
    const list = membersByTeam.get(m.teamId) ?? []
    list.push(m.name)
    membersByTeam.set(m.teamId, list)
  }

  const gamesByMatch = new Map<string, typeof gameRows>()
  for (const g of gameRows) {
    const list = gamesByMatch.get(g.matchId) ?? []
    list.push(g)
    gamesByMatch.set(g.matchId, list)
  }

  const stateByMatch = new Map<string, PublicMatch['state']>()
  for (const r of matchRows) {
    stateByMatch.set(r.m.id, projectedState(r.m) as PublicMatch['state'])
  }

  const toPublicMatch = (r: (typeof matchRows)[number]): PublicMatch => {
    const state = stateByMatch.get(r.m.id)!
    const gs = gamesByMatch.get(r.m.id) ?? []
    const showScore = state === 'final' || state === 'reported'
    const winnerSide: PublicMatch['winnerSide'] = !showScore
      ? null
      : r.m.winnerTeamId === r.m.teamAId
        ? 'A'
        : r.m.winnerTeamId === r.m.teamBId
          ? 'B'
          : null
    return {
      id: r.m.id,
      stage: r.m.stage,
      roundName: r.m.roundName,
      teamAId: r.m.teamAId,
      teamBId: r.m.teamBId,
      nameA: r.m.teamAId ? (teamName.get(r.m.teamAId) ?? null) : null,
      nameB: r.m.teamBId ? (teamName.get(r.m.teamBId) ?? null) : null,
      playersA: r.m.teamAId ? (membersByTeam.get(r.m.teamAId) ?? []) : [],
      playersB: r.m.teamBId ? (membersByTeam.get(r.m.teamBId) ?? []) : [],
      courtId: r.m.courtId,
      courtName: r.courtName ?? null,
      courtColor: r.courtColor ?? null,
      status: r.m.status,
      state,
      gamesWonA: showScore ? r.m.gamesWonA : 0,
      gamesWonB: showScore ? r.m.gamesWonB : 0,
      winnerSide,
      // From the winner's side, the way a person says it: "we won 11–7".
      scoreLine:
        showScore && gs.length
          ? gs
              .map((g) => (winnerSide === 'B' ? `${g.scoreB}–${g.scoreA}` : `${g.scoreA}–${g.scoreB}`))
              .join(', ')
          : null,
      startedAt: r.m.startedAt,
      endedAt: r.m.endedAt,
      resultType: r.m.resultType as PublicMatch['resultType'],
    }
  }

  const allMatches = matchRows.map(toPublicMatch)

  const tableInput = matchRows
    .filter(
      (r) =>
        r.m.stage === 'group' && r.m.teamAId && r.m.teamBId && stateByMatch.get(r.m.id) !== 'none',
    )
    .map((r) => ({
      matchId: r.m.id,
      teamAId: r.m.teamAId!,
      teamBId: r.m.teamBId!,
      winnerTeamId: r.m.winnerTeamId,
      state: stateByMatch.get(r.m.id) as 'final' | 'reported' | 'disputed' | 'voided',
      resultType: r.m.resultType as PublicMatch['resultType'],
      games: (gamesByMatch.get(r.m.id) ?? []).map((g) => ({
        scoreA: g.scoreA,
        scoreB: g.scoreB,
        excludeFromDiff: g.excludeFromDiff,
        timeCapped: g.timeCapped,
      })),
    }))

  // A pair who pulled out are still in the table — their played matches
  // stand — but the row says so, or it gets argued about at the desk.
  const table: PublicTableRow[] = category
    ? standings(
        teamRows.map((t) => t.id),
        tableInput,
        category.tiebreakRule,
      ).map((row) => ({
        teamId: row.teamId,
        name: teamName.get(row.teamId) ?? '—',
        players: membersByTeam.get(row.teamId) ?? [],
        played: row.played,
        won: row.won,
        pointsFor: row.pointsFor,
        withdrawn: withdrawnTeams.has(row.teamId),
        note: tieNote(row.reason),
      }))
    : []

  // Once the final has been played the cut line has done its job.
  const finalDecided = allMatches.some((m) => m.stage === 'knockout' && m.winnerSide)

  const finalsStage = category?.finalsStage ?? 'none'
  return {
    tournament,
    discipline: category?.discipline ?? 'doubles',
    finalsStage,
    /** How many go through from the table; 0 when everyone just plays everyone. */
    cut: finalsStage === 'none' || finalDecided ? 0 : (category?.advancePerGroup ?? 0),
    courts: courtRows as PublicCourt[],
    players: rosterRows.map((r) => r.name),
    matches: allMatches,
    table,
    streamVersion: composeVersion(
      tournament.streamVersion,
      matchRows.map((r) => ({ resultState: r.m.resultState, reportedAt: r.m.reportedAt })),
    ),
  }
})

// ───────────────────────────── the venue's day ─────────────────────────────

export type TodayCourt = {
  id: string
  name: string
  colorKey: string
  /** Which tournament holds it today, if any. */
  tournament: { name: string; slug: string } | null
  /** The match on it right now. */
  live: { nameA: string | null; playersA: string[]; nameB: string | null; playersB: string[] } | null
}

export type TodayTournament = {
  slug: string
  name: string
  startDate: Date
  status: string
  pauseNote: string | null
  registrationOpen: boolean
  played: number
  total: number
}

/**
 * Which tournaments count as "today": anything dated today at the venue, plus
 * anything still running — a day that ran past midnight is still the day.
 * The same rule the organiser's dashboard uses.
 */
function publishedFilter() {
  return and(
    isNull(tournaments.deletedAt),
    isNotNull(tournaments.publishedAt),
    ne(tournaments.status, 'archived'),
  )
}

const isToday = (t: { startDate: Date; status: string }, todayKey: string) =>
  venueDayKey(t.startDate) === todayKey || t.status === 'live'

/**
 * The venue's day: every court, who holds it, what is on it, and a link to
 * each tournament. Someone at the gate sees every court regardless of which
 * tournament it belongs to.
 */
export async function publicToday() {
  const todayKey = venueDayKey(new Date())

  const [courtRows, tournamentRows] = await Promise.all([
    db
      .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
      .from(courts)
      .where(eq(courts.active, true))
      .orderBy(asc(courts.sortOrder)),
    db
      .select({
        id: tournaments.id,
        slug: tournaments.slug,
        name: tournaments.name,
        startDate: tournaments.startDate,
        status: tournaments.status,
        pauseNote: tournaments.pauseNote,
        registrationClosedAt: tournaments.registrationClosedAt,
        streamVersion: tournaments.streamVersion,
      })
      .from(tournaments)
      .where(publishedFilter())
      .orderBy(asc(tournaments.startDate), asc(tournaments.createdAt)),
  ])

  const today = tournamentRows.filter((t) => isToday(t, todayKey))
  const upcoming = tournamentRows
    .filter((t) => !isToday(t, todayKey) && venueDayKey(t.startDate) > todayKey)
    .slice(0, 3)
  const ids = today.map((t) => t.id)

  const [heldRows, liveRows, memberRows, aggRows] = ids.length
    ? await Promise.all([
        db
          .select({ courtId: tournamentCourts.courtId, tournamentId: tournamentCourts.tournamentId })
          .from(tournamentCourts)
          .where(inArray(tournamentCourts.tournamentId, ids)),
        db
          .select({
            courtId: matches.courtId,
            tournamentId: matches.tournamentId,
            teamAId: matches.teamAId,
            teamBId: matches.teamBId,
          })
          .from(matches)
          .where(and(inArray(matches.tournamentId, ids), eq(matches.status, 'live'))),
        db
          .select({ teamId: teamPlayers.teamId, name: players.name, teamName: teams.name })
          .from(teamPlayers)
          .innerJoin(players, eq(players.id, teamPlayers.playerId))
          .innerJoin(teams, eq(teams.id, teamPlayers.teamId))
          .innerJoin(categories, eq(categories.id, teams.categoryId))
          .where(inArray(categories.tournamentId, ids))
          .orderBy(asc(teamPlayers.position)),
        db
          .select({
            tournamentId: matches.tournamentId,
            total: sql<number>`cast(count(*) as int)`,
            played: sql<number>`cast(count(*) filter (where ${matches.resultState} in ('final','reported')) as int)`,
          })
          .from(matches)
          .where(inArray(matches.tournamentId, ids))
          .groupBy(matches.tournamentId),
      ])
    : [[], [], [], []]

  const byId = new Map(today.map((t) => [t.id, t]))
  // A finished tournament has let go of its courts — the same rule the
  // organiser's court picker uses.
  const heldBy = new Map(
    heldRows
      .filter((h) => byId.get(h.tournamentId)?.status !== 'completed')
      .map((h) => [h.courtId, h.tournamentId]),
  )
  const liveByCourt = new Map(liveRows.filter((l) => l.courtId).map((l) => [l.courtId!, l]))
  const teamName = new Map<string, string>()
  const membersByTeam = new Map<string, string[]>()
  for (const m of memberRows) {
    teamName.set(m.teamId, m.teamName)
    const list = membersByTeam.get(m.teamId) ?? []
    list.push(m.name)
    membersByTeam.set(m.teamId, list)
  }
  const agg = new Map(aggRows.map((a) => [a.tournamentId, a]))

  const courtList: TodayCourt[] = courtRows.map((c) => {
    // A court belongs to the tournament that holds it today; a live match
    // names the court too, and that wins when the two disagree, because the
    // match is what a person standing there can see.
    const live = liveByCourt.get(c.id)
    const holder = byId.get(live?.tournamentId ?? heldBy.get(c.id) ?? '')
    return {
      id: c.id,
      name: c.name,
      colorKey: c.colorKey,
      tournament: holder ? { name: holder.name, slug: holder.slug } : null,
      live: live
        ? {
            nameA: live.teamAId ? (teamName.get(live.teamAId) ?? null) : null,
            playersA: live.teamAId ? (membersByTeam.get(live.teamAId) ?? []) : [],
            nameB: live.teamBId ? (teamName.get(live.teamBId) ?? null) : null,
            playersB: live.teamBId ? (membersByTeam.get(live.teamBId) ?? []) : [],
          }
        : null,
    }
  })

  const toPublic = (t: (typeof tournamentRows)[number]): TodayTournament => ({
    slug: t.slug,
    name: t.name,
    startDate: t.startDate,
    status: t.status,
    pauseNote: t.pauseNote,
    registrationOpen: t.status === 'registration' && !t.registrationClosedAt,
    played: agg.get(t.id)?.played ?? 0,
    total: agg.get(t.id)?.total ?? 0,
  })

  return {
    dayKey: todayKey,
    courts: courtList,
    today: today.map(toPublic),
    upcoming: upcoming.map(toPublic),
    version: todayVersion(today),
  }
}

/**
 * One number for the whole day: the sum of today's stream versions, plus how
 * many tournaments there are, so one being deleted or another being started
 * moves it too. The poll endpoint computes it the same way.
 */
function todayVersion(rows: Array<{ streamVersion: number | string }>) {
  return rows.reduce((n, r) => n + Number(r.streamVersion), rows.length)
}

export async function publicTodayVersion(): Promise<number> {
  const todayKey = venueDayKey(new Date())
  const rows = await db
    .select({
      startDate: tournaments.startDate,
      status: tournaments.status,
      streamVersion: tournaments.streamVersion,
    })
    .from(tournaments)
    .where(publishedFilter())
  return todayVersion(rows.filter((t) => isToday(t, todayKey)))
}
