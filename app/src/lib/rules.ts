/**
 * Terminal scoring logic — SPEC A5.
 *
 * This is the half of the rules engine that answers "is this match over and who
 * won". Quick result entry needs all of it, so it ships now; the rally-by-rally
 * state machine lands in v1.1 and must terminate into these same functions, or
 * there will be two definitions of a finished match that disagree.
 *
 * Pure. No database, no framework. Tested.
 */

export type ScoringRules = {
  /** 1 or 3. Best of 3 means first to 2 games. */
  bestOf: number
  pointsToWin: number
  winBy: number
  /** At the cap the next point wins, win-by-1. Null = no cap. */
  hardCap: number | null
}

export type GameScore = {
  gameNo: number
  scoreA: number
  scoreB: number
  /** Stopped by the horn: recorded at its actual score, excluded from point difference. */
  timeCapped?: boolean
}

export const DEFAULT_RULES: ScoringRules = {
  bestOf: 3,
  pointsToWin: 11,
  winBy: 2,
  hardCap: null,
}

export const gamesNeededToWin = (rules: ScoringRules) => Math.floor(rules.bestOf / 2) + 1

/** Who won a single game, or null if it isn't finished. 'A' | 'B'. */
export function gameWinner(rules: ScoringRules, g: GameScore): 'A' | 'B' | null {
  const { pointsToWin, winBy, hardCap } = rules
  const hi = Math.max(g.scoreA, g.scoreB)
  const lo = Math.min(g.scoreA, g.scoreB)
  const leader: 'A' | 'B' = g.scoreA > g.scoreB ? 'A' : 'B'

  if (g.timeCapped) {
    // The horn ends it. A tied capped game is decided by the match, not here.
    return g.scoreA === g.scoreB ? null : leader
  }
  if (g.scoreA === g.scoreB) return null

  // At the cap, win by one — otherwise the game could never end.
  if (hardCap !== null && hi >= hardCap) return hi === hardCap ? leader : null
  if (hi < pointsToWin || hi - lo < winBy) return null
  // Past the target you can only ever be exactly winBy ahead: a 12-3 is not a
  // pickleball score in any configuration.
  if (hi > pointsToWin && hi - lo !== winBy) return null
  return leader
}

export type Validation = { ok: true } | { ok: false; reason: string }

/**
 * Soft validation — the UI warns and still lets the score through, because a
 * capped or time-stopped game is legitimate and an organiser must never be
 * blocked from recording what actually happened (SPEC A5).
 */
export function validateGames(rules: ScoringRules, games: GameScore[]): Validation {
  if (games.length === 0) return { ok: false, reason: 'No games recorded.' }
  if (games.length > rules.bestOf) {
    return { ok: false, reason: `A best-of-${rules.bestOf} match can't have ${games.length} games.` }
  }

  // A repeated game number violates the unique index on (match, game_no)
  // halfway through rewriting the ledger — which left the match with no games
  // at all and a winner nobody could account for.
  const seen = new Set<number>()
  for (const g of games) {
    if (!Number.isInteger(g.gameNo) || g.gameNo < 1) {
      return { ok: false, reason: 'That isn’t a game number.' }
    }
    if (seen.has(g.gameNo)) return { ok: false, reason: `Game ${g.gameNo} is in there twice.` }
    seen.add(g.gameNo)
  }

  for (const g of games) {
    if (g.scoreA < 0 || g.scoreB < 0) return { ok: false, reason: 'Scores can’t be negative.' }
    if (g.timeCapped) continue
    if (gameWinner(rules, g) === null) {
      const target = rules.hardCap ?? rules.pointsToWin
      return {
        ok: false,
        reason: `${g.scoreA}-${g.scoreB} isn’t a finished game — first to ${target}, win by ${rules.winBy}.`,
      }
    }
  }

  // A decided match must stop; no dead rubbers.
  const need = gamesNeededToWin(rules)
  let a = 0
  let b = 0
  for (let i = 0; i < games.length; i++) {
    const w = gameWinner(rules, games[i])
    if (w === 'A') a++
    else if (w === 'B') b++
    if ((a === need || b === need) && i < games.length - 1) {
      return { ok: false, reason: `The match was already won after game ${i + 1}.` }
    }
  }

  return { ok: true }
}

export type MatchOutcome = {
  complete: boolean
  winner: 'A' | 'B' | null
  gamesWonA: number
  gamesWonB: number
}

