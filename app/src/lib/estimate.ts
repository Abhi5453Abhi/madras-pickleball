/**
 * How long the day will take — SPEC A3.
 *
 * The first draft got this wrong twice: the arithmetic was about 2x optimistic,
 * and it was computed per category while every category shares the same courts.
 * That made the one number whose job is to stop the day running past sunset
 * into the thing that would have caused it.
 *
 * Pure. Tested.
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
  pastSunset: boolean
  perCategory: CategoryLoad[]
}

export function estimateDay(opts: {
  categories: CategoryLoad[]
  courts: number
  startAt?: Date | null
  breakMinutes?: number
  sunsetAt?: Date | null
}): DayEstimate {
  const courts = Math.max(1, opts.courts)
  const totalMatches = opts.categories.reduce((n, c) => n + c.matchCount, 0)
  const totalMatchMinutes = opts.categories.reduce(
    (n, c) => n + c.matchCount * c.minutesPerMatch,
    0,
  )

  const minutes =
    totalMatches === 0
      ? 0
      : Math.round((totalMatchMinutes / courts) * OVERLAP_ALLOWANCE) + (opts.breakMinutes ?? 0)

  const finishAt = opts.startAt ? new Date(opts.startAt.getTime() + minutes * 60_000) : null
  const pastSunset = !!(finishAt && opts.sunsetAt && finishAt > opts.sunsetAt)

  return { totalMatches, minutes, finishAt, pastSunset, perCategory: opts.categories }
}

/** Match count for a league of N, plus its finals stage. */
export function leagueMatchCount(
  teams: number,
  finalsStage: 'none' | 'final_only' | 'semis_and_final',
): { matches: number; minPerEntry: number } {
  if (teams < 2) return { matches: 0, minPerEntry: 0 }
  const groupMatches = (teams * (teams - 1)) / 2
  const finals = finalsStage === 'none' ? 0 : finalsStage === 'final_only' ? 1 : 3
  return { matches: groupMatches + finals, minPerEntry: teams - 1 }
}

/** Match count for pools of roughly equal size plus a knockout of 2 per pool. */
export function groupsKnockoutMatchCount(
  teams: number,
  poolCount: number,
): { matches: number; minPerEntry: number } {
  if (teams < 2) return { matches: 0, minPerEntry: 0 }
  const base = Math.floor(teams / poolCount)
  const extra = teams % poolCount
  let group = 0
  let smallest = Infinity
  for (let i = 0; i < poolCount; i++) {
    const size = base + (i < extra ? 1 : 0)
    group += (size * (size - 1)) / 2
    smallest = Math.min(smallest, size)
  }
  const field = poolCount * 2
  const knockout = field - 1
  return { matches: group + knockout, minPerEntry: Math.max(0, smallest - 1) }
}
