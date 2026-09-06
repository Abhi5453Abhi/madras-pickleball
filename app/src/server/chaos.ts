import 'server-only'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db, transact } from '@/db'
import {
  categories,
  games,
  matchSlots,
  matches,
  players,
  teamPlayers,
  teams,
  tournaments,
} from '@/db/schema'
import { bumpStreamVersion } from '@/lib/stream'
import { newId } from '@/lib/ids'
import { walkoverGames } from '@/lib/rules'
import { resolveSlotsFor, rulesFor } from './scoring'

/**
 * The things that actually go wrong — SPEC A7.
 *
 * Not edge cases. On any given Sunday somebody's knee goes, somebody's partner
 * is stuck on the ECR, and the light fails at six. A tournament tool that can
 * only record a day that went to plan is a toy, and the organiser goes back to
 * the WhatsApp group and a notebook.
 *
 * Every one of these is reversible, every one is attributed, and every one
 * writes a sentence a person can read six weeks later.
 */

export type WithdrawEffect = {
  /** Matches this pair had already played, which stand. */
  played: number
  /** Matches not yet played, which become walkovers to the other side. */
  toWalkover: number
  /** Downstream matches this cannot touch because they have started. */
  blocked: Array<{ id: string; roundName: string | null }>
  teamName: string
  categoryName: string
}

/**
 * What withdrawing a pair will do, before it does it. The organiser is standing
 * in front of the person asking, and "are you sure?" is not an answer.
 */
export async function withdrawalEffect(teamId: string): Promise<WithdrawEffect | null> {
  const [team] = await db
    .select({
      id: teams.id,
      name: teams.name,
      categoryId: teams.categoryId,
      categoryName: categories.name,
      tournamentId: categories.tournamentId,
    })
    .from(teams)
    .innerJoin(categories, eq(categories.id, teams.categoryId))
    .where(eq(teams.id, teamId))
    .limit(1)
  if (!team) return null

  const theirs = await db
    .select({
      id: matches.id,
      status: matches.status,
      resultState: matches.resultState,
      roundName: matches.roundName,
      stage: matches.stage,
    })
    .from(matches)
    .where(
      and(
        eq(matches.categoryId, team.categoryId),
        sql`(${matches.teamAId} = ${teamId} or ${matches.teamBId} = ${teamId})`,
      ),
    )

  const played = theirs.filter((m) => m.resultState !== 'none').length
  const remaining = theirs.filter((m) => m.resultState === 'none')

  // A match already on court is not ours to rewrite from the desk.
  const blocked = remaining
    .filter((m) => m.status === 'live')
    .map((m) => ({ id: m.id, roundName: m.roundName }))

  return {
    played,
    toWalkover: remaining.length - blocked.length,
    blocked,
    teamName: team.name,
    categoryName: team.categoryName,
  }
}

/**
 * Withdraw a pair. Matches they played stand; matches they had left become
 * walkovers to the other side — which count as a win and contribute nothing to
 * any difference column, so a pair who go home at lunch cannot decide the pool
 * on point difference for the people still playing (SPEC A6).
 */
