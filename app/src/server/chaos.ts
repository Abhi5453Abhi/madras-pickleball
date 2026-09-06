import 'server-only'
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db, transact } from '@/db'
import {
  categories,
  courts,
  games,
  groups,
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
import { flowTournament } from './board'
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
  /** Matches they were pencilled into that simply lose their name again. */
  vacates: number
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
      teamAId: matches.teamAId,
      teamBId: matches.teamBId,
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

  // A match still waiting on another result has nobody to give a walkover to —
  // the pair just comes off the slot. Counting it as a walkover made the
  // confirm promise something that would not happen.
  const openSlot = remaining.filter(
    (m) => m.status !== 'live' && !(m.teamAId && m.teamBId),
  ).length

  return {
    played,
    toWalkover: remaining.length - blocked.length - openSlot,
    vacates: openSlot,
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

      if (!opponentId) {
        // A knockout match with one slot still unresolved — a final waiting on
        // the other semi. Cancelling it was catastrophic: the category ended
        // with no final and no champion, the other semi's winner was written
        // into a match marked cancelled, and no screen could undo it. The
        // withdrawing pair simply comes off the slot and it re-resolves.
        await tx
          .update(matchSlots)
          .set({ resolvedTeamId: null, resolvedAt: null })
          .where(and(eq(matchSlots.matchId, m.id), eq(matchSlots.resolvedTeamId, teamId)))
        await tx
          .update(matches)
          .set({
            ...(m.teamAId === teamId ? { teamAId: null } : { teamBId: null }),
            status: 'pending',
            version: sql`${matches.version} + 1`,
            updatedAt: new Date(),
          })
          .where(eq(matches.id, m.id))
        continue
      }

      await tx.delete(games).where(eq(games.matchId, m.id))
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
        // The state was read before the transaction opened. Re-asserting it in
        // the WHERE is what stops a score submitted from the court card in
        // between being silently overwritten by a generated walkover.
        .where(
          and(
            eq(matches.id, m.id),
            eq(matches.resultState, 'none'),
            ne(matches.status, 'live'),
          ),
        )
    }
  })

  await resolveSlotsFor(team.categoryId)
  await bumpStreamVersion(category.tournamentId)
  return { ok: true as const, walkovers: remaining.length }
}

/** Put a withdrawn pair back. Their walkovers are undone, not left standing. */
export async function reinstateTeam(teamId: string) {
  const [team] = await db
    .select({
      id: teams.id,
      categoryId: teams.categoryId,
      status: teams.status,
      withdrawnAt: teams.withdrawnAt,
    })
    .from(teams)
    .where(eq(teams.id, teamId))
    .limit(1)
  if (!team) return { ok: false as const, error: 'That pair is no longer in the draw.' }
  if (team.status !== 'withdrawn') {
    return { ok: false as const, error: 'They are not marked as withdrawn.' }
  }
  const withdrawnAt = team.withdrawnAt

  const [category] = await db
    .select({ tournamentId: categories.tournamentId })
    .from(categories)
    .where(eq(categories.id, team.categoryId))
    .limit(1)

  // Only the walkovers THIS withdrawal created come back. A match they
  // genuinely failed to turn up for at half nine is a different fact, and
  // undoing it takes a win off the pair who did turn up.
  const since = withdrawnAt
  const created = since
    ? await db
        .select({ id: matches.id })
        .from(matches)
        .where(
          and(
            eq(matches.categoryId, team.categoryId),
            eq(matches.resultType, 'walkover'),
            sql`(${matches.teamAId} = ${teamId} or ${matches.teamBId} = ${teamId})`,
            ne(matches.winnerTeamId, teamId),
            sql`${matches.updatedAt} >= ${since}`,
          ),
        )
    : []

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

  // And not onto a court they are already standing on. `livePlayerConflict`
  // only runs when a match is SENT to a court; a substitution reaches the same
  // state through a different door, and the unique index guards courts, not
  // people.
  const onCourt = await db
    .select({ courtName: courts.name })
    .from(matches)
    .innerJoin(teams, sql`${teams.id} = ${matches.teamAId} or ${teams.id} = ${matches.teamBId}`)
    .innerJoin(teamPlayers, eq(teamPlayers.teamId, teams.id))
    .leftJoin(courts, eq(courts.id, matches.courtId))
    .where(
      and(
        eq(matches.tournamentId, category.tournamentId),
        eq(matches.status, 'live'),
        eq(teamPlayers.playerId, input.inPlayerId),
      ),
    )
    .limit(1)
  if (onCourt.length) {
    return {
      ok: false as const,
      error: `${incoming.name} is on ${onCourt[0].courtName ?? 'a court'} right now.`,
    }
  }

  // Nor into a pair that is mid-match: renaming a side while it is being
  // played is how the board and the public page end up disagreeing.
  const theirsLive = await db
    .select({ courtName: courts.name })
    .from(matches)
    .leftJoin(courts, eq(courts.id, matches.courtId))
    .where(
      and(
        eq(matches.status, 'live'),
        sql`(${matches.teamAId} = ${input.teamId} or ${matches.teamBId} = ${input.teamId})`,
      ),
    )
    .limit(1)
  if (theirsLive.length) {
    return {
      ok: false as const,
      error: `That pair is on ${theirsLive[0].courtName ?? 'a court'}. Swap them when the match finishes.`,
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
  // Nothing went on while it was stopped; the free courts fill again now.
  await flowTournament(tournamentId)
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

  // Anything fed by this match — including, for a group match, everything fed
  // by the TABLE it sits in. A league builds its semis and final from
  // `group_rank` slots with a null source_match_id, so looking only at
  // source_match_id let a group match feeding a live semi-final be cancelled
  // with no refusal at all. This is the same hole `correctionBlockers` was
  // fixed for; it had not been closed here.
  const { started } = await dependentsOf(matchId, match.categoryId)
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
      // Re-asserted here: the status was read before the transaction opened,
      // and a match sent to a court in between must not be ended from the desk.
      .where(and(eq(matches.id, matchId), ne(matches.status, 'live')))
  })

  await resolveSlotsFor(match.categoryId)
  await bumpStreamVersion(match.tournamentId)
  return { ok: true as const }
}

/** Matches downstream of this one that have already started. */
async function dependentsOf(matchId: string, categoryId: string) {
  const [self] = await db
    .select({ stage: matches.stage, groupId: matches.groupId })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)

  const ids = new Set<string>()
  for (const d of await db
    .select({ matchId: matchSlots.matchId })
    .from(matchSlots)
    .where(eq(matchSlots.sourceMatchId, matchId))) {
    ids.add(d.matchId)
  }

  if (self?.stage === 'group') {
    const groupIds = self.groupId
      ? [self.groupId]
      : (
          await db
            .select({ id: groups.id })
            .from(groups)
            .where(eq(groups.categoryId, categoryId))
        ).map((g) => g.id)
    if (groupIds.length) {
      for (const d of await db
        .select({ matchId: matchSlots.matchId })
        .from(matchSlots)
        .where(
          and(
            eq(matchSlots.sourceType, 'group_rank'),
            inArray(matchSlots.sourceGroupId, groupIds),
          ),
        )) {
        ids.add(d.matchId)
      }
    }
  }
  ids.delete(matchId)
  if (ids.size === 0) return { started: [] as Array<{ roundName: string | null }> }

  const rows = await db
    .select({ id: matches.id, roundName: matches.roundName, status: matches.status })
    .from(matches)
    .where(inArray(matches.id, [...ids]))
  return { started: rows.filter((r) => r.status === 'live' || r.status === 'completed') }
}
