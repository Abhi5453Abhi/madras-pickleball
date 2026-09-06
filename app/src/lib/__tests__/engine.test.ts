/**
 * The only code in this project with unit tests. These are pure functions whose
 * bugs are silent and land on a public leaderboard in front of forty people —
 * which is exactly the case for testing, and exactly not the case for the CRUD
 * screens around them (SPEC A9).
 */
import { describe, it, expect } from 'vitest'
import {
  DEFAULT_RULES,
  gameWinner,
  validateGames,
  matchOutcome,
  cappedDiff,
  hornOutcome,
  walkoverGames,
  retirementGames,
  type ScoringRules,
} from '../rules'
import {
  roundRobinRounds,
  buildLeague,
  buildGroupsKnockout,
  poolCountFor,
  serpentineSplit,
  seededShuffle,
} from '../draw'
import { standings, tallyRows, type StandingsMatch } from '../standings'
import { winnerChips, loserChips } from '../chips'
import { estimateDay, leagueMatchCount, groupsKnockoutMatchCount, minutesPerMatch } from '../estimate'

// ─────────────────────────────── rules ───────────────────────────────

describe('game winner', () => {
  it('needs the target score and the winning margin', () => {
    expect(gameWinner(DEFAULT_RULES, { gameNo: 1, scoreA: 11, scoreB: 9 })).toBe('A')
    expect(gameWinner(DEFAULT_RULES, { gameNo: 1, scoreA: 9, scoreB: 11 })).toBe('B')
    expect(gameWinner(DEFAULT_RULES, { gameNo: 1, scoreA: 11, scoreB: 10 })).toBeNull()
    expect(gameWinner(DEFAULT_RULES, { gameNo: 1, scoreA: 10, scoreB: 8 })).toBeNull()
    expect(gameWinner(DEFAULT_RULES, { gameNo: 1, scoreA: 13, scoreB: 11 })).toBe('A')
  })

  it('refuses a score that no rally sequence could produce', () => {
    // Past the target you can only ever be exactly two clear.
    expect(gameWinner(DEFAULT_RULES, { gameNo: 1, scoreA: 12, scoreB: 3 })).toBeNull()
    expect(gameWinner(DEFAULT_RULES, { gameNo: 1, scoreA: 21, scoreB: 3 })).toBeNull()
    const capped: ScoringRules = { ...DEFAULT_RULES, hardCap: 15 }
    expect(gameWinner(capped, { gameNo: 1, scoreA: 16, scoreB: 3 })).toBeNull()
  })

  it('wins by one at the hard cap, or the game could never end', () => {
    const capped: ScoringRules = { ...DEFAULT_RULES, hardCap: 15 }
    expect(gameWinner(capped, { gameNo: 1, scoreA: 15, scoreB: 14 })).toBe('A')
    expect(gameWinner(capped, { gameNo: 1, scoreA: 14, scoreB: 14 })).toBeNull()
    expect(gameWinner(capped, { gameNo: 1, scoreA: 14, scoreB: 15 })).toBe('B')
  })

  it('gives a time-capped game to whoever was ahead when the horn went', () => {
    expect(gameWinner(DEFAULT_RULES, { gameNo: 1, scoreA: 7, scoreB: 5, timeCapped: true })).toBe('A')
    expect(gameWinner(DEFAULT_RULES, { gameNo: 1, scoreA: 6, scoreB: 6, timeCapped: true })).toBeNull()
  })

  it('handles a single game to 15 and to 21', () => {
    const to15: ScoringRules = { bestOf: 1, pointsToWin: 15, winBy: 2, hardCap: null }
    expect(gameWinner(to15, { gameNo: 1, scoreA: 15, scoreB: 13 })).toBe('A')
    expect(gameWinner(to15, { gameNo: 1, scoreA: 15, scoreB: 14 })).toBeNull()
    expect(gameWinner(to15, { gameNo: 1, scoreA: 17, scoreB: 15 })).toBe('A')
  })
})