export async function withdrawTeam(teamId: string) {
  const effect = await withdrawalEffect(teamId)
  if (!effect) return { ok: false as const, error: 'That pair is no longer in the draw.' }
  if (effect.blocked.length) {
    const names = effect.blocked.map((b) => b.roundName ?? 'a match').join(', ')
    return {
      ok: false as const,
      error: `${names} is on court right now. Take it off court first, or let it finish.`,
    }
  }

  const [team] = await db
    .select({ id: teams.id, categoryId: teams.categoryId, status: teams.status })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1)
  if (!team) return { ok: false as const, error: 'That pair is no longer in the draw.' }
  if (team.status === 'withdrawn') {
    return { ok: false as const, error: 'They are already marked as withdrawn.' }
  }

  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, team.categoryId))
    .limit(1)
  if (!category) return { ok: false as const, error: 'That category is gone.' }
  const rules = rulesFor(category)

  const remaining = await db
    .select({ id: matches.id, teamAId: matches.teamAId, teamBId: matches.teamBId })
    .from(matches)
    .where(
      and(
        eq(matches.categoryId, team.categoryId),
        eq(matches.resultState, 'none'),
        ne(matches.status, 'live'),
        sql`(${matches.teamAId} = ${teamId} or ${matches.teamBId} = ${teamId})`,
      ),
    )

  await transact(async (tx) => {
    await tx
      .update(teams)
      .set({ status: 'withdrawn', withdrawnAt: new Date() })
      .where(eq(teams.id, teamId))

    for (const m of remaining) {
      const opponentId = m.teamAId === teamId ? m.teamBId : m.teamAId
      await tx.delete(games).where(eq(games.matchId, m.id))

      if (!opponentId) {
        // Nobody to give it to — the match simply stops existing as a fixture.
        await tx
          .update(matches)
          .set({
            resultState: 'voided',
            resultType: 'cancelled',
            status: 'completed',
            endedAt: new Date(),
            courtId: null,
            version: sql`${matches.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(matches.id, m.id))
        continue
      }

      const winnerIsA = opponentId === m.teamAId
      const gs = walkoverGames(rules).map((g) =>
        winnerIsA ? g : { ...g, scoreA: g.scoreB, scoreB: g.scoreA },
      )
      await tx.insert(games).values(
        gs.map((g) => ({
          id: newId('gm'),
          matchId: m.id,
          gameNo: g.gameNo,
          scoreA: g.scoreA,
          scoreB: g.scoreB,
          completed: true,
          provisional: false,
          timeCapped: false,
          // A no-show is on the record and in no difference column at all.
          excludeFromDiff: true,
        })),
      )
      await tx
        .update(matches)
        .set({
          winnerTeamId: opponentId,
          resultType: 'walkover',
          resultState: 'final',
          status: 'completed',
          gamesWonA: winnerIsA ? gs.length : 0,
          gamesWonB: winnerIsA ? 0 : gs.length,
          scoreSummary: gs.map((g) => [g.scoreA, g.scoreB]),
          provisional: false,
          confirmedAt: new Date(),
          confirmedVia: 'admin',
          endedAt: new Date(),
          courtId: null,
          version: sql`${matches.version} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(matches.id, m.id))
    }
  })

  await resolveSlotsFor(team.categoryId)
  await bumpStreamVersion(category.tournamentId)
  return { ok: true as const, walkovers: remaining.length }
}

/** Put a withdrawn pair back. Their walkovers are undone, not left standing. */
export async function reinstateTeam(teamId: string) {
  const [team] = await db
    .select({ id: teams.id, categoryId: teams.categoryId, status: teams.status })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1)
  if (!team) return { ok: false as const, error: 'That pair is no longer in the draw.' }
  if (team.status !== 'withdrawn') {
    return { ok: false as const, error: 'They are not marked as withdrawn.' }
  }

  const [category] = await db
    .select({ tournamentId: categories.tournamentId })
    .from(categories)
    .where(eq(categories.id, team.categoryId))
    .limit(1)

  // Only the walkovers this withdrawal created come back — a match they
  // genuinely failed to turn up for earlier is a different fact.
  const created = await db
    .select({ id: matches.id })
    .from(matches)
    .where(
      and(
        eq(matches.categoryId, team.categoryId),
        eq(matches.resultType, 'walkover'),
        sql`(${matches.teamAId} = ${teamId} or ${matches.teamBId} = ${teamId})`,
        ne(matches.winnerTeamId, teamId),
      ),
    )

  await transact(async (tx) => {
    await tx
      .update(teams)
      .set({ status: 'active', withdrawnAt: null })
      .where(eq(teams.id, teamId))

    if (created.length) {
      await tx.delete(games).where(inArray(games.matchId, created.map((m) => m.id)))
      await tx
        .update(matches)
        .set({
          winnerTeamId: null,
          resultType: 'normal',
          resultState: 'none',
          status: 'ready',
          gamesWonA: 0,
          gamesWonB: 0,
          scoreSummary: [],
          confirmedAt: null,
          confirmedVia: null,
          endedAt: null,
          version: sql`${matches.version} + 1`,
          updatedAt: new Date(),
        })
        .where(inArray(matches.id, created.map((m) => m.id)))
    }
  })

  await resolveSlotsFor(team.categoryId)
  if (category) await bumpStreamVersion(category.tournamentId)
  return { ok: true as const, restored: created.length }
}

