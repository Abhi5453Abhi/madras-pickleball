import 'server-only'
import { and, asc, eq, inArray, isNotNull, or, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { db, mapCase, transact, type Tx } from '@/db'
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
  hornOutcome,
  matchOutcome,
  retirementGames,
  validateGames,
  walkoverGames,
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

/**
 * The rules a match was actually played under. After "Shorten what's left"
 * the category says one game to 11, but a result that was already in was
 * best of three — correcting it under the new rules would refuse its own
 * second game. The stored games say what shape it had.
 */
function rulesForMatch(
  category: Parameters<typeof rulesFor>[0],
  existing: Array<{ scoreA: number; scoreB: number }>,
): ScoringRules {
  const rules = rulesFor(category)
  if (!existing.length) return rules
  const bestOf = existing.length > 1 ? Math.max(rules.bestOf, 3) : rules.bestOf
  const tops = existing.map((g) => Math.max(g.scoreA, g.scoreB))
  const pointsToWin =
    rules.pointsToWin < 15 && tops.every((t) => t >= 15) ? 15 : rules.pointsToWin
  return { ...rules, bestOf, pointsToWin }
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
  const sideIds = [match.teamAId, match.teamBId].filter(Boolean) as string[]

  // Three reads that only need the match id, which we now have. Sequentially
  // they were three network hops on the screen a scorer is standing in front
  // of on a court.
  const [sides, existingGames, submissions] = await Promise.all([
    sideIds.length
      ? db.select({ id: teams.id, name: teams.name }).from(teams).where(inArray(teams.id, sideIds))
      : Promise.resolve([] as Array<{ id: string; name: string }>),
    db.select().from(games).where(eq(games.matchId, matchId)).orderBy(asc(games.gameNo)),
    db
      .select()
      .from(resultSubmissions)
      .where(and(eq(resultSubmissions.matchId, matchId), eq(resultSubmissions.status, 'active'))),
  ])

  return {
    match,
    category,
    rules: rulesForMatch(category, existingGames),
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

/**
 * Fields a caller wants written to the match in the SAME statement the ledger
 * update uses. Both callers followed `writeLedger` with a second UPDATE against
 * the same row; folding them together is one fewer network hop on the write a
 * court device performs after every single match.
 */
type MatchPatch = PgUpdateSetSource<typeof matches>

async function writeLedger(
  tx: Tx,
  matchId: string,
  gameScores: GameScore[],
  opts: {
    resultType: ResultType
    winnerTeamId: string | null
    provisional: boolean
    excludeFromDiff?: number[]
    retiredTeamId?: string | null
  },
  also?: MatchPatch,
) {
  await tx.delete(games).where(eq(games.matchId, matchId))
  const exclude = new Set(opts.excludeFromDiff ?? [])
  const walkover = opts.resultType === 'walkover'

  if (gameScores.length) {
    await tx.insert(games).values(
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

  await tx
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
      ...also,
    })
    .where(eq(matches.id, matchId))
}

export type NormalizedResult = {
  games: GameScore[]
  winnerTeamId: string | null
  retiredTeamId: string | null
  excludeFromDiff: number[]
}

/**
 * Turn what a screen sent into what actually gets stored — SPEC A5/A6.
 *
 * Nothing structural is taken on trust. The winner is DERIVED from the games,
 * a walkover's scoreline is GENERATED rather than accepted, and which games sit
 * out of point difference is worked out here rather than sent by the client:
 * that field decides the venue's headline tiebreak, so a phone must not be able
 * to set it. Two screens sending the same no-show used to store two different
 * ledgers; now there is one answer.
 */
export function normalizeResult(
  rules: ScoringRules,
  match: { teamAId: string | null; teamBId: string | null },
  input: {
    games: GameScore[]
    resultType: ResultType
    winnerTeamId: string | null
    retiredTeamId?: string | null
    /** These games are already the full ledger — see the retirement branch. */
    expanded?: boolean
    excludeFromDiff?: number[]
  },
): { ok: true; value: NormalizedResult } | { ok: false; error: string } {
  const sides = [match.teamAId, match.teamBId].filter(Boolean) as string[]
  if (sides.length !== 2) {
    return { ok: false, error: 'This match is still waiting on an earlier result.' }
  }
  if (input.games.some((g) => g.scoreA < 0 || g.scoreB < 0)) {
    return { ok: false, error: 'Scores can\u2019t be negative.' }
  }

  if (input.resultType === 'walkover') {
    const winnerTeamId = input.winnerTeamId
    if (!winnerTeamId || !sides.includes(winnerTeamId)) {
      return { ok: false, error: 'Say which side went through.' }
    }
    const base = walkoverGames(rules)
    const winnerIsA = winnerTeamId === match.teamAId
    const gs = base.map((g) =>
      winnerIsA ? g : { ...g, scoreA: g.scoreB, scoreB: g.scoreA },
    )
    return {
      ok: true,
      value: {
        games: gs,
        winnerTeamId,
        retiredTeamId: null,
        // A no-show is on the record and in no difference column at all.
        excludeFromDiff: gs.map((g) => g.gameNo),
      },
    }
  }

  if (input.resultType === 'retired') {
    const retiredTeamId = input.retiredTeamId
    if (!retiredTeamId || !sides.includes(retiredTeamId)) {
      return { ok: false, error: 'Say which side couldn\u2019t carry on.' }
    }
    const retiringSide: 'A' | 'B' = retiredTeamId === match.teamAId ? 'A' : 'B'
    const played = [...input.games].sort((a, b) => a.gameNo - b.gameNo)
    const winnerTeamId = retiringSide === 'A' ? match.teamBId : match.teamAId

    // `expanded` means these games ARE the ledger — an organiser replaying a
    // stored submission. Re-running the expansion over an already-complete list
    // finds nothing left to fill in and hands back an EMPTY exclusion list, so
    // the 11-0 nobody played quietly entered game and point difference.
    if (input.expanded) {
      return {
        ok: true,
        value: {
          games: played,
          winnerTeamId,
          retiredTeamId,
          excludeFromDiff: input.excludeFromDiff ?? [],
        },
      }
    }

    const { games: gs, excludeFromDiff } = retirementGames(rules, played, retiringSide)
    return {
      ok: true,
      value: { games: gs, winnerTeamId, retiredTeamId, excludeFromDiff },
    }
  }

  const v = validateGames(rules, input.games)
  if (!v.ok) return { ok: false, error: v.reason }

  // A time-capped game ends the MATCH, not just the game — so a horn-stopped
  // match is complete on one game, or on two that are level. Judging it by
  // `matchOutcome` made the whole time-cap path unsubmittable from the court
  // card: the screen said "that's the match" and the server said those games
  // don't decide it, forever.
  const stoppedByHorn = input.games.some((g) => g.timeCapped)
  const outcome = stoppedByHorn
    ? hornOutcome(rules, input.games)
    : matchOutcome(rules, input.games)
  const winnerTeamId =
    outcome.winner === 'A' ? match.teamAId : outcome.winner === 'B' ? match.teamBId : null
  if (!winnerTeamId) {
    return {
      ok: false,
      error: stoppedByHorn
        ? 'Level on games and level on the game the horn stopped — the organiser has to call this one.'
        : 'Those games don\u2019t decide the match.',
    }
  }

  return {
    ok: true,
    value: {
      games: input.games,
      winnerTeamId,
      retiredTeamId: null,
      // A game stopped by the horn keeps its points and sits out of point
      // difference; writeLedger flags it from `timeCapped`.
      excludeFromDiff: [],
    },
  }
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

/**
 * The match and the rules it is played under — one query, and nothing else.
 *
 * `getMatchForScoring` also fetches the side names, the existing ledger and the
 * open submissions, because a screen needs them. A submission needs none of
 * that: it reads the match to normalise the score and then re-reads it under a
 * lock inside the transaction anyway. Three queries a court device was waiting
 * on for nothing, on the write it performs after every match of the day.
 */
async function loadMatchAndRules(matchId: string) {
  const [row] = await db
    .select({ match: matches, category: categories })
    .from(matches)
    .innerJoin(categories, eq(categories.id, matches.categoryId))
    .where(eq(matches.id, matchId))
    .limit(1)
  return row ? { match: row.match, rules: rulesFor(row.category) } : null
}

export async function submitResult(input: SubmitInput): Promise<SubmitResult> {
  const loaded = await loadMatchAndRules(input.matchId)
  if (!loaded) return { ok: false, error: 'That match no longer exists.' }
  const { rules } = loaded

  // From the semi-finals on, a match can be marked as needing a named scorer.
  // The court screen already hides these — but a hidden button is not a
  // control, and the refusal has to live where the write happens (SPEC A1).
  if (loaded.match.scoringMode === 'authenticated' && input.actorType === 'court_token') {
    return { ok: false, error: 'This one is recorded by an umpire. Ask the organiser.' }
  }

  // Everything structural is derived server-side: the winner from the games, a
  // walkover's scoreline generated rather than accepted, and which games sit
  // out of point difference worked out here. A phone must not be able to set
  // the field that decides the venue's headline tiebreak.
  const norm = normalizeResult(rules, loaded.match, input)
  if (!norm.ok) {
    // An organiser standing on the court can record a score the rules engine
    // doesn't recognise — a game the pair played to an informal cap, a horn
    // that went early. They are the authority; the engine is the default.
    if (!input.authoritative || input.resultType !== 'normal') {
      return { ok: false, error: norm.error }
    }
  }

  const value: NormalizedResult = norm.ok
    ? norm.value
    : {
        games: input.games,
        winnerTeamId: input.winnerTeamId,
        retiredTeamId: null,
        excludeFromDiff: [],
      }

  if (!norm.ok) {
    const sides = [loaded.match.teamAId, loaded.match.teamBId]
    if (!value.winnerTeamId || !sides.includes(value.winnerTeamId)) {
      return { ok: false, error: norm.error }
    }
    // A duplicate game number would break the ledger halfway through, whoever
    // sends it.
    const nos = new Set<number>()
    for (const g of value.games) {
      if (nos.has(g.gameNo)) return { ok: false, error: `Game ${g.gameNo} is in there twice.` }
      nos.add(g.gameNo)
    }
  }

  const digest = normalizedDigest({
    resultType: input.resultType,
    winnerTeamId: value.winnerTeamId,
    games: value.games,
  })

  try {
    return await transact(async (tx) => {
      // Lock the match row for the length of the write. Two phones submitting
      // conflicting scores half a second apart used to interleave: the second
      // one wrote `disputed`, the first one's later write put it back to
      // `reported`, and the disagreement was silently thrown away.
      const [match] = await tx
        .select()
        .from(matches)
        .where(eq(matches.id, input.matchId))
        .limit(1)
        .for('update')
      if (!match) return { ok: false as const, error: 'That match no longer exists.' }

      // Projected, not stored: a result that auto-confirmed at the ten-minute
      // mark is closed even though nothing has physically written `final` yet.
      if (projectedState(match) === 'final' && !input.authoritative) {
        // Never silently discarded — the admin should be able to see that
        // someone tried to submit at 15:04 (SPEC A7).
        await tx.insert(syncConflicts).values({
          id: newId('sc'),
          matchId: match.id,
          deviceId: input.deviceId ?? null,
          payload: { games: input.games, resultType: input.resultType },
          reason: 'submitted after the result was final',
        })
        return { ok: false as const, error: 'That result is already final. Tell the organiser.' }
      }

      // One live submission per source, enforced by a unique index rather than
      // by app logic. A second submission from the same source supersedes; it
      // never disputes with itself.
      await tx
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
      await tx.insert(resultSubmissions).values({
        id: submissionId,
        matchId: match.id,
        attributorKey: input.attributorKey,
        actorType: input.actorType,
        userId: input.userId ?? null,
        deviceId: input.deviceId ?? null,
        submittingTeamId: input.submittingTeamId,
        games: value.games,
        excludeFromDiff: value.excludeFromDiff,
        resultType: input.resultType,
        retiredTeamId: value.retiredTeamId,
        winnerTeamId: value.winnerTeamId,
        normalizedDigest: digest,
        clientEventId: input.clientEventId,
      })

      const others = await tx
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
          // Independence needs a different source AND a declared opposite side
          // — two members of one team on two phones are not two sides, and a
          // submission that declares no side is a duplicate rather than
          // agreement.
          !!o.submittingTeamId &&
          !!input.submittingTeamId &&
          o.submittingTeamId !== input.submittingTeamId,
      )
      const disagreeing = others.find((o) => o.normalizedDigest !== digest)

      let state: 'reported' | 'final' | 'disputed' = 'reported'
      if (input.authoritative) state = 'final'
      // A disputed match stays disputed until an organiser rules on it: a third
      // submission that happens to agree with one side must not quietly clear it.
      else if (match.resultState === 'disputed') state = 'disputed'
      else if (agreeing) state = 'final'
      else if (disagreeing) state = 'disputed'

      // The ten-minute clock runs from THIS score, not from whatever was
      // reported first. Otherwise a device could report something plausible at
      // 14:00, replace it at 14:09:50, and give the other pair ten seconds of
      // the window the public page promises them.
      const scoreChanged = match.resultState === 'none' || digest !== (await lastDigest(tx, match.id, submissionId))
      const reportedAt = state === 'reported' && scoreChanged ? new Date() : (match.reportedAt ?? new Date())

      const outcome: MatchPatch = {
        resultState: state,
        reportedAt,
        confirmedAt: state === 'final' ? new Date() : null,
        confirmedVia: state === 'final' ? (input.authoritative ? 'admin' : 'agreement') : null,
        disputeOpenedAt: state === 'disputed' ? new Date() : match.disputeOpenedAt,
        updatedAt: new Date(),
      }

      // A DISPUTED result does not get to overwrite the ledger. Whoever
      // submitted last used to own `winner_team_id` and the game rows while the
      // match sat "under review" — so the stored answer was the version the
      // argument was about. Both versions live in `result_submissions`, which
      // is what the organiser's Use-this-one screen reads.
      if (state !== 'disputed') {
        await writeLedger(
          tx,
          match.id,
          value.games,
          {
            resultType: input.resultType,
            winnerTeamId: value.winnerTeamId,
            retiredTeamId: value.retiredTeamId,
            excludeFromDiff: value.excludeFromDiff,
            provisional: state !== 'final',
          },
          outcome,
        )
      } else {
        await tx.update(matches).set(outcome).where(eq(matches.id, match.id))
      }

      if (agreeing) {
        await tx.insert(matchConfirmations).values({
          id: newId('cf'),
          matchId: match.id,
          submissionId: agreeing.id,
          attributorKey: input.attributorKey,
          agreedForTeamId: input.submittingTeamId,
          digest,
          // Two phones at the net post are two phones, not two witnesses: the
          // same person can open the QR twice. Calling this `high` overstated
          // what the record actually knows. An umpire who typed a PIN is a
          // different matter.
          confidence: input.actorType === 'umpire_pin' ? 'high' : 'normal',
          deviceId: input.deviceId ?? null,
        })
      }

      return { ok: true as const, state, categoryId: match.categoryId, tournamentId: match.tournamentId }
    }).then(async (res) => {
      if (!res.ok) return res
      // A disputed match blocks advancement; anything else propagates. Both of
      // these are outside the transaction on purpose: they touch other matches
      // and must not hold the row lock while they do it.
      if (res.state !== 'disputed') await resolveSlotsFor(res.categoryId)
      await bumpStreamVersion(res.tournamentId)
      return { ok: true as const, state: res.state }
    })
  } catch (e) {
    // The unique index on (match, game_no) and the winner CHECK constraint are
    // the last line of defence. They must read as a sentence, not a 500.
    console.error('submitResult', e)
    return { ok: false, error: 'That score didn’t save. Check it and try again.' }
  }
}

/** The digest of the submission this one replaced, if any. */
async function lastDigest(tx: Tx, matchId: string, exceptId: string) {
  const [row] = await tx
    .select({ digest: resultSubmissions.normalizedDigest })
    .from(resultSubmissions)
    .where(
      and(
        eq(resultSubmissions.matchId, matchId),
        sql`${resultSubmissions.id} <> ${exceptId}`,
      ),
    )
    .orderBy(sql`${resultSubmissions.createdAt} desc`)
    .limit(1)
  return row?.digest ?? null
}

/**
 * Fill in slots whose source has become known: the winner of an earlier match,
 * or a finishing position in a group whose matches are all in.
 */
export async function resolveSlotsFor(categoryId: string) {
  // Six reads, one wave. Each is scoped by the category — the slots and the
  // games join back through `matches` rather than waiting for a list of match
  // ids — so none of them has to wait for another.
  const [category, catMatches, slots, groupRows, teamRows, gameRows] = await Promise.all([
    db
      .select({ tiebreakRule: categories.tiebreakRule })
      .from(categories)
      .where(eq(categories.id, categoryId))
      .limit(1)
      .then((r) => r[0]),

    db
      .select({
        id: matches.id,
        stage: matches.stage,
        groupId: matches.groupId,
        status: matches.status,
        resultState: matches.resultState,
        resultType: matches.resultType,
        teamAId: matches.teamAId,
        teamBId: matches.teamBId,
        winnerTeamId: matches.winnerTeamId,
      })
      .from(matches)
      .where(eq(matches.categoryId, categoryId)),

    db
      .select({
        id: matchSlots.id,
        matchId: matchSlots.matchId,
        slot: matchSlots.slot,
        sourceType: matchSlots.sourceType,
        sourceMatchId: matchSlots.sourceMatchId,
        sourceGroupId: matchSlots.sourceGroupId,
        sourceRank: matchSlots.sourceRank,
        resolvedTeamId: matchSlots.resolvedTeamId,
      })
      .from(matchSlots)
      .innerJoin(matches, eq(matches.id, matchSlots.matchId))
      .where(eq(matches.categoryId, categoryId)),

    // Group tables, computed only where every group match has a result.
    db.select({ id: groups.id }).from(groups).where(eq(groups.categoryId, categoryId)),

    db
      .select({ id: teams.id, groupId: teams.groupId, status: teams.status })
      .from(teams)
      .where(eq(teams.categoryId, categoryId)),

    db
      .select({
        matchId: games.matchId,
        gameNo: games.gameNo,
        scoreA: games.scoreA,
        scoreB: games.scoreB,
        excludeFromDiff: games.excludeFromDiff,
        timeCapped: games.timeCapped,
      })
      .from(games)
      .innerJoin(matches, eq(matches.id, games.matchId))
      .where(eq(matches.categoryId, categoryId)),
  ])
  if (!category) return

  const byId = new Map(catMatches.map((m) => [m.id, m]))
  const gamesByMatch = new Map<string, typeof gameRows>()
  for (const g of gameRows) {
    const list = gamesByMatch.get(g.matchId) ?? []
    list.push(g)
    gamesByMatch.set(g.matchId, list)
  }

  const rankedByGroup = new Map<string, string[]>()
  for (const group of groupRows) {
    // A pair who have gone home do not take a place in the knockout. Their
    // played matches still stand in the table everyone reads — that is the
    // public page's business — but the draw is not built on them.
    const groupTeams = teamRows
      .filter((t) => t.groupId === group.id && t.status === 'active')
      .map((t) => t.id)
    const groupMatches = catMatches.filter(
      (m) => m.stage === 'group' && m.groupId === group.id,
    )
    // A voided match is settled — it counts for nobody, which is a result of a
    // kind. Requiring `final` or `reported` meant cancelling one group match
    // froze that group's ranking for good: no slot ever resolved again, while
    // the public table happily recomputed without it. The two then disagreed
    // permanently, and the knockout stage silently stalled.
    const allIn = groupMatches.every(
      (m) =>
        m.resultState === 'final' ||
        m.resultState === 'reported' ||
        m.resultState === 'voided',
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
            timeCapped: g.timeCapped,
          })),
      }))
    rankedByGroup.set(
      group.id,
      standings(groupTeams, input, category.tiebreakRule).map((r) => r.teamId),
    )
  }

  // Collected first, written once. A slot resolution is two updates, and a
  // knockout round is four slots — eight round trips to fill in a bracket that
  // is eight rows of known data.
  const slotUpdates: Array<readonly [string, string]> = []
  const sideUpdates: { A: Array<readonly [string, string]>; B: Array<readonly [string, string]> } = {
    A: [],
    B: [],
  }

  for (const slot of slots) {
    let teamId: string | null = null

    if (slot.sourceType === 'winner_of' && slot.sourceMatchId) {
      const src = byId.get(slot.sourceMatchId)
      if (src && (src.resultState === 'final' || src.resultState === 'reported')) {
        teamId = src.winnerTeamId
      }
    } else if (slot.sourceType === 'loser_of' && slot.sourceMatchId) {
      const src = byId.get(slot.sourceMatchId)
      if (src && src.winnerTeamId && (src.resultState === 'final' || src.resultState === 'reported')) {
        teamId = src.winnerTeamId === src.teamAId ? src.teamBId : src.teamAId
      }
    } else if (slot.sourceType === 'group_rank' && slot.sourceGroupId && slot.sourceRank) {
      teamId = rankedByGroup.get(slot.sourceGroupId)?.[slot.sourceRank - 1] ?? null
    }

    if (!teamId || teamId === slot.resolvedTeamId) continue

    // A correction upstream re-fills the slot — but never under a match that
    // has already started. Naming the blocker is A7's job, not this loop's.
    if (slot.resolvedTeamId) {
      const dependent = byId.get(slot.matchId)
      if (dependent && (dependent.status === 'live' || dependent.status === 'completed')) continue
    }

    slotUpdates.push([slot.id, teamId])
    sideUpdates[slot.slot === 'A' ? 'A' : 'B'].push([slot.matchId, teamId])
  }

  // A match with both slots filled becomes placeable. Asked of the database
  // rather than answered by re-reading every match in the category and updating
  // them one by one — the second full read of `matches` in this function was
  // the same rows we already had, plus whatever we had just written.
  const promote = (handle: Tx | typeof db) =>
    handle
      .update(matches)
      .set({ status: 'ready' })
      .where(
        and(
          eq(matches.categoryId, categoryId),
          eq(matches.status, 'pending'),
          isNotNull(matches.teamAId),
          isNotNull(matches.teamBId),
        ),
      )

  if (slotUpdates.length === 0) {
    await promote(db)
    return
  }

  const at = new Date()
  await transact(async (tx) => {
    await tx
      .update(matchSlots)
      .set({ resolvedTeamId: mapCase(matchSlots.id, slotUpdates), resolvedAt: at })
      .where(
        inArray(
          matchSlots.id,
          slotUpdates.map(([id]) => id),
        ),
      )

    for (const side of ['A', 'B'] as const) {
      const pairs = sideUpdates[side]
      if (!pairs.length) continue
      const value = mapCase(matches.id, pairs)
      await tx
        .update(matches)
        .set(side === 'A' ? { teamAId: value, updatedAt: at } : { teamBId: value, updatedAt: at })
        .where(
          inArray(
            matches.id,
            pairs.map(([id]) => id),
          ),
        )
    }

    await promote(tx)
  })
}