export function matchOutcome(rules: ScoringRules, games: GameScore[]): MatchOutcome {
  let gamesWonA = 0
  let gamesWonB = 0
  for (const g of games) {
    const w = gameWinner(rules, g)
    if (w === 'A') gamesWonA++
    else if (w === 'B') gamesWonB++
  }
  const need = gamesNeededToWin(rules)
  const winner = gamesWonA >= need ? 'A' : gamesWonB >= need ? 'B' : null
  return { complete: winner !== null, winner, gamesWonA, gamesWonB }
}

/** Per-game point difference is capped so a blowout can't decide a pool (SPEC A6). */
export const DIFF_CAP = 8

export function cappedDiff(scoreFor: number, scoreAgainst: number): number {
  const d = scoreFor - scoreAgainst
  return Math.max(-DIFF_CAP, Math.min(DIFF_CAP, d))
}

/**
 * A walkover records 11-0, 11-0 for the record but contributes nothing to any
 * difference column — otherwise a match nobody played decides the pool.
 */
export function walkoverGames(rules: ScoringRules): GameScore[] {
  const need = gamesNeededToWin(rules)
  return Array.from({ length: need }, (_, i) => ({
    gameNo: i + 1,
    scoreA: rules.pointsToWin,
    scoreB: 0,
  }))
}

/**
 * Retirement: the in-progress game is recorded as target vs the points the
 * retiring side actually had; any unplayed games are 11-0 and contribute
 * nothing to difference (SPEC A5).
 */
export function retirementGames(
  rules: ScoringRules,
  playedGames: GameScore[],
  retiringSide: 'A' | 'B',
): { games: GameScore[]; excludeFromDiff: number[] } {
  // Deep copy: the caller's array is React state on the score screen, and the
  // in-progress game below is rewritten in place.
  const games = playedGames.map((g) => ({ ...g }))
  const excludeFromDiff: number[] = []
  const need = gamesNeededToWin(rules)
  const outcome = matchOutcome(rules, games)
  const winnerSide = retiringSide === 'A' ? 'B' : 'A'
  let won = winnerSide === 'A' ? outcome.gamesWonA : outcome.gamesWonB

  // Finish the in-progress game at the target score — or, if the side that
  // retired was somehow ahead of it, at winBy above them, because 11-11 is not
  // a finished game and the whole match would come back `winner: null`.
  const last = games[games.length - 1]
  if (last && gameWinner(rules, last) === null) {
    const theirScore = winnerSide === 'A' ? last.scoreB : last.scoreA
    const finish = Math.max(rules.pointsToWin, theirScore + rules.winBy)
    if (winnerSide === 'A') last.scoreA = finish
    else last.scoreB = finish
    won++
  }

  while (won < need) {
    const gameNo = games.length + 1
    games.push({
      gameNo,
      scoreA: winnerSide === 'A' ? rules.pointsToWin : 0,
      scoreB: winnerSide === 'B' ? rules.pointsToWin : 0,
    })
    excludeFromDiff.push(gameNo)
    won++
  }

  return { games, excludeFromDiff }
}

/**
 * The horn ends the MATCH, not just the game — SPEC A5.
 *
 * The order is the one the spec gives, and it is not "most points": the team
 * leading in games wins; level on games, the team leading the game that was
 * actually in progress wins; level on that too, nobody here can call it.
 *
 * Summing every point across the match instead would hand the day to whoever
 * won an early game 11-2 — the same blowout SPEC A6 caps out of the tiebreak
 * precisely so it cannot decide anything.
 */
export function hornOutcome(rules: ScoringRules, games: GameScore[]): MatchOutcome {
  const base = matchOutcome(rules, games)
  if (base.winner) return { ...base, complete: true }

  if (base.gamesWonA !== base.gamesWonB) {
    return {
      complete: true,
      winner: base.gamesWonA > base.gamesWonB ? 'A' : 'B',
      gamesWonA: base.gamesWonA,
      gamesWonB: base.gamesWonB,
    }
  }

  // The game the horn actually stopped.
  const stopped = [...games].reverse().find((g) => g.timeCapped) ?? games[games.length - 1]
  if (!stopped || stopped.scoreA === stopped.scoreB) return { ...base, complete: false }

  return {
    complete: true,
    winner: stopped.scoreA > stopped.scoreB ? 'A' : 'B',
    gamesWonA: base.gamesWonA,
    gamesWonB: base.gamesWonB,
  }
}