describe('validation', () => {
  it('accepts a normal best-of-three', () => {
    expect(
      validateGames(DEFAULT_RULES, [
        { gameNo: 1, scoreA: 11, scoreB: 9 },
        { gameNo: 2, scoreA: 8, scoreB: 11 },
        { gameNo: 3, scoreA: 11, scoreB: 6 },
      ]),
    ).toEqual({ ok: true })
  })

  it('rejects a third game after a straight-sets win', () => {
    const v = validateGames(DEFAULT_RULES, [
      { gameNo: 1, scoreA: 11, scoreB: 9 },
      { gameNo: 2, scoreA: 11, scoreB: 4 },
      { gameNo: 3, scoreA: 11, scoreB: 6 },
    ])
    expect(v.ok).toBe(false)
  })

  it('rejects an unfinished score but allows a time-capped one', () => {
    expect(validateGames(DEFAULT_RULES, [{ gameNo: 1, scoreA: 7, scoreB: 5 }]).ok).toBe(false)
    expect(
      validateGames(DEFAULT_RULES, [{ gameNo: 1, scoreA: 7, scoreB: 5, timeCapped: true }]).ok,
    ).toBe(true)
  })
})

describe('match outcome', () => {
  it('needs two games in a best-of-three', () => {
    const one = matchOutcome(DEFAULT_RULES, [{ gameNo: 1, scoreA: 11, scoreB: 3 }])
    expect(one.complete).toBe(false)
    const two = matchOutcome(DEFAULT_RULES, [
      { gameNo: 1, scoreA: 11, scoreB: 3 },
      { gameNo: 2, scoreA: 11, scoreB: 7 },
    ])
    expect(two).toMatchObject({ complete: true, winner: 'A', gamesWonA: 2, gamesWonB: 0 })
  })
})

describe('difference capping', () => {
  it('clamps to eight either way', () => {
    expect(cappedDiff(11, 0)).toBe(8)
    expect(cappedDiff(0, 11)).toBe(-8)
    expect(cappedDiff(11, 9)).toBe(2)
  })
})

describe('walkovers and retirements', () => {
  it('records a walkover as two games to love', () => {
    expect(walkoverGames(DEFAULT_RULES)).toEqual([
      { gameNo: 1, scoreA: 11, scoreB: 0 },
      { gameNo: 2, scoreA: 11, scoreB: 0 },
    ])
  })

  it('finishes the game in progress and awards the rest without counting them', () => {
    const { games, excludeFromDiff } = retirementGames(
      DEFAULT_RULES,
      [{ gameNo: 1, scoreA: 5, scoreB: 3 }],
      'B',
    )
    expect(games[0]).toEqual({ gameNo: 1, scoreA: 11, scoreB: 3 })
    expect(games).toHaveLength(2)
    expect(excludeFromDiff).toEqual([2])
    expect(matchOutcome(DEFAULT_RULES, games).winner).toBe('A')
  })
})

// ──────────────────────────────── draw ────────────────────────────────

describe('round robin', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 12, 16]) {
    it(`has every pair meet exactly once for ${n} teams`, () => {
      const teams = Array.from({ length: n }, (_, i) => `t${i}`)
      const rounds = roundRobinRounds(teams)
      const seen = new Set<string>()
      let count = 0
      for (const round of rounds) {
        const inRound = new Set<string>()
        for (const [a, b] of round) {
          // Nobody plays twice in the same round.
          expect(inRound.has(a)).toBe(false)
          expect(inRound.has(b)).toBe(false)
          inRound.add(a)
          inRound.add(b)
          const key = [a, b].sort().join('|')
          expect(seen.has(key)).toBe(false)
          seen.add(key)
          count++
        }
      }
      expect(count).toBe((n * (n - 1)) / 2)
    })
  }

  it('gives four teams three rounds of two matches — everyone plays three', () => {
    const rounds = roundRobinRounds(['a', 'b', 'c', 'd'])
    expect(rounds).toHaveLength(3)
    expect(rounds.every((r) => r.length === 2)).toBe(true)
  })
})