/**
 * "Edit this match" — the universal escape hatch (SPEC A7). A correction is
 * refused while a downstream match has already started, and the blocking match
 * is named rather than the change simply failing.
 */
export async function correctionBlockers(matchId: string) {
  const [self] = await db
    .select({
      categoryId: matches.categoryId,
      groupId: matches.groupId,
      stage: matches.stage,
    })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)
  if (!self) return []

  // Two kinds of dependency, asked in one question rather than three chained
  // ones. The first is a knockout match fed directly by this one.
  //
  // The second — the case this missed entirely — is every match fed by the
  // TABLE this one sits in. A league builds its semis and final from
  // `group_rank` slots, which carry a group and a rank and a null
  // source_match_id. So for the default format the guard never fired: an
  // organiser could rewrite the group score a live semi-final had been built
  // from, the table would silently reorder underneath it, and one team could
  // end up in both semi-finals while another vanished from the draw.
  const fedByTable =
    self.stage === 'group'
      ? and(
          eq(matchSlots.sourceType, 'group_rank'),
          self.groupId
            ? eq(matchSlots.sourceGroupId, self.groupId)
            : // The group list is a subquery, so it does not cost its own hop.
              inArray(
                matchSlots.sourceGroupId,
                db
                  .select({ id: groups.id })
                  .from(groups)
                  .where(eq(groups.categoryId, self.categoryId)),
              ),
        )
      : undefined

  const dependentIds = new Set(
    (
      await db
        .select({ matchId: matchSlots.matchId })
        .from(matchSlots)
        .where(or(eq(matchSlots.sourceMatchId, matchId), fedByTable))
    ).map((d) => d.matchId),
  )

  dependentIds.delete(matchId)
  if (dependentIds.size === 0) return []

  const rows = await db
    .select({ id: matches.id, roundName: matches.roundName, status: matches.status })
    .from(matches)
    .where(inArray(matches.id, [...dependentIds]))

  return rows.filter((r) => r.status === 'live' || r.status === 'completed')
}