export type SubstituteTarget = {
  teamId: string
  teamName: string
  categoryId: string
  categoryName: string
  members: Array<{ id: string; name: string }>
}

/** Who could be swapped, and who is standing about who could come in. */
export async function substitutionOptions(tournamentId: string) {
  const teamRows = await db
    .select({
      teamId: teams.id,
      teamName: teams.name,
      categoryId: teams.categoryId,
      categoryName: categories.name,
      playerId: players.id,
      playerName: players.name,
    })
    .from(teams)
    .innerJoin(categories, eq(categories.id, teams.categoryId))
    .innerJoin(teamPlayers, eq(teamPlayers.teamId, teams.id))
    .innerJoin(players, eq(players.id, teamPlayers.playerId))
    .where(and(eq(categories.tournamentId, tournamentId), eq(teams.status, 'active')))
    .orderBy(categories.seq, teams.seed, teamPlayers.position)

  const byTeam = new Map<string, SubstituteTarget>()
  for (const r of teamRows) {
    const entry = byTeam.get(r.teamId) ?? {
      teamId: r.teamId,
      teamName: r.teamName,
      categoryId: r.categoryId,
      categoryName: r.categoryName,
      members: [],
    }
    entry.members.push({ id: r.playerId, name: r.playerName })
    byTeam.set(r.teamId, entry)
  }
  return [...byTeam.values()]
}

/**
 * Swap one player for another, mid-day — SPEC A7.
 *
 * The team keeps its identity: its results, its place in the table and its
 * position in the draw all stand. Only the name changes, and the name changes
 * everywhere at once, because a pair called "Ravi / Priya" on the board and
 * "Ravi / Meera" on the public page is how an argument starts.
 */
export async function substitutePlayer(input: {
  teamId: string
  outPlayerId: string
  inPlayerId: string
}) {
  const [team] = await db
    .select({ id: teams.id, categoryId: teams.categoryId, name: teams.name })
    .from(teams)
    .where(eq(teams.id, input.teamId))
    .limit(1)
  if (!team) return { ok: false as const, error: 'That pair is no longer in the draw.' }

  const [category] = await db
    .select({ tournamentId: categories.tournamentId })
    .from(categories)
    .where(eq(categories.id, team.categoryId))
    .limit(1)
  if (!category) return { ok: false as const, error: 'That category is gone.' }

  const members = await db
    .select({ playerId: teamPlayers.playerId, position: teamPlayers.position })
    .from(teamPlayers)
    .where(eq(teamPlayers.teamId, input.teamId))
  const leaving = members.find((m) => m.playerId === input.outPlayerId)
  if (!leaving) return { ok: false as const, error: 'That player is not in this pair.' }
  if (members.some((m) => m.playerId === input.inPlayerId)) {
    return { ok: false as const, error: 'They are already in this pair.' }
  }

  const [incoming] = await db
    .select({ id: players.id, name: players.name })
    .from(players)
    .where(and(eq(players.id, input.inPlayerId), isNull(players.deletedAt)))
    .limit(1)
  if (!incoming) return { ok: false as const, error: 'That player is not on the roster.' }

  // Nobody plays for two pairs in the same category — that is the double-booking
  // the board exists to prevent, arriving through a different door.
  const clash = await db
    .select({ teamId: teams.id, name: teams.name })
    .from(teamPlayers)
    .innerJoin(teams, eq(teams.id, teamPlayers.teamId))
    .where(
      and(
        eq(teams.categoryId, team.categoryId),
        eq(teamPlayers.playerId, input.inPlayerId),
        ne(teams.id, input.teamId),
      ),
    )
    .limit(1)
  if (clash.length) {
    return {
      ok: false as const,
      error: `${incoming.name} is already playing for ${clash[0].name} in this category.`,
    }
  }

  const roster = await db
    .select({ playerId: teamPlayers.playerId, name: players.name, position: teamPlayers.position })
    .from(teamPlayers)
    .innerJoin(players, eq(players.id, teamPlayers.playerId))
    .where(eq(teamPlayers.teamId, input.teamId))
    .orderBy(teamPlayers.position)

  const newName = roster
    .map((r) => (r.playerId === input.outPlayerId ? incoming.name : r.name))
    .join(' / ')

  await transact(async (tx) => {
    await tx
      .update(teamPlayers)
      .set({ playerId: input.inPlayerId })
      .where(
        and(
          eq(teamPlayers.teamId, input.teamId),
          eq(teamPlayers.playerId, input.outPlayerId),
        ),
      )
    await tx.update(teams).set({ name: newName }).where(eq(teams.id, input.teamId))
  })

  await bumpStreamVersion(category.tournamentId)
  return { ok: true as const, name: newName, incoming: incoming.name }
}