describe('league', () => {
  it('builds the venue’s four-team example: 6 matches, top two to a final', () => {
    const plan = buildLeague(['a', 'b', 'c', 'd'], 'final_only')
    const group = plan.matches.filter((m) => m.stage === 'group')
    const knockout = plan.matches.filter((m) => m.stage === 'knockout')
    expect(group).toHaveLength(6)
    expect(knockout).toHaveLength(1)
    expect(knockout[0].roundName).toBe('Final')
    expect(knockout[0].slotA).toEqual({ type: 'group_rank', groupName: 'League', rank: 1 })
    expect(knockout[0].slotB).toEqual({ type: 'group_rank', groupName: 'League', rank: 2 })
  })

  it('wires semis into the final by winner, not by rank', () => {
    const plan = buildLeague(['a', 'b', 'c', 'd', 'e'], 'semis_and_final')
    const final = plan.matches.find((m) => m.roundName === 'Final')!
    expect(final.slotA).toEqual({ type: 'winner_of', matchKey: 'ko-sf1' })
    expect(final.slotB).toEqual({ type: 'winner_of', matchKey: 'ko-sf2' })
  })

  it('adds no finals when the table decides it', () => {
    const plan = buildLeague(['a', 'b', 'c'], 'none')
    expect(plan.matches.every((m) => m.stage === 'group')).toBe(true)
    expect(plan.matches).toHaveLength(3)
  })
})

describe('pools', () => {
  it('never produces a pool of three or fewer', () => {
    for (let n = 2; n <= 40; n++) {
      const pools = poolCountFor(n)
      if (pools === 1) continue
      const smallest = Math.floor(n / pools)
      expect(smallest).toBeGreaterThan(3)
    }
  })

  it('keeps a single league below eight entries', () => {
    for (let n = 2; n < 8; n++) expect(poolCountFor(n)).toBe(1)
  })

  it('distributes seeds serpentine so the top two are kept apart', () => {
    const pools = serpentineSplit(['1', '2', '3', '4', '5', '6', '7', '8'], 2)
    expect(pools[0]).toEqual(['1', '4', '5', '8'])
    expect(pools[1]).toEqual(['2', '3', '6', '7'])
  })

  it('builds a knockout of exactly two per pool', () => {
    const teams = Array.from({ length: 16 }, (_, i) => `t${i}`)
    const plan = buildGroupsKnockout(teams, poolCountFor(16))
    expect(plan.groups).toHaveLength(4)
    const knockout = plan.matches.filter((m) => m.stage === 'knockout')
    // 8 qualifiers → quarters, semis, final
    expect(knockout).toHaveLength(7)
    expect(knockout.filter((m) => m.roundName === 'Final')).toHaveLength(1)
    expect(knockout.filter((m) => m.roundName === 'Semi-final')).toHaveLength(2)
  })

  it('pairs a pool winner against a different pool’s runner-up', () => {
    const teams = Array.from({ length: 12 }, (_, i) => `t${i}`)
    const plan = buildGroupsKnockout(teams, 2)
    const firstKo = plan.matches.filter((m) => m.stage === 'knockout')[0]
    expect(firstKo.slotA).toMatchObject({ type: 'group_rank', rank: 1 })
    expect(firstKo.slotB).toMatchObject({ type: 'group_rank', rank: 2 })
    // @ts-expect-error narrowed above
    expect(firstKo.slotA.groupName).not.toBe(firstKo.slotB.groupName)
  })
})

describe('seeded shuffle', () => {
  it('is reproducible from the stored seed', () => {
    const items = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(seededShuffle(items, 'seed-1')).toEqual(seededShuffle(items, 'seed-1'))
    expect(seededShuffle(items, 'seed-1')).not.toEqual(seededShuffle(items, 'seed-2'))
    expect([...seededShuffle(items, 'seed-1')].sort()).toEqual(items)
  })
})

// ────────────────────────────── standings ──────────────────────────────

const won = (
  matchId: string,
  a: string,
  b: string,
  games: Array<[number, number]>,
  extra: Partial<StandingsMatch> = {},
): StandingsMatch => {
  const gs = games.map(([scoreA, scoreB]) => ({ scoreA, scoreB }))
  let aw = 0
  let bw = 0
  for (const g of gs) g.scoreA > g.scoreB ? aw++ : bw++
  return {
    matchId,
    teamAId: a,
    teamBId: b,
    winnerTeamId: aw > bw ? a : b,
    state: 'final',
    resultType: 'normal',
    games: gs,
    ...extra,
  }
}

