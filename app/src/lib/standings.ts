/**
 * Standings and tiebreaks — SPEC A6.
 *
 * The tiebreak order is the venue's own rule: level on wins, most total points
 * scored qualifies. Head-to-head is offered as an alternative and is also the
 * fallback when points scored are equal too.
 *
 * The first draft's "wins → head-to-head → point difference" was undefined for a
 * three-way tie and would have returned whatever the sort happened to do — in
 * public, to an angry player. This is the fix, and it terminates.
 *
 * Pure. Tested.
 */
import { cappedDiff } from './rules'

export type StandingsMatch = {
  matchId: string
  teamAId: string
  teamBId: string
  winnerTeamId: string | null
  /** 'final' and 'reported' both count; 'disputed' counts as played but not won. */
  state: 'final' | 'reported' | 'disputed' | 'voided'
  resultType: 'normal' | 'bye' | 'walkover' | 'retired' | 'cancelled'
  games: Array<{
    scoreA: number
    scoreB: number
    /** Kept out of point difference: a blowout or a game nobody played. */
    excludeFromDiff?: boolean
    /** Stopped by the horn. It WAS played, so its points still count. */
    timeCapped?: boolean
  }>
}

export type TeamRow = {
  teamId: string
  played: number
  won: number
  lost: number
  winRatio: number
  gamesWon: number
  gamesLost: number
  gameDiff: number
  pointsFor: number
  pointsAgainst: number
  pointDiff: number
  /** Set once the table is ordered, e.g. "2nd on head-to-head vs Arun / Deepa". */
  reason?: string
  provisional: boolean
  disputed: boolean
}

export type TiebreakRule = 'points_scored_first' | 'head_to_head_first'

const empty = (teamId: string): TeamRow => ({
  teamId,
  played: 0,
  won: 0,
  lost: 0,
  winRatio: 0,
  gamesWon: 0,
  gamesLost: 0,
  gameDiff: 0,
  pointsFor: 0,
  pointsAgainst: 0,
  pointDiff: 0,
  provisional: false,
  disputed: false,
})

/** A walkover records a scoreline but contributes nothing to any difference. */
const contributesDiff = (m: StandingsMatch) =>
  m.resultType === 'normal' || m.resultType === 'retired'

export function tallyRows(teamIds: string[], matches: StandingsMatch[]): Map<string, TeamRow> {
  const rows = new Map<string, TeamRow>(teamIds.map((id) => [id, empty(id)]))

  for (const m of matches) {
    // Voided matches contribute zero to everything, including matches played.
    if (m.state === 'voided' || m.resultType === 'cancelled') continue
    const a = rows.get(m.teamAId)
    const b = rows.get(m.teamBId)
    if (!a || !b) continue

    a.played++
    b.played++
    if (m.state === 'reported') {
      a.provisional = true
      b.provisional = true
    }
    if (m.state === 'disputed') {
      // Counts as played but not won, so disputing your own loss can never
      // improve your position while it sits unresolved.
      a.disputed = true
      b.disputed = true
      continue
    }

    if (m.winnerTeamId === m.teamAId) {
      a.won++
      b.lost++
    } else if (m.winnerTeamId === m.teamBId) {
      b.won++
      a.lost++
    }

    // A walkover records a scoreline for the record and contributes nothing to
    // ANY accumulator except the win itself — capping only point difference
    // would let a match nobody played decide the pool through game difference.
    if (!contributesDiff(m)) continue

    for (const g of m.games) {
      // A phantom game — the 11-0s a retirement fills in for games nobody
      // played — contributes to nothing at all. A TIME-CAPPED game is the
      // opposite case: it was played, the points were really scored, and this
      // venue decides its pools on points scored. Collapsing the two deleted
      // real points from the one column that settles qualification.
      const phantom = !!g.excludeFromDiff && !g.timeCapped
      if (phantom) continue

      if (g.scoreA > g.scoreB) {
        a.gamesWon++
        b.gamesLost++
      } else if (g.scoreB > g.scoreA) {
        b.gamesWon++
        a.gamesLost++
      }

      a.pointsFor += g.scoreA
      a.pointsAgainst += g.scoreB
      b.pointsFor += g.scoreB
      b.pointsAgainst += g.scoreA

      // Point difference is the column a horn-stopped game is excluded from,
      // because it stopped early through nobody's doing.
      if (g.excludeFromDiff) continue
      a.pointDiff += cappedDiff(g.scoreA, g.scoreB)
      b.pointDiff += cappedDiff(g.scoreB, g.scoreA)
    }
  }

  for (const row of rows.values()) {
    row.winRatio = row.played === 0 ? 0 : row.won / row.played
    row.gameDiff = row.gamesWon - row.gamesLost
  }

  return rows
}

function headToHead(a: string, b: string, matches: StandingsMatch[]): number {
  let aWins = 0
  let bWins = 0
  for (const m of matches) {
    if (m.state === 'voided' || m.state === 'disputed') continue
    const involves =
      (m.teamAId === a && m.teamBId === b) || (m.teamAId === b && m.teamBId === a)
    if (!involves) continue
    if (m.winnerTeamId === a) aWins++
    else if (m.winnerTeamId === b) bWins++
  }
  return bWins - aWins // negative sorts `a` first
}

type Step = {
  label: string
  compare: (x: TeamRow, y: TeamRow) => number
  /** A specific sentence for this row, when the label alone isn't enough. */
  describe?: (row: TeamRow) => string
}