export async function adminSetResult(input: {
  matchId: string
  games: GameScore[]
  resultType: ResultType
  winnerTeamId: string | null
  retiredTeamId?: string | null
  excludeFromDiff?: number[]
  /** These games are already the full ledger — replaying a stored submission. */
  expanded?: boolean
  reason: string
  userId: string
  actorLabel: string
}) {
  const loaded = await getMatchForScoring(input.matchId)
  if (!loaded) return { ok: false as const, error: 'That match no longer exists.' }

  // Any result already in — reported, disputed or final — can have sent a team
  // out onto a court. Checking only `final` let a correction quietly rewrite
  // the match a live semi-final was built from.
  const hadResult = loaded.match.resultState !== 'none'
  if (hadResult) {
    const blockers = await correctionBlockers(input.matchId)
    if (blockers.length) {
      const names = blockers.map((b) => b.roundName ?? 'a later match').join(', ')
      return {
        ok: false as const,
        error: `${names} has already started off this result. Void it first, or apply this when that match finishes.`,
      }
    }
  }

  // The same normalisation as every other path: a walkover's scoreline is
  // generated, a retirement's phantom games are worked out here, and the winner
  // comes from the games. An organiser fixing a score should not be able to
  // hand the match to the side that lost it by editing one field — and their
  // ledger has to be identical to the one a court device would have written.
  const norm = normalizeResult(loaded.rules, loaded.match, input)
  const sides = [loaded.match.teamAId, loaded.match.teamBId]
  let value: NormalizedResult
  if (norm.ok) {
    value = norm.value
  } else if (
    input.resultType === 'normal' &&
    input.winnerTeamId &&
    sides.includes(input.winnerTeamId)
  ) {
    // The organiser is the authority and the rules engine is the default. A
    // game the pair played out to an informal cap is a real result; refusing to
    // record it just sends the day back to a paper list.
    value = {
      games: input.games,
      winnerTeamId: input.winnerTeamId,
      retiredTeamId: null,
      excludeFromDiff: input.excludeFromDiff ?? [],
    }
    const nos = new Set<number>()
    for (const g of value.games) {
      if (g.scoreA < 0 || g.scoreB < 0) {
        return { ok: false as const, error: 'Scores can\u2019t be negative.' }
      }
      if (nos.has(g.gameNo)) {
        return { ok: false as const, error: `Game ${g.gameNo} is in there twice.` }
      }
      nos.add(g.gameNo)
    }
  } else {
    return { ok: false as const, error: norm.error }
  }

  const before = {
    games: loaded.games.map((g) => [g.scoreA, g.scoreB]),
    winnerTeamId: loaded.match.winnerTeamId,
    resultType: loaded.match.resultType,
  }

  try {
    await transact(async (tx) => {
      await writeLedger(
        tx,
        input.matchId,
        value.games,
        {
          resultType: input.resultType,
          winnerTeamId: value.winnerTeamId,
          retiredTeamId: value.retiredTeamId,
          excludeFromDiff: value.excludeFromDiff,
          provisional: false,
        },
        // Same row, same statement: this was a second UPDATE against the match
        // writeLedger had just written.
        {
          resultState: 'final',
          confirmedAt: new Date(),
          confirmedVia: 'admin',
          provisional: false,
          status: 'completed',
          correctedAt: hadResult ? new Date() : null,
          correctionCount: hadResult
            ? sql`${matches.correctionCount} + 1`
            : matches.correctionCount,
          disputeResolvedAt: loaded.match.resultState === 'disputed' ? new Date() : null,
          updatedAt: new Date(),
        },
      )

      // Every earlier submission is settled by this: leaving them `active`
      // meant the next court-side submission could "agree" with a score nobody
      // stands behind any more.
      await tx
        .update(resultSubmissions)
        .set({ status: 'superseded' })
        .where(
          and(
            eq(resultSubmissions.matchId, input.matchId),
            eq(resultSubmissions.status, 'active'),
          ),
        )
    })
  } catch (e) {
    console.error('adminSetResult', e)
    return { ok: false as const, error: 'That didn\u2019t save. Check the score and try again.' }
  }

  await recordAudit({
    userId: input.userId,
    actorLabel: input.actorLabel,
    action: hadResult ? 'match.correct' : 'match.set_result',
    entity: 'match',
    entityId: input.matchId,
    reason: input.reason,
    before,
    after: {
      games: value.games.map((g) => [g.scoreA, g.scoreB]),
      winnerTeamId: value.winnerTeamId,
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