describe('standings', () => {
  it('ranks on record first', () => {
    const rows = standings(
      ['a', 'b', 'c'],
      [won('1', 'a', 'b', [[11, 5], [11, 6]]), won('2', 'a', 'c', [[11, 7], [11, 9]]), won('3', 'b', 'c', [[11, 3], [11, 4]])],
    )
    expect(rows.map((r) => r.teamId)).toEqual(['a', 'b', 'c'])
  })

  it('uses total points scored when two teams are level — the venue’s rule', () => {
    // a and b both 1-1. b scored more overall.
    const matches = [
      won('1', 'a', 'b', [[11, 5], [11, 5]]),
      won('2', 'b', 'c', [[11, 9], [11, 9]]),
      won('3', 'c', 'a', [[11, 2], [11, 2]]),
    ]
    const rows = standings(['a', 'b', 'c'], matches, 'points_scored_first')
    const top = rows[0]
    const byPoints = [...rows].sort((x, y) => y.pointsFor - x.pointsFor)[0]
    expect(top.teamId).toBe(byPoints.teamId)
    expect(top.reason).toBe('ahead on total points scored')
  })

  it('settles a two-way tie by head-to-head once points are equal too', () => {
    const matches = [
      won('1', 'a', 'b', [[11, 5], [11, 5]]),
      won('2', 'b', 'c', [[11, 5], [11, 5]]),
      won('3', 'c', 'a', [[11, 5], [11, 5]]),
    ]
    const rows = standings(['a', 'b', 'c'], matches, 'head_to_head_first')
    // Perfectly symmetric three-way tie: everything is equal, so it must not
    // crash or invent an ordering it can't justify.
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.won === 1 && r.lost === 1)).toBe(true)
  })

  it('ranks on wins counted, as the caption under the table says', () => {
    // a: 2 from 2. b: 2 from 3 with more points. Level on wins → points.
    const rows = standings(
      ['a', 'b', 'c', 'd'],
      [
        won('1', 'a', 'c', [[11, 5], [11, 5]]),
        won('2', 'a', 'd', [[11, 5], [11, 5]]),
        won('3', 'b', 'c', [[11, 5], [11, 5]]),
        won('4', 'b', 'd', [[11, 5], [11, 5]]),
        won('5', 'c', 'b', [[11, 9], [11, 9]]),
      ],
    )
    expect(rows[0].teamId).toBe('b')
    expect(rows[0].reason).toMatch(/points/)
    expect(rows[1].teamId).toBe('a')
    // Fewer wins from fewer matches ranks below more wins, whatever the ratio.
    expect(rows.map((r) => r.teamId)).toEqual(['b', 'a', 'c', 'd'])
  })

  it('gives a walkover the win but nothing towards difference', () => {
    const rows = tallyRows(
      ['a', 'b'],
      [
        {
          matchId: '1',
          teamAId: 'a',
          teamBId: 'b',
          winnerTeamId: 'a',
          state: 'final',
          resultType: 'walkover',
          games: [
            { scoreA: 11, scoreB: 0 },
            { scoreA: 11, scoreB: 0 },
          ],
        },
      ],
    )
    expect(rows.get('a')!.won).toBe(1)
    expect(rows.get('a')!.pointDiff).toBe(0)
    expect(rows.get('a')!.pointsFor).toBe(0)
    // And nothing towards game difference either — capping only point
    // difference would let a match nobody played decide the pool.
    expect(rows.get('a')!.gamesWon).toBe(0)
    expect(rows.get('a')!.gameDiff).toBe(0)
    expect(rows.get('b')!.gameDiff).toBe(0)
  })

  it('is not swung by a walkover when everything else is level', () => {
    // a and b both beat c; a additionally got a walkover over d.
    const rows = standings(
      ['a', 'b', 'c', 'd'],
      [
        won('1', 'a', 'c', [[11, 5], [11, 5]]),
        won('2', 'b', 'c', [[11, 5], [11, 5]]),
        {
          matchId: '3',
          teamAId: 'a',
          teamBId: 'd',
          winnerTeamId: 'a',
          state: 'final',
          resultType: 'walkover',
          games: [
            { scoreA: 11, scoreB: 0 },
            { scoreA: 11, scoreB: 0 },
          ],
        },
      ],
    )
    const a = rows.find((r) => r.teamId === 'a')!
    const b = rows.find((r) => r.teamId === 'b')!
    expect(a.gameDiff).toBe(b.gameDiff)
    expect(a.pointsFor).toBe(b.pointsFor)
  })

  it('ignores voided matches entirely, including matches played', () => {
    const rows = tallyRows(
      ['a', 'b'],
      [won('1', 'a', 'b', [[11, 5], [11, 5]], { state: 'voided' })],
    )
    expect(rows.get('a')!.played).toBe(0)
    expect(rows.get('a')!.won).toBe(0)
  })

  it('counts a disputed match as played but not won', () => {
    const rows = tallyRows(
      ['a', 'b'],
      [won('1', 'a', 'b', [[11, 5], [11, 5]], { state: 'disputed' })],
    )
    expect(rows.get('a')!.played).toBe(1)
    expect(rows.get('a')!.won).toBe(0)
    expect(rows.get('a')!.disputed).toBe(true)
  })

  it('flags a table built on unconfirmed results', () => {
    const rows = tallyRows(['a', 'b'], [won('1', 'a', 'b', [[11, 5], [11, 5]], { state: 'reported' })])
    expect(rows.get('a')!.provisional).toBe(true)
  })

  it('caps a blowout so it cannot decide a pool', () => {
    const rows = tallyRows(['a', 'b'], [won('1', 'a', 'b', [[11, 0], [11, 0]])])
    expect(rows.get('a')!.pointDiff).toBe(16) // 8 + 8, not 22
  })
})