const byWinRatio: Step = {
  label: 'record',
  compare: (x, y) => y.winRatio - x.winRatio,
  // Mid-tournament two teams can both have three wins from different numbers
  // of matches, and "3 wins above 3 wins" with no explanation is exactly the
  // thing someone comes to the desk about. Say which record.
  describe: (r) => `3 played, ${r.won} won`.replace('3 played', `${r.played} played`),
}
const byPointsScored: Step = {
  label: 'total points scored',
  compare: (x, y) => y.pointsFor - x.pointsFor,
}
const byGameDiff: Step = { label: 'game difference', compare: (x, y) => y.gameDiff - x.gameDiff }
const byPointDiff: Step = { label: 'point difference', compare: (x, y) => y.pointDiff - x.pointDiff }

/**
 * Order one tied group. Recursive: when a pass separates some but not all of a
 * tied set, the procedure restarts from step 1 on the remaining subset — which
 * means a three-way tie reduced to two is then settled by head-to-head, not by
 * reading off the mini-table order. That is the trap implementers fall into.
 */
function orderGroup(
  tied: TeamRow[],
  allMatches: StandingsMatch[],
  rule: TiebreakRule,
  depth: number,
): TeamRow[] {
  if (tied.length <= 1) return tied
  if (depth > 6) return tied // pathological; the organiser decides

  const ids = new Set(tied.map((t) => t.teamId))
  const among = allMatches.filter((m) => ids.has(m.teamAId) && ids.has(m.teamBId))

  const steps: Step[] =
    rule === 'points_scored_first' ? [byWinRatio, byPointsScored] : [byWinRatio]

  for (const step of steps) {
    const sorted = [...tied].sort(step.compare)
    const buckets = bucket(sorted, step.compare)
    if (buckets.length > 1) {
      return buckets.flatMap((b) =>
        b.length === 1
          ? tag(b, step.label, step)
          : orderGroup(b, allMatches, rule, depth + 1),
      )
    }
  }

  // Exactly two left → head-to-head.
  if (tied.length === 2) {
    const h = headToHead(tied[0].teamId, tied[1].teamId, among)
    if (h !== 0) {
      const ordered = h < 0 ? [tied[0], tied[1]] : [tied[1], tied[0]]
      // The rule doesn't stop the argument; the reason does.
      return [
        { ...ordered[0], reason: ordered[0].reason ?? `ahead on head-to-head` },
        { ...ordered[1], reason: ordered[1].reason ?? `behind on head-to-head` },
      ]
    }
  } else {
    // Three or more → a mini-table over only the matches among them.
    const mini = tallyRows([...ids], among)
    const miniRows = tied.map((t) => mini.get(t.teamId)!)
    for (const step of [byWinRatio, byGameDiff, byPointDiff]) {
      const sorted = [...miniRows].sort(step.compare)
      const buckets = bucket(sorted, step.compare)
      if (buckets.length > 1) {
        return buckets.flatMap((b) => {
          const back = b.map((r) => tied.find((t) => t.teamId === r.teamId)!)
          return back.length === 1
            ? tag(back, `${step.label} between the tied teams`)
            : orderGroup(back, allMatches, rule, depth + 1)
        })
      }
    }
  }

  // The order here has to match the sentence printed under the table. Under
  // `head_to_head_first` the footer promises points scored BEFORE the
  // difference columns, and it used to come last.
  const fallback: Step[] =
    rule === 'head_to_head_first'
      ? [byPointsScored, byGameDiff, byPointDiff]
      : [byGameDiff, byPointDiff, byPointsScored]
  for (const step of fallback) {
    const sorted = [...tied].sort(step.compare)
    const buckets = bucket(sorted, step.compare)
    if (buckets.length > 1) {
      return buckets.flatMap((b) =>
        b.length === 1 ? tag(b, step.label, step) : orderGroup(b, allMatches, rule, depth + 1),
      )
    }
  }

  return tag(tied, 'drawn — the organiser decides')
}

function bucket(sorted: TeamRow[], compare: (x: TeamRow, y: TeamRow) => number): TeamRow[][] {
  const out: TeamRow[][] = []
  for (const row of sorted) {
    const last = out[out.length - 1]
    if (last && compare(last[0], row) === 0) last.push(row)
    else out.push([row])
  }
  return out
}

function tag(rows: TeamRow[], label: string, step?: Step): TeamRow[] {
  return rows.map((r) => ({
    ...r,
    reason: r.reason ?? (step?.describe ? `${label} — ${step.describe(r)}` : label),
  }))
}

export function standings(
  teamIds: string[],
  matches: StandingsMatch[],
  rule: TiebreakRule = 'points_scored_first',
): TeamRow[] {
  const rows = [...tallyRows(teamIds, matches).values()]
  return orderGroup(rows, matches, rule, 0)
}

/** The sentence printed under every table, so the rule isn't folklore. */
export function tiebreakNote(rule: TiebreakRule): string {
  return rule === 'points_scored_first'
    ? 'Level on record: most total points scored goes through, then head-to-head, then game and point difference. Point difference is capped at 8 per game; a no-show counts as a win but adds nothing to points or difference.'
    : 'Level on record: head-to-head first, then total points scored, then game and point difference. Point difference is capped at 8 per game; a no-show counts as a win but adds nothing to points or difference.'
}
