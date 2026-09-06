import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  categories,
  games,
  groups,
  matchConfirmations,
  matchSlots,
  matches,
  resultSubmissions,
  syncConflicts,
  teams,
} from '@/db/schema'
import { newId } from '@/lib/ids'
import { sha256Hex } from '@/lib/crypto'
import { bumpStreamVersion } from '@/lib/stream'
import { recordAudit } from '@/lib/audit'
import {
  DEFAULT_RULES,
  matchOutcome,
  validateGames,
  type GameScore,
  type ScoringRules,
} from '@/lib/rules'
import { standings, type StandingsMatch } from '@/lib/standings'

/**
 * Results — SPEC A5.
 *
 * `result_submissions` is the inbox, `games` is the ledger. A reported result
 * writes a PROVISIONAL ledger row: standings, the bracket and the finish
 * estimate all include it and label it, because without provisional
 * advancement the tournament stalls at 2pm waiting for confirmations nobody
 * remembers to give. Only `disputed` is excluded.
 */

export const AUTO_CONFIRM_MINUTES = 10

export type ResultType = 'normal' | 'walkover' | 'retired'

export function rulesFor(category: {
  bestOf: number
  pointsToWin: number
  winBy: number
  hardCap: number | null
}): ScoringRules {
  return {
    bestOf: category.bestOf,
    pointsToWin: category.pointsToWin,
    winBy: category.winBy,
    hardCap: category.hardCap,
  }
}

/** Agreement is one string comparison, never a JSONB compare. */
export function normalizedDigest(input: {
  resultType: ResultType
  winnerTeamId: string | null
  games: GameScore[]
}) {
  const canonical = [
    input.resultType,
    input.winnerTeamId ?? '-',
    ...[...input.games]
      .sort((a, b) => a.gameNo - b.gameNo)
      .map((g) => `${g.gameNo}:${g.scoreA}-${g.scoreB}${g.timeCapped ? 'T' : ''}`),
  ].join('|')
  return sha256Hex(canonical)
}

export async function getMatchForScoring(matchId: string) {
  const rows = await db
    .select({
      match: matches,
      category: categories,
    })
    .from(matches)
    .innerJoin(categories, eq(categories.id, matches.categoryId))
    .where(eq(matches.id, matchId))
    .limit(1)
  if (!rows[0]) return null

  const { match, category } = rows[0]
  const sides = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, [match.teamAId, match.teamBId].filter(Boolean) as string[]))

  const existingGames = await db
    .select()
    .from(games)
    .where(eq(games.matchId, matchId))
    .orderBy(asc(games.gameNo))

  const submissions = await db
    .select()
    .from(resultSubmissions)
    .where(and(eq(resultSubmissions.matchId, matchId), eq(resultSubmissions.status, 'active')))

  return {
    match,
    category,
    rules: rulesFor(category),
    nameA: sides.find((s) => s.id === match.teamAId)?.name ?? null,
    nameB: sides.find((s) => s.id === match.teamBId)?.name ?? null,
    games: existingGames,
    submissions,
  }
}

/**
 * Provisional is always DERIVED, never read from the stored flag: a result that
 * auto-confirmed at the ten-minute mark would otherwise stay labelled
 * provisional until someone happened to touch it.
 */
export function isProvisional(match: {
  resultState: string
  reportedAt: Date | null
}): boolean {
  if (match.resultState !== 'reported') return false
  if (!match.reportedAt) return true
  return Date.now() < match.reportedAt.getTime() + AUTO_CONFIRM_MINUTES * 60_000
}

/** What the world should treat this match as, right now. */
export function projectedState(match: { resultState: string; reportedAt: Date | null }) {
  if (match.resultState === 'reported' && !isProvisional(match)) return 'final'
  return match.resultState
}