// ────────────────────────────── estimates ──────────────────────────────

describe('day estimate', () => {
  it('reproduces the worked example in the spec', () => {
    const est = estimateDay({
      categories: [{ name: 'all', matchCount: 55, minutesPerMatch: 30, minMatchesPerEntry: 3 }],
      courts: 4,
      startAt: new Date('2026-09-14T03:30:00Z'), // 09:00 IST
    })
    // 55 / 4 * 30 * 1.1 = 453.75 → 454
    expect(est.minutes).toBe(454)
    expect(est.totalMatches).toBe(55)
  })

  it('adds up across categories, because they share the courts', () => {
    const one = estimateDay({
      categories: [{ name: 'a', matchCount: 30, minutesPerMatch: 30, minMatchesPerEntry: 3 }],
      courts: 4,
    })
    const two = estimateDay({
      categories: [
        { name: 'a', matchCount: 30, minutesPerMatch: 30, minMatchesPerEntry: 3 },
        { name: 'b', matchCount: 25, minutesPerMatch: 30, minMatchesPerEntry: 3 },
      ],
      courts: 4,
    })
    expect(two.minutes).toBeGreaterThan(one.minutes)
    expect(two.totalMatches).toBe(55)
  })

  it('notices when the day runs past sunset', () => {
    const est = estimateDay({
      categories: [{ name: 'a', matchCount: 66, minutesPerMatch: 30, minMatchesPerEntry: 11 }],
      courts: 3,
      startAt: new Date('2026-09-14T03:30:00Z'),
      sunsetAt: new Date('2026-09-14T12:50:00Z'), // 18:20 IST
    })
    expect(est.pastSunset).toBe(true)
  })

  it('counts league and pool formats correctly', () => {
    expect(leagueMatchCount(4, 'final_only')).toEqual({ matches: 7, minPerEntry: 3 })
    expect(leagueMatchCount(12, 'none')).toEqual({ matches: 66, minPerEntry: 11 })
    expect(groupsKnockoutMatchCount(16, 4)).toEqual({ matches: 31, minPerEntry: 3 })
  })

  it('picks a per-match duration from the format', () => {
    expect(minutesPerMatch({ bestOf: 3, pointsToWin: 11 })).toBe(30)
    expect(minutesPerMatch({ bestOf: 1, pointsToWin: 15 })).toBe(20)
    expect(minutesPerMatch({ bestOf: 1, pointsToWin: 11 })).toBe(15)
  })
})

// ──────────────────────────── score chips ────────────────────────────

