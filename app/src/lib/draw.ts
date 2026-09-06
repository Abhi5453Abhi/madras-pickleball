/**
 * Draw generation — SPEC A3.
 *
 * Two formats ship: League (one group, everyone plays everyone, optional finals)
 * and Groups → knockout (the same machinery with more than one pool). Single
 * elimination, plate draws and third-place matches are v1.1; the slot model
 * already carries `loser_of` so they are additive rather than a migration.
 *
 * Pure. Returns plain descriptors; persistence sits on top.
 */

export type SlotSource =
  | { type: 'entry'; teamId: string }
  | { type: 'group_rank'; groupName: string; rank: number }
  | { type: 'winner_of'; matchKey: string }
  | { type: 'loser_of'; matchKey: string }
  | { type: 'bye' }

export type MatchPlan = {
  /** Stable within one generation, used to wire slot sources together. */
  key: string
  stage: 'group' | 'knockout'
  groupName?: string
  roundIndex: number
  roundName: string
  seq: number
  slotA: SlotSource
  slotB: SlotSource
}

export type GroupPlan = { name: string; teamIds: string[]; advanceCount: number }

export type DrawPlan = { groups: GroupPlan[]; matches: MatchPlan[] }

export type FinalsStage = 'none' | 'final_only' | 'semis_and_final'

/**
 * Pools of 3 are never generated: two guaranteed matches, and one walkover
 * wrecks the pool. Below 8 entries it is always a single-group league.
 */
export function poolCountFor(teamCount: number): number {
  if (teamCount < 8) return 1
  let pools = teamCount >= 16 ? 4 : 2
  while (pools > 1 && Math.floor(teamCount / pools) <= 3) pools--
  return pools
}

/**
 * Serpentine, so the strongest entries don't land in the same pool:
 * 1,2,3,4 then 8,7,6,5 then 9,10,11,12…
 */
export function serpentineSplit(seedOrder: string[], poolCount: number): string[][] {
  const pools: string[][] = Array.from({ length: poolCount }, () => [])
  seedOrder.forEach((teamId, i) => {
    const row = Math.floor(i / poolCount)
    const col = i % poolCount
    const index = row % 2 === 0 ? col : poolCount - 1 - col
    pools[index].push(teamId)
  })
  return pools
}

const BYE = '__bye__'

/**
 * Circle method. Returns rounds of pairs; a team paired with BYE sits out.
 * Every pair meets exactly once.
 */
export function roundRobinRounds(teamIds: string[]): Array<Array<[string, string]>> {
  const teams = [...teamIds]
  if (teams.length < 2) return []
  if (teams.length % 2 === 1) teams.push(BYE)

  const n = teams.length
  const rounds: Array<Array<[string, string]>> = []
  const rotating = teams.slice(1)

  for (let r = 0; r < n - 1; r++) {
    const round: Array<[string, string]> = []
    const order = [teams[0], ...rotating]
    for (let i = 0; i < n / 2; i++) {
      const home = order[i]
      const away = order[n - 1 - i]
      if (home === BYE || away === BYE) continue
      // Alternate which side is listed first so nobody is always "team A".
      round.push(r % 2 === 0 ? [home, away] : [away, home])
    }
    rounds.push(round)
    rotating.unshift(rotating.pop()!)
  }

  return rounds
}

function knockoutRoundName(teamsInRound: number): string {
  if (teamsInRound === 2) return 'Final'
  if (teamsInRound === 4) return 'Semi-final'
  if (teamsInRound === 8) return 'Quarter-final'
  return `Round of ${teamsInRound}`
}

/**
 * League: one group, everyone plays everyone, then an optional finals stage.
 * Four teams is the worked example — three matches each, top two to the final.
 */
