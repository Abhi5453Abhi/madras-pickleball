/**
 * How long the day will take — SPEC A3.
 *
 * The first draft got this wrong twice: the arithmetic was about 2x optimistic,
 * and it was computed per category while every category shares the same courts.
 * That made the one number whose job is to stop the day running past sunset
 * into the thing that would have caused it.
 *
 * Pure, and copied over from the reference unchanged apart from the sunset
 * column the port no longer has.
 */

export type FormatShape = { bestOf: number; pointsToWin: number }

/** Minutes per match including changeover. */
export function minutesPerMatch(shape: FormatShape): number {
  if (shape.bestOf >= 3) return 30
  if (shape.pointsToWin >= 15) return 20
  return 15
}

export type CategoryLoad = {
  name: string
  matchCount: number
  minutesPerMatch: number
  /** Guaranteed matches per entry — what players actually complain about. */
  minMatchesPerEntry: number
}

/**
 * A flat allowance for players entered in more than one category, which forces
 * matches to serialise. Deliberately a fudge factor, not a computed figure.
 */
export const OVERLAP_ALLOWANCE = 1.1

export type DayEstimate = {
  totalMatches: number
  minutes: number
  finishAt: Date | null
  perCategory: CategoryLoad[]
}

export function estimateDay(opts: {
  categories: CategoryLoad[]
  courts: number
  startAt?: Date | null
  breakMinutes?: number
}): DayEstimate {
  const courts = Math.max(1, opts.courts)
  const totalMatches = opts.categories.reduce((n, c) => n + c.matchCount, 0)
  const totalMatchMinutes = opts.categories.reduce((n, c) => n + c.matchCount * c.minutesPerMatch, 0)

  const minutes =
    totalMatches === 0
      ? 0
      : Math.round((totalMatchMinutes / courts) * OVERLAP_ALLOWANCE) + (opts.breakMinutes ?? 0)

  const finishAt = opts.startAt ? new Date(opts.startAt.getTime() + minutes * 60_000) : null

  return { totalMatches, minutes, finishAt, perCategory: opts.categories }
}