async function writeLedger(
  matchId: string,
  gameScores: GameScore[],
  opts: {
    resultType: ResultType
    winnerTeamId: string | null
    provisional: boolean
    excludeFromDiff?: number[]
    retiredTeamId?: string | null
  },
) {
  await db.delete(games).where(eq(games.matchId, matchId))
  const exclude = new Set(opts.excludeFromDiff ?? [])
  const walkover = opts.resultType === 'walkover'

  if (gameScores.length) {
    await db.insert(games).values(
      gameScores.map((g) => ({
        id: newId('gm'),
        matchId,
        gameNo: g.gameNo,
        scoreA: g.scoreA,
        scoreB: g.scoreB,
        completed: true,
        provisional: opts.provisional,
        timeCapped: !!g.timeCapped,
        // A walkover records a scoreline for the record and contributes
        // nothing to any difference column (SPEC A6).
        excludeFromDiff: walkover || exclude.has(g.gameNo) || !!g.timeCapped,
      })),
    )
  }

  let gamesWonA = 0
  let gamesWonB = 0
  for (const g of gameScores) {
    if (g.scoreA > g.scoreB) gamesWonA++
    else if (g.scoreB > g.scoreA) gamesWonB++
  }

  await db
    .update(matches)
    .set({
      gamesWonA,
      gamesWonB,
      scoreSummary: gameScores.map((g) => [g.scoreA, g.scoreB]),
      winnerTeamId: opts.winnerTeamId,
      retiredTeamId: opts.retiredTeamId ?? null,
      resultType: opts.resultType,
      provisional: opts.provisional,
      status: 'completed',
      endedAt: new Date(),
      // court_id is deliberately kept: the unique index only guards `live`, and
      // the court's own QR must still reach the match to confirm it.
      version: sql`${matches.version} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(matches.id, matchId))
}

export type SubmitInput = {
  matchId: string
  games: GameScore[]
  resultType: ResultType
  winnerTeamId: string | null
  retiredTeamId?: string | null
  excludeFromDiff?: number[]
  submittingTeamId: string | null
  attributorKey: string
  actorType: 'court_token' | 'umpire_pin' | 'user' | 'live_scoring'
  deviceId?: string | null
  userId?: string | null
  clientEventId: string
  /** An admin or umpire submission is authoritative and skips the wait. */
  authoritative?: boolean
}

export type SubmitResult =
  | { ok: true; state: 'reported' | 'final' | 'disputed' }
  | { ok: false; error: string }

export async function submitResult(input: SubmitInput): Promise<SubmitResult> {
  const loaded = await getMatchForScoring(input.matchId)
  if (!loaded) return { ok: false, error: 'That match no longer exists.' }
  const { match, rules } = loaded

  if (match.resultState === 'final' && !input.authoritative) {
    // Never silently discarded — the admin should be able to see that someone
    // tried to submit at 15:04 (SPEC A7).
    await db.insert(syncConflicts).values({
      id: newId('sc'),
      matchId: match.id,
      deviceId: input.deviceId ?? null,
      payload: { games: input.games, resultType: input.resultType },
      reason: 'submitted after the result was final',
    })
    return { ok: false, error: 'That result is already final. Tell the organiser.' }
  }

  if (input.resultType === 'normal') {
    const v = validateGames(rules, input.games)
    if (!v.ok && !input.authoritative) return { ok: false, error: v.reason }
  }

  const digest = normalizedDigest({
    resultType: input.resultType,
    winnerTeamId: input.winnerTeamId,
    games: input.games,
  })

  // One live submission per source, enforced by a unique index rather than by
  // app logic. A second submission from the same source supersedes; it never
  // disputes with itself.
  await db
    .update(resultSubmissions)
    .set({ status: 'superseded' })
    .where(
      and(
        eq(resultSubmissions.matchId, match.id),
        eq(resultSubmissions.attributorKey, input.attributorKey),
        eq(resultSubmissions.status, 'active'),
      ),
    )

  const submissionId = newId('sub')
  await db.insert(resultSubmissions).values({
    id: submissionId,
    matchId: match.id,
    attributorKey: input.attributorKey,
    actorType: input.actorType,
    userId: input.userId ?? null,
    deviceId: input.deviceId ?? null,
    submittingTeamId: input.submittingTeamId,
    games: input.games,
    resultType: input.resultType,
    retiredTeamId: input.retiredTeamId ?? null,
    winnerTeamId: input.winnerTeamId,
    normalizedDigest: digest,
    clientEventId: input.clientEventId,
  })

  const others = await db
    .select()
    .from(resultSubmissions)
    .where(
      and(
        eq(resultSubmissions.matchId, match.id),
        eq(resultSubmissions.status, 'active'),
        sql`${resultSubmissions.attributorKey} <> ${input.attributorKey}`,
      ),
    )

  const agreeing = others.find(
    (o) =>
      o.normalizedDigest === digest &&
      // Independence needs a different source AND a different declared side —
      // two members of one team on two phones are not two sides.
      (!o.submittingTeamId ||
        !input.submittingTeamId ||
        o.submittingTeamId !== input.submittingTeamId),
  )
  const disagreeing = others.find((o) => o.normalizedDigest !== digest)

  let state: 'reported' | 'final' | 'disputed' = 'reported'
  if (input.authoritative || agreeing) state = 'final'
  else if (disagreeing) state = 'disputed'

  await writeLedger(match.id, input.games, {
    resultType: input.resultType,
    winnerTeamId: input.winnerTeamId,
    retiredTeamId: input.retiredTeamId ?? null,
    excludeFromDiff: input.excludeFromDiff,
    provisional: state !== 'final',
  })

  await db
    .update(matches)
    .set({
      resultState: state,
      reportedAt: match.reportedAt ?? new Date(),
      confirmedAt: state === 'final' ? new Date() : null,
      confirmedVia: state === 'final' ? (input.authoritative ? 'admin' : 'agreement') : null,
      disputeOpenedAt: state === 'disputed' ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(matches.id, match.id))

  if (agreeing) {
    await db.insert(matchConfirmations).values({
      id: newId('cf'),
      matchId: match.id,
      submissionId: agreeing.id,
      attributorKey: input.attributorKey,
      agreedForTeamId: input.submittingTeamId,
      digest,
      confidence: 'normal',
      deviceId: input.deviceId ?? null,
    })
  }

  // A disputed match blocks advancement; anything else propagates.
  if (state !== 'disputed') await resolveSlotsFor(match.categoryId)
  await bumpStreamVersion(match.tournamentId)

  return { ok: true, state }
}

/**
 * The hand-the-phone path: the losing side taps Agree on the same device.
 * Recorded at low confidence, which is honest — this is a labour-saving device
 * that spares the admin sixty confirmations, not an integrity mechanism.
 */
export async function confirmOnSameDevice(input: {
  matchId: string
  attributorKey: string
  agreedForTeamId: string | null
  deviceId?: string | null
}) {
  const loaded = await getMatchForScoring(input.matchId)
  if (!loaded) return { ok: false as const, error: 'That match no longer exists.' }
  const sub = loaded.submissions[0]
  if (!sub) return { ok: false as const, error: 'There is no score to agree with yet.' }

  await db.insert(matchConfirmations).values({
    id: newId('cf'),
    matchId: input.matchId,
    submissionId: sub.id,
    attributorKey: input.attributorKey,
    agreedForTeamId: input.agreedForTeamId,
    digest: sub.normalizedDigest,
    confidence: 'low',
    deviceId: input.deviceId ?? null,
  })

  await db
    .update(matches)
    .set({
      resultState: 'final',
      confirmedAt: new Date(),
      confirmedVia: 'agreement',
      provisional: false,
      updatedAt: new Date(),
    })
    .where(eq(matches.id, input.matchId))
  await db.update(games).set({ provisional: false }).where(eq(games.matchId, input.matchId))

  await resolveSlotsFor(loaded.match.categoryId)
  await bumpStreamVersion(loaded.match.tournamentId)
  return { ok: true as const }
}

/** "Not right" from the losing side. Blocks advancement until an organiser rules. */
export async function raiseDispute(matchId: string, note?: string) {
  const loaded = await getMatchForScoring(matchId)
  if (!loaded) return
  await db
    .update(matches)
    .set({ resultState: 'disputed', disputeOpenedAt: new Date(), updatedAt: new Date() })
    .where(eq(matches.id, matchId))
  await db.insert(syncConflicts).values({
    id: newId('sc'),
    matchId,
    payload: { note: note ?? null },
    reason: 'disputed at the net',
  })
  await bumpStreamVersion(loaded.match.tournamentId)
}

/** Confirms everything sitting in `reported` — the admin's batch action. */
export async function confirmAllPending(tournamentId: string) {
  const pending = await db
    .select({ id: matches.id, categoryId: matches.categoryId })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.resultState, 'reported')))

  for (const m of pending) {
    await db
      .update(matches)
      .set({
        resultState: 'final',
        confirmedAt: new Date(),
        confirmedVia: 'admin',
        provisional: false,
        updatedAt: new Date(),
      })
      .where(eq(matches.id, m.id))
    await db.update(games).set({ provisional: false }).where(eq(games.matchId, m.id))
    await resolveSlotsFor(m.categoryId)
  }
  await bumpStreamVersion(tournamentId)
  return pending.length
}

/**
 * Fill in slots whose source has become known: the winner of an earlier match,
 * or a finishing position in a group whose matches are all in.
 */
export async function resolveSlotsFor(categoryId: string) {
  const [category] = await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1)
  if (!category) return

  const catMatches = await db.select().from(matches).where(eq(matches.categoryId, categoryId))
  const byId = new Map(catMatches.map((m) => [m.id, m]))
  const slots = await db
    .select()
    .from(matchSlots)
    .where(inArray(matchSlots.matchId, catMatches.map((m) => m.id)))

  // Group tables, computed only where every group match has a result.
  const groupRows = await db.select().from(groups).where(eq(groups.categoryId, categoryId))
  const teamRows = await db.select().from(teams).where(eq(teams.categoryId, categoryId))
  const gameRows = catMatches.length
    ? await db.select().from(games).where(inArray(games.matchId, catMatches.map((m) => m.id)))
    : []
  const gamesByMatch = new Map<string, typeof gameRows>()
  for (const g of gameRows) {
    const list = gamesByMatch.get(g.matchId) ?? []
    list.push(g)
    gamesByMatch.set(g.matchId, list)
  }

  const rankedByGroup = new Map<string, string[]>()
  for (const group of groupRows) {
    const groupTeams = teamRows.filter((t) => t.groupId === group.id).map((t) => t.id)
    const groupMatches = catMatches.filter(
      (m) => m.stage === 'group' && m.groupId === group.id,
    )
    const allIn = groupMatches.every(
      (m) => m.resultState === 'final' || m.resultState === 'reported',
    )
    if (!allIn || groupTeams.length === 0) continue

    const input: StandingsMatch[] = groupMatches
      .filter((m) => m.teamAId && m.teamBId)
      .map((m) => ({
        matchId: m.id,
        teamAId: m.teamAId!,
        teamBId: m.teamBId!,
        winnerTeamId: m.winnerTeamId,
        state: m.resultState as StandingsMatch['state'],
        resultType: m.resultType as StandingsMatch['resultType'],
        games: (gamesByMatch.get(m.id) ?? [])
          .sort((x, y) => x.gameNo - y.gameNo)
          .map((g) => ({
            scoreA: g.scoreA,
            scoreB: g.scoreB,
            excludeFromDiff: g.excludeFromDiff,
          })),
      }))
    rankedByGroup.set(
      group.id,
      standings(groupTeams, input, category.tiebreakRule).map((r) => r.teamId),
    )
  }

  for (const slot of slots) {
    if (slot.resolvedTeamId) continue
    let teamId: string | null = null

    if (slot.sourceType === 'winner_of' && slot.sourceMatchId) {
      const src = byId.get(slot.sourceMatchId)
      if (src && (src.resultState === 'final' || src.resultState === 'reported')) {
        teamId = src.winnerTeamId
      }
    } else if (slot.sourceType === 'loser_of' && slot.sourceMatchId) {
      const src = byId.get(slot.sourceMatchId)
      if (src && src.winnerTeamId) {
        teamId = src.winnerTeamId === src.teamAId ? src.teamBId : src.teamAId
      }
    } else if (slot.sourceType === 'group_rank' && slot.sourceGroupId && slot.sourceRank) {
      teamId = rankedByGroup.get(slot.sourceGroupId)?.[slot.sourceRank - 1] ?? null
    }

    if (!teamId) continue

    await db
      .update(matchSlots)
      .set({ resolvedTeamId: teamId, resolvedAt: new Date() })
      .where(eq(matchSlots.id, slot.id))

    await db
      .update(matches)
      .set(
        slot.slot === 'A'
          ? { teamAId: teamId, updatedAt: new Date() }
          : { teamBId: teamId, updatedAt: new Date() },
      )
      .where(eq(matches.id, slot.matchId))
  }

  // A match with both slots filled becomes placeable.
  const refreshed = await db.select().from(matches).where(eq(matches.categoryId, categoryId))
  for (const m of refreshed) {
    if (m.status === 'pending' && m.teamAId && m.teamBId) {
      await db.update(matches).set({ status: 'ready' }).where(eq(matches.id, m.id))
    }
  }
}

/**
 * "Edit this match" — the universal escape hatch (SPEC A7). A correction is
 * refused while a downstream match has already started, and the blocking match
 * is named rather than the change simply failing.
 */
export async function correctionBlockers(matchId: string) {
  const dependents = await db
    .select({ matchId: matchSlots.matchId })
    .from(matchSlots)
    .where(eq(matchSlots.sourceMatchId, matchId))
  if (dependents.length === 0) return []

  const rows = await db
    .select({ id: matches.id, roundName: matches.roundName, status: matches.status })
    .from(matches)
    .where(inArray(matches.id, dependents.map((d) => d.matchId)))

  return rows.filter((r) => r.status === 'live' || r.status === 'completed')
}

export async function adminSetResult(input: {
  matchId: string
  games: GameScore[]
  resultType: ResultType
  winnerTeamId: string | null
  retiredTeamId?: string | null
  reason: string
  userId: string
  actorLabel: string
}) {
  const loaded = await getMatchForScoring(input.matchId)
  if (!loaded) return { ok: false as const, error: 'That match no longer exists.' }

  const wasFinal = loaded.match.resultState === 'final'
  if (wasFinal) {
    const blockers = await correctionBlockers(input.matchId)
    if (blockers.length) {
      const names = blockers.map((b) => b.roundName ?? 'a later match').join(', ')
      return {
        ok: false as const,
        error: `${names} has already started off this result. Void it first, or apply this when that match finishes.`,
      }
    }
  }

  const before = {
    games: loaded.games.map((g) => [g.scoreA, g.scoreB]),
    winnerTeamId: loaded.match.winnerTeamId,
    resultType: loaded.match.resultType,
  }

  await writeLedger(input.matchId, input.games, {
    resultType: input.resultType,
    winnerTeamId: input.winnerTeamId,
    retiredTeamId: input.retiredTeamId ?? null,
    provisional: false,
  })
  await db
    .update(matches)
    .set({
      resultState: 'final',
      confirmedAt: new Date(),
      confirmedVia: 'admin',
      correctedAt: wasFinal ? new Date() : null,
      correctionCount: wasFinal
        ? sql`${matches.correctionCount} + 1`
        : matches.correctionCount,
      disputeResolvedAt: loaded.match.resultState === 'disputed' ? new Date() : null,
      updatedAt: new Date(),
    })
    .where(eq(matches.id, input.matchId))

  await recordAudit({
    userId: input.userId,
    actorLabel: input.actorLabel,
    action: wasFinal ? 'match.correct' : 'match.set_result',
    entity: 'match',
    entityId: input.matchId,
    reason: input.reason,
    before,
    after: {
      games: input.games.map((g) => [g.scoreA, g.scoreB]),
      winnerTeamId: input.winnerTeamId,
      resultType: input.resultType,
    },
  })

  await resolveSlotsFor(loaded.match.categoryId)
  await bumpStreamVersion(loaded.match.tournamentId)
  return { ok: true as const }
}

export function outcomeFor(rules: ScoringRules, gs: GameScore[]) {
  return matchOutcome(rules ?? DEFAULT_RULES, gs)
}