export function buildLeague(seedOrder: string[], finalsStage: FinalsStage): DrawPlan {
  const advanceCount = finalsStage === 'none' ? 0 : finalsStage === 'final_only' ? 2 : 4
  const groups: GroupPlan[] = [
    { name: 'League', teamIds: [...seedOrder], advanceCount: Math.min(advanceCount, seedOrder.length) },
  ]

  const matches: MatchPlan[] = []
  const rounds = roundRobinRounds(seedOrder)
  rounds.forEach((round, roundIndex) => {
    round.forEach(([a, b], i) => {
      matches.push({
        key: `g-${roundIndex}-${i}`,
        stage: 'group',
        groupName: 'League',
        roundIndex,
        roundName: `Round ${roundIndex + 1}`,
        seq: i,
        slotA: { type: 'entry', teamId: a },
        slotB: { type: 'entry', teamId: b },
      })
    })
  })

  const groupRounds = rounds.length
  if (finalsStage === 'final_only' && seedOrder.length >= 2) {
    matches.push({
      key: 'ko-final',
      stage: 'knockout',
      roundIndex: groupRounds,
      roundName: 'Final',
      seq: 0,
      slotA: { type: 'group_rank', groupName: 'League', rank: 1 },
      slotB: { type: 'group_rank', groupName: 'League', rank: 2 },
    })
  } else if (finalsStage === 'semis_and_final' && seedOrder.length >= 4) {
    matches.push(
      {
        key: 'ko-sf1',
        stage: 'knockout',
        roundIndex: groupRounds,
        roundName: 'Semi-final',
        seq: 0,
        slotA: { type: 'group_rank', groupName: 'League', rank: 1 },
        slotB: { type: 'group_rank', groupName: 'League', rank: 4 },
      },
      {
        key: 'ko-sf2',
        stage: 'knockout',
        roundIndex: groupRounds,
        roundName: 'Semi-final',
        seq: 1,
        slotA: { type: 'group_rank', groupName: 'League', rank: 2 },
        slotB: { type: 'group_rank', groupName: 'League', rank: 3 },
      },
      {
        key: 'ko-final',
        stage: 'knockout',
        roundIndex: groupRounds + 1,
        roundName: 'Final',
        seq: 0,
        slotA: { type: 'winner_of', matchKey: 'ko-sf1' },
        slotB: { type: 'winner_of', matchKey: 'ko-sf2' },
      },
    )
  }

  return { groups, matches }
}

/**
 * Groups → knockout. Top two from each pool advance, so the knockout field is
 * always exactly 4 or 8. Cross-pool pairing keeps pool winners apart in the
 * first knockout round.
 */
export function buildGroupsKnockout(seedOrder: string[], poolCount: number): DrawPlan {
  const pools = serpentineSplit(seedOrder, poolCount)
  const groups: GroupPlan[] = pools.map((teamIds, i) => ({
    name: `Group ${String.fromCharCode(65 + i)}`,
    teamIds,
    advanceCount: 2,
  }))

  const matches: MatchPlan[] = []
  let maxGroupRounds = 0

  groups.forEach((group, gi) => {
    const rounds = roundRobinRounds(group.teamIds)
    maxGroupRounds = Math.max(maxGroupRounds, rounds.length)
    rounds.forEach((round, roundIndex) => {
      round.forEach(([a, b], i) => {
        matches.push({
          key: `g${gi}-${roundIndex}-${i}`,
          stage: 'group',
          groupName: group.name,
          roundIndex,
          roundName: `${group.name} · Round ${roundIndex + 1}`,
          seq: matches.length,
          slotA: { type: 'entry', teamId: a },
          slotB: { type: 'entry', teamId: b },
        })
      })
    })
  })

  // Winner of A plays runner-up of B, and so on around the ring.
  const qualifiers: SlotSource[] = []
  groups.forEach((g, i) => {
    const other = groups[(i + 1) % groups.length]
    qualifiers.push({ type: 'group_rank', groupName: g.name, rank: 1 })
    qualifiers.push({ type: 'group_rank', groupName: other.name, rank: 2 })
  })

  const fieldSize = groups.length * 2
  let roundIndex = maxGroupRounds
  let previousKeys: string[] = []
  let teamsInRound = fieldSize

  while (teamsInRound >= 2) {
    const roundName = knockoutRoundName(teamsInRound)
    const pairs = teamsInRound / 2
    const keys: string[] = []
    for (let i = 0; i < pairs; i++) {
      const key = `ko-${roundIndex}-${i}`
      keys.push(key)
      const slotA: SlotSource =
        previousKeys.length === 0
          ? qualifiers[i * 2]
          : { type: 'winner_of', matchKey: previousKeys[i * 2] }
      const slotB: SlotSource =
        previousKeys.length === 0
          ? qualifiers[i * 2 + 1]
          : { type: 'winner_of', matchKey: previousKeys[i * 2 + 1] }
      matches.push({ key, stage: 'knockout', roundIndex, roundName, seq: i, slotA, slotB })
    }
    previousKeys = keys
    teamsInRound = pairs
    roundIndex++
  }

  return { groups, matches }
}

export function buildDraw(
  seedOrder: string[],
  drawType: 'league' | 'groups_knockout',
  finalsStage: FinalsStage,
): DrawPlan {
  if (drawType === 'league') return buildLeague(seedOrder, finalsStage)
  return buildGroupsKnockout(seedOrder, poolCountFor(seedOrder.length))
}

/** Deterministic shuffle from a stored seed, so a random draw is reproducible. */
export function seededShuffle<T>(items: T[], seed: string): T[] {
  let h = 2166136261
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  const rand = () => {
    h ^= h << 13
    h ^= h >>> 17
    h ^= h << 5
    return ((h >>> 0) % 100000) / 100000
  }
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}