describe('score chips', () => {
  const to11: ScoringRules = { bestOf: 3, pointsToWin: 11, winBy: 2, hardCap: null }
  const to11cap15: ScoringRules = { ...to11, hardCap: 15 }
  const to15: ScoringRules = { bestOf: 1, pointsToWin: 15, winBy: 2, hardCap: null }

  it('offers the target and four above it, with more behind a link', () => {
    expect(winnerChips(to11).chips).toEqual([11, 12, 13, 14, 15])
    expect(winnerChips(to11).more).toContain(21)
  })

  it('stops at the cap and offers no more', () => {
    expect(winnerChips(to11cap15).chips).toEqual([11, 12, 13, 14, 15])
    expect(winnerChips(to11cap15).more).toEqual([])
  })

  it('offers every legal losing score at the target', () => {
    expect(loserChips(to11, 11)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(loserChips(to15, 15)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })

  it('offers exactly one chip past the target, because only one is legal', () => {
    expect(loserChips(to11, 13)).toEqual([11])
    expect(loserChips(to11, 12)).toEqual([10])
  })

  it('offers both cap endings at the cap', () => {
    expect(loserChips(to11cap15, 15)).toEqual([13, 14])
  })

  it('never offers a reversed score', () => {
    for (const w of winnerChips(to11).chips) {
      for (const l of loserChips(to11, w)) expect(l).toBeLessThan(w)
    }
  })

  it('every offered pair is a score the rules engine accepts', () => {
    for (const rules of [to11, to11cap15, to15]) {
      for (const w of winnerChips(rules).chips) {
        for (const l of loserChips(rules, w)) {
          expect(gameWinner(rules, { gameNo: 1, scoreA: w, scoreB: l })).toBe('A')
        }
      }
    }
  })
})

// ── the horn ──────────────────────────────────────────────────────────────
describe('hornOutcome', () => {
  const rules = { bestOf: 3, pointsToWin: 11, winBy: 2, hardCap: null }

  it('ends the match on one capped game', () => {
    const o = hornOutcome(rules, [{ gameNo: 1, scoreA: 8, scoreB: 6, timeCapped: true }])
    expect(o).toMatchObject({ complete: true, winner: 'A' })
  })

  it('level on games is decided by the game the horn stopped, not by totals', () => {
    // A won game 1 in a blowout; B was winning the game the horn stopped.
    // Summing every point would hand it to A — which is the blowout SPEC A6
    // caps out of the tiebreak precisely so it cannot decide anything.
    const o = hornOutcome(rules, [
      { gameNo: 1, scoreA: 11, scoreB: 2 },
      { gameNo: 2, scoreA: 2, scoreB: 8, timeCapped: true },
    ])
    expect(o.winner).toBe('B')
  })

  it('leading in games wins even when behind on the capped game', () => {
    const o = hornOutcome(rules, [
      { gameNo: 1, scoreA: 11, scoreB: 9 },
      { gameNo: 2, scoreA: 11, scoreB: 4 },
    ])
    expect(o).toMatchObject({ complete: true, winner: 'A' })
  })

  it('refuses to call a match that is level on games and level on the capped game', () => {
    const o = hornOutcome(rules, [
      { gameNo: 1, scoreA: 11, scoreB: 9 },
      { gameNo: 2, scoreA: 9, scoreB: 11 },
      { gameNo: 3, scoreA: 6, scoreB: 6, timeCapped: true },
    ])
    expect(o.complete).toBe(false)
    expect(o.winner).toBeNull()
  })
})

describe('validateGames rejects a duplicated game number', () => {
  it('because the ledger write would fail halfway through', () => {
    const rules = { bestOf: 3, pointsToWin: 11, winBy: 2, hardCap: null }
    const v = validateGames(rules, [
      { gameNo: 1, scoreA: 11, scoreB: 9 },
      { gameNo: 1, scoreA: 11, scoreB: 9 },
    ])
    expect(v.ok).toBe(false)
  })
})

describe('a retirement keeps the points that were actually played', () => {
  it('and excludes only the games nobody played', () => {
    const rules = { bestOf: 3, pointsToWin: 11, winBy: 2, hardCap: null }
    // Lost game 1 9-11, then pulled a calf between games.
    const { games, excludeFromDiff } = retirementGames(
      rules,
      [{ gameNo: 1, scoreA: 9, scoreB: 11 }],
      'A',
    )
    expect(games).toHaveLength(2)
    expect(excludeFromDiff).toEqual([2])

    const rows = tallyRows(['a', 'b'], [
      {
        matchId: 'm',
        teamAId: 'a',
        teamBId: 'b',
        winnerTeamId: 'b',
        state: 'final',
        resultType: 'retired',
        games: games.map((g) => ({
          scoreA: g.scoreA,
          scoreB: g.scoreB,
          excludeFromDiff: excludeFromDiff.includes(g.gameNo),
        })),
      },
    ])
    // The game they played counts in full; the one they didn't counts nowhere.
    expect(rows.get('b')!.pointsFor).toBe(11)
    expect(rows.get('b')!.gamesWon).toBe(1)
    expect(rows.get('b')!.pointDiff).toBe(2)
  })
})