/**
 * Stop the clock — SPEC A7. Rain, a missing net, lunch. The public page says so
 * rather than leaving forty people looking at a board that has not moved.
 */
export async function pauseDay(tournamentId: string, note: string) {
  await db
    .update(tournaments)
    .set({ pauseNote: note.trim() || 'Paused', breakStartsAt: new Date() })
    .where(eq(tournaments.id, tournamentId))
  await bumpStreamVersion(tournamentId)
  return { ok: true as const }
}

export async function resumeDay(tournamentId: string) {
  await db
    .update(tournaments)
    .set({ pauseNote: null, breakStartsAt: null })
    .where(eq(tournaments.id, tournamentId))
  await bumpStreamVersion(tournamentId)
  return { ok: true as const }
}

/**
 * Shorten what is left — the most-used emergency tool there is, because the sun
 * sets at a fixed time and a day that started late cannot get the hours back.
 *
 * Only matches with no result are touched: rewriting the format of a match
 * already played would change what its score meant after the fact.
 */
export async function shortenFormat(
  categoryId: string,
  shape: { bestOf: number; pointsToWin: number; winBy?: number },
) {
  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1)
  if (!category) return { ok: false as const, error: 'That category is gone.' }
  if (shape.bestOf !== 1 && shape.bestOf !== 3) {
    return { ok: false as const, error: 'A match is best of one or best of three.' }
  }
  if (shape.pointsToWin < 7 || shape.pointsToWin > 21) {
    return { ok: false as const, error: 'Games run to between 7 and 21.' }
  }

  const live = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.categoryId, categoryId), eq(matches.status, 'live')))
    .limit(1)
  if (live.length) {
    return {
      ok: false as const,
      error: 'A match in this category is on court. Change it when that one finishes.',
    }
  }

  await db
    .update(categories)
    .set({
      bestOf: shape.bestOf,
      pointsToWin: shape.pointsToWin,
      winBy: shape.winBy ?? category.winBy,
    })
    .where(eq(categories.id, categoryId))

  await bumpStreamVersion(category.tournamentId)
  return { ok: true as const }
}

/** Void a match outright — it counts for nothing and nobody. */
export async function voidMatch(matchId: string) {
  const [match] = await db
    .select({
      id: matches.id,
      tournamentId: matches.tournamentId,
      categoryId: matches.categoryId,
      status: matches.status,
    })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)
  if (!match) return { ok: false as const, error: 'That match no longer exists.' }
  if (match.status === 'live') {
    return { ok: false as const, error: 'That match is on court. Take it off court first.' }
  }

  const dependents = await db
    .select({ matchId: matchSlots.matchId, status: matches.status, roundName: matches.roundName })
    .from(matchSlots)
    .innerJoin(matches, eq(matches.id, matchSlots.matchId))
    .where(eq(matchSlots.sourceMatchId, matchId))
  const started = dependents.filter((d) => d.status === 'live' || d.status === 'completed')
  if (started.length) {
    const names = started.map((d) => d.roundName ?? 'a later match').join(', ')
    return {
      ok: false as const,
      error: `${names} was built off this result. Sort that one out first.`,
    }
  }

  await transact(async (tx) => {
    await tx.delete(games).where(eq(games.matchId, matchId))
    await tx
      .update(matches)
      .set({
        resultState: 'voided',
        resultType: 'cancelled',
        status: 'completed',
        winnerTeamId: null,
        gamesWonA: 0,
        gamesWonB: 0,
        scoreSummary: [],
        courtId: null,
        endedAt: new Date(),
        version: sql`${matches.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, matchId))
  })

  await resolveSlotsFor(match.categoryId)
  await bumpStreamVersion(match.tournamentId)
  return { ok: true as const }
}
