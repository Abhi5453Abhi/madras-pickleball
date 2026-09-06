/**
 * Which scores are offerable — SPEC A5.
 *
 * Score entry is chosen, not typed: no keyboard, and a reversed score has no
 * chip to tap. That designs out the most common real error (entering 9-11 the
 * wrong way round) instead of detecting it afterwards.
 *
 * The chips are derived from the rules, not from `0 … winner-1`: a 12-3 is not
 * a pickleball score in any configuration, and offering ten chips where one is
 * legal is both slower and less correct. "Their score isn't here" opens the
 * full range and routes through soft validation, so nothing is unrecordable.
 *
 * Pure. Tested.
 */
import type { ScoringRules } from './rules'

/** Scores the winning side can legitimately have finished on. */
export function winnerChips(rules: ScoringRules): { chips: number[]; more: number[] } {
  const { pointsToWin, hardCap } = rules
  if (hardCap !== null) {
    const chips: number[] = []
    for (let n = pointsToWin; n <= hardCap; n++) chips.push(n)
    return { chips, more: [] }
  }
  const chips = [0, 1, 2, 3, 4].map((i) => pointsToWin + i)
  const more = [5, 6, 7, 8, 9, 10].map((i) => pointsToWin + i)
  return { chips, more }
}

/** Given the winner's score, the scores the other side can legally have. */
export function loserChips(rules: ScoringRules, winnerScore: number): number[] {
  const { pointsToWin, winBy, hardCap } = rules

  if (winnerScore === pointsToWin) {
    const out: number[] = []
    for (let n = 0; n <= pointsToWin - winBy; n++) out.push(n)
    return out
  }
  if (hardCap !== null && winnerScore === hardCap) {
    // Either the cap point was reached at one clear, or a deuce landed on it.
    const options = [hardCap - winBy, hardCap - 1].filter((n) => n >= 0)
    return [...new Set(options)].sort((a, b) => a - b)
  }
  const only = winnerScore - winBy
  return only >= 0 ? [only] : []
}

/** The escape hatch behind "Their score isn't here" — anything, warned about. */
export function anyLoserScores(winnerScore: number): number[] {
  const out: number[] = []
  for (let n = 0; n < winnerScore; n++) out.push(n)
  return out
}

export function explainSingleChip(rules: ScoringRules, winnerScore: number, loser: number): string {
  return `${winnerScore}–${loser} is the only way to reach ${winnerScore}.`
}
