import 'server-only'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import {
  categories,
  categoryPlayers,
  courts,
  groups,
  matches,
  matchSlots,
  games,
  players,
  teamPlayers,
  teams,
  tournamentPlayers,
  tournaments,
  venues,
} from '@/db/schema'
import { newId } from '@/lib/ids'
import { normalizeName, normalizePhone, type ParsedRow } from '@/lib/parse-players'
import { bumpStreamVersion } from '@/lib/stream'
import { buildDraw, seededShuffle, type DrawPlan, type SlotSource } from '@/lib/draw'
import { standings, type StandingsMatch } from '@/lib/standings'

export const VENUE_SLUG = 'madras-pickleball'

export async function getVenue() {
  const rows = await db.select().from(venues).where(eq(venues.slug, VENUE_SLUG)).limit(1)
  if (!rows[0]) throw new Error('Venue not seeded. Run npm run setup.')
  return rows[0]
}

export async function listCourts(venueId: string) {
  return db
    .select()
    .from(courts)
    .where(and(eq(courts.venueId, venueId), eq(courts.active, true)))
    .orderBy(asc(courts.sortOrder))
}

function slugify(name: string) {
  const base = normalizeName(name).replace(/\s+/g, '-').slice(0, 40) || 'tournament'
  return `${base}-${Math.random().toString(36).slice(2, 6)}`
}

export async function createTournament(input: {
  name: string
  startDate: Date
  endDate?: Date
  description?: string | null
}) {
  const venue = await getVenue()
  const id = newId('trn')
  await db.insert(tournaments).values({
    id,
    name: input.name,
    slug: slugify(input.name),
    venueId: venue.id,
    startDate: input.startDate,
    endDate: input.endDate ?? input.startDate,
    description: input.description ?? null,
    status: 'draft',
  })
  return (await db.select().from(tournaments).where(eq(tournaments.id, id)).limit(1))[0]
}

export async function getTournamentBySlug(slug: string) {
  const rows = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.slug, slug), isNull(tournaments.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

export async function listTournaments() {
  return db
    .select()
    .from(tournaments)
    .where(isNull(tournaments.deletedAt))
    .orderBy(desc(tournaments.startDate))
    .limit(30)
}

// ───────────────────────────── roster ─────────────────────────────

export async function rosterSnapshot() {
  return db
    .select({
      id: players.id,
      name: players.name,
      nameKey: players.nameKey,
      phoneKey: players.phoneKey,
    })
    .from(players)
    .where(isNull(players.deletedAt))
}

/**
 * Import a reviewed paste. Existing roster rows are reused rather than
 * duplicated — a career record built on duplicate rows is worse than none.
 */
export async function importPlayers(
  tournamentId: string,
  rows: Array<{ name: string; phone?: string | null; linkPlayerId?: string | null }>,
) {
  const roster = await rosterSnapshot()
  const byName = new Map(roster.map((r) => [r.nameKey, r.id]))
  const byPhone = new Map(roster.filter((r) => r.phoneKey).map((r) => [r.phoneKey!, r.id]))

  const playerIds: string[] = []

  for (const row of rows) {
    const name = row.name.trim()
    if (!name) continue
    const nameKey = normalizeName(name)
    const phoneKey = normalizePhone(row.phone)

    let playerId =
      row.linkPlayerId ?? (phoneKey ? byPhone.get(phoneKey) : undefined) ?? byName.get(nameKey)

    if (!playerId) {
      playerId = newId('ply')
      await db.insert(players).values({
        id: playerId,
        name,
        nameKey,
        phone: row.phone ?? null,
        phoneKey,
      })
      byName.set(nameKey, playerId)
      if (phoneKey) byPhone.set(phoneKey, playerId)
    }
    playerIds.push(playerId)
  }

  if (playerIds.length) {
    await db
      .insert(tournamentPlayers)
      .values(
        playerIds.map((playerId) => ({ id: newId('tp'), tournamentId, playerId })),
      )
      .onConflictDoNothing()
  }

  await bumpStreamVersion(tournamentId)
  return playerIds
}

export async function listTournamentPlayers(tournamentId: string) {
  return db
    .select({
      id: players.id,
      name: players.name,
      gender: players.gender,
      skill: players.skill,
      paid: tournamentPlayers.paid,
      withdrawn: tournamentPlayers.withdrawn,
    })
    .from(tournamentPlayers)
    .innerJoin(players, eq(players.id, tournamentPlayers.playerId))
    .where(eq(tournamentPlayers.tournamentId, tournamentId))
    .orderBy(asc(players.name))
}

// ──────────────────────────── categories ────────────────────────────

export async function createCategory(input: {
  tournamentId: string
  name: string
  discipline: 'singles' | 'doubles'
  gender: 'mens' | 'womens' | 'mixed' | 'any'
  finalsStage?: 'none' | 'final_only' | 'semis_and_final'
}) {
  const existing = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(categories)
    .where(eq(categories.tournamentId, input.tournamentId))

  const id = newId('cat')
  await db.insert(categories).values({
    id,
    tournamentId: input.tournamentId,
    name: input.name,
    discipline: input.discipline,
    gender: input.gender,
    finalsStage: input.finalsStage ?? 'final_only',
    seq: existing[0]?.n ?? 0,
    rngSeed: newId('seed'),
  })
  await bumpStreamVersion(input.tournamentId)
  return id
}

export async function listCategories(tournamentId: string) {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.tournamentId, tournamentId), isNull(categories.deletedAt)))
    .orderBy(asc(categories.seq))
}

export async function getCategory(categoryId: string) {
  const rows = await db.select().from(categories).where(eq(categories.id, categoryId)).limit(1)
  return rows[0] ?? null
}

export async function setCategoryPlayers(categoryId: string, playerIds: string[]) {
  await db.delete(categoryPlayers).where(eq(categoryPlayers.categoryId, categoryId))
  if (playerIds.length) {
    await db.insert(categoryPlayers).values(
      playerIds.map((playerId) => ({ id: newId('cp'), categoryId, playerId })),
    )
  }
}

export async function listCategoryPlayers(categoryId: string) {
  return db
    .select({
      id: players.id,
      name: players.name,
      gender: players.gender,
      substitute: categoryPlayers.substitute,
    })
    .from(categoryPlayers)
    .innerJoin(players, eq(players.id, categoryPlayers.playerId))
    .where(eq(categoryPlayers.categoryId, categoryId))
    .orderBy(asc(players.name))
}

/** Team names are generated — "Ravi / Priya" — never asked for (SPEC A2). */
function teamName(names: string[]) {
  return names.join(' / ')
}

export async function createTeams(
  categoryId: string,
  pairs: string[][],
  namesById: Map<string, string>,
) {
  await db.delete(teams).where(eq(teams.categoryId, categoryId))
  const created: string[] = []
  let seed = 1
  for (const pair of pairs) {
    if (pair.length === 0) continue
    const id = newId('tm')
    await db.insert(teams).values({
      id,
      categoryId,
      name: teamName(pair.map((p) => namesById.get(p) ?? '?')),
      seed: seed++,
    })
    await db
      .insert(teamPlayers)
      .values(pair.map((playerId, position) => ({ teamId: id, playerId, position })))
    created.push(id)
  }
  return created
}

/** Hand-pair the couples who always play together, let the app do the rest. */
export function pairRandomly(playerIds: string[], seed: string, teamSize: number): string[][] {
  const shuffled = seededShuffle(playerIds, seed)
  const pairs: string[][] = []
  for (let i = 0; i < shuffled.length; i += teamSize) {
    const chunk = shuffled.slice(i, i + teamSize)
    if (chunk.length === teamSize) pairs.push(chunk)
  }
  return pairs
}

export async function listTeams(categoryId: string) {
  const rows = await db
    .select({
      id: teams.id,
      name: teams.name,
      seed: teams.seed,
      status: teams.status,
      groupId: teams.groupId,
    })
    .from(teams)
    .where(eq(teams.categoryId, categoryId))
    .orderBy(asc(teams.seed))
  return rows
}

// ──────────────────────────── draw ────────────────────────────

async function resolveSource(
  source: SlotSource,
  keyToMatchId: Map<string, string>,
  groupIdByName: Map<string, string>,
) {
  switch (source.type) {
    case 'entry':
      return { sourceType: 'entry' as const, resolvedTeamId: source.teamId }
    case 'group_rank':
      return {
        sourceType: 'group_rank' as const,
        sourceGroupId: groupIdByName.get(source.groupName) ?? null,
        sourceRank: source.rank,
      }
    case 'winner_of':
      return {
        sourceType: 'winner_of' as const,
        sourceMatchId: keyToMatchId.get(source.matchKey) ?? null,
      }
    case 'loser_of':
      return {
        sourceType: 'loser_of' as const,
        sourceMatchId: keyToMatchId.get(source.matchKey) ?? null,
      }
    default:
      return { sourceType: 'bye' as const }
  }
}

/**
 * Persist a plan. Slots that are already known resolve immediately and the
 * match becomes `ready`; the rest wait on a group table or an earlier result.
 */
export async function persistDraw(categoryId: string, tournamentId: string, plan: DrawPlan) {
  await db.delete(matches).where(eq(matches.categoryId, categoryId))
  await db.delete(groups).where(eq(groups.categoryId, categoryId))

  const groupIdByName = new Map<string, string>()
  for (const [i, g] of plan.groups.entries()) {
    const id = newId('grp')
    groupIdByName.set(g.name, id)
    await db.insert(groups).values({
      id,
      categoryId,
      name: g.name,
      advanceCount: g.advanceCount,
      sortOrder: i,
    })
    if (g.teamIds.length) {
      await db.update(teams).set({ groupId: id }).where(inArray(teams.id, g.teamIds))
    }
  }

  const keyToMatchId = new Map<string, string>()
  for (const m of plan.matches) keyToMatchId.set(m.key, newId('mch'))

  for (const m of plan.matches) {
    const id = keyToMatchId.get(m.key)!
    const a = await resolveSource(m.slotA, keyToMatchId, groupIdByName)
    const b = await resolveSource(m.slotB, keyToMatchId, groupIdByName)
    const teamAId = 'resolvedTeamId' in a ? a.resolvedTeamId : null
    const teamBId = 'resolvedTeamId' in b ? b.resolvedTeamId : null

    await db.insert(matches).values({
      id,
      categoryId,
      tournamentId,
      stage: m.stage,
      roundIndex: m.roundIndex,
      roundName: m.roundName,
      seq: m.seq,
      groupId: m.groupName ? (groupIdByName.get(m.groupName) ?? null) : null,
      teamAId: teamAId ?? null,
      teamBId: teamBId ?? null,
      status: teamAId && teamBId ? 'ready' : 'pending',
    })

    for (const [slot, src] of [
      ['A', a],
      ['B', b],
    ] as const) {
      await db.insert(matchSlots).values({
        id: newId('slt'),
        matchId: id,
        slot,
        sourceType: src.sourceType,
        sourceMatchId: 'sourceMatchId' in src ? src.sourceMatchId : null,
        sourceGroupId: 'sourceGroupId' in src ? src.sourceGroupId : null,
        sourceRank: 'sourceRank' in src ? src.sourceRank : null,
        resolvedTeamId: 'resolvedTeamId' in src ? src.resolvedTeamId : null,
        resolvedAt: 'resolvedTeamId' in src ? new Date() : null,
      })
    }
  }

  await db
    .update(categories)
    .set({
      status: 'draw_locked',
      drawLockedAt: new Date(),
      drawVersion: sql`${categories.drawVersion} + 1`,
      seedOrder: plan.groups.flatMap((g) => g.teamIds),
      updatedAt: new Date(),
    })
    .where(eq(categories.id, categoryId))

  await bumpStreamVersion(tournamentId)
  return keyToMatchId.size
}

export async function generateDrawForCategory(categoryId: string) {
  const category = await getCategory(categoryId)
  if (!category) throw new Error('Category not found')
  const teamRows = await listTeams(categoryId)
  if (teamRows.length < 2) throw new Error('Need at least two teams')

  const seedOrder = teamRows.map((t) => t.id)
  const plan = buildDraw(
    seedOrder,
    category.drawType === 'groups_knockout' ? 'groups_knockout' : 'league',
    category.finalsStage === 'quarters_onward' ? 'semis_and_final' : category.finalsStage,
  )
  return persistDraw(categoryId, category.tournamentId, plan)
}

export async function listMatches(tournamentId: string) {
  const a = { id: teams.id, name: teams.name }
  void a
  return db
    .select({
      id: matches.id,
      categoryId: matches.categoryId,
      stage: matches.stage,
      roundIndex: matches.roundIndex,
      roundName: matches.roundName,
      seq: matches.seq,
      status: matches.status,
      resultState: matches.resultState,
      resultType: matches.resultType,
      teamAId: matches.teamAId,
      teamBId: matches.teamBId,
      winnerTeamId: matches.winnerTeamId,
      gamesWonA: matches.gamesWonA,
      gamesWonB: matches.gamesWonB,
      scoreSummary: matches.scoreSummary,
      courtId: matches.courtId,
      startedAt: matches.startedAt,
    })
    .from(matches)
    .where(eq(matches.tournamentId, tournamentId))
    .orderBy(asc(matches.roundIndex), asc(matches.seq))
}

/** Standings for one category, straight from the ledger (SPEC A6). */
export async function standingsFor(categoryId: string) {
  const category = await getCategory(categoryId)
  if (!category) return { rows: [], rule: 'points_scored_first' as const, teams: [] }

  const teamRows = await listTeams(categoryId)
  const matchRows = await db
    .select({
      id: matches.id,
      teamAId: matches.teamAId,
      teamBId: matches.teamBId,
      winnerTeamId: matches.winnerTeamId,
      resultState: matches.resultState,
      resultType: matches.resultType,
    })
    .from(matches)
    .where(and(eq(matches.categoryId, categoryId), eq(matches.stage, 'group')))

  const ids = matchRows.map((m) => m.id)
  const gameRows = ids.length
    ? await db.select().from(games).where(inArray(games.matchId, ids))
    : []
  const gamesByMatch = new Map<string, typeof gameRows>()
  for (const g of gameRows) {
    const list = gamesByMatch.get(g.matchId) ?? []
    list.push(g)
    gamesByMatch.set(g.matchId, list)
  }

  const input: StandingsMatch[] = matchRows
    .filter((m) => m.teamAId && m.teamBId && m.resultState !== 'none')
    .map((m) => ({
      matchId: m.id,
      teamAId: m.teamAId!,
      teamBId: m.teamBId!,
      winnerTeamId: m.winnerTeamId,
      state: m.resultState as StandingsMatch['state'],
      resultType: m.resultType as StandingsMatch['resultType'],
      games: (gamesByMatch.get(m.id) ?? [])
        .sort((x, y) => x.gameNo - y.gameNo)
        .map((g) => ({ scoreA: g.scoreA, scoreB: g.scoreB, excludeFromDiff: g.excludeFromDiff })),
    }))

  const rows = standings(
    teamRows.map((t) => t.id),
    input,
    category.tiebreakRule,
  )
  return { rows, rule: category.tiebreakRule, teams: teamRows }
}

/** Per-game scores for a whole tournament, for the "11-9, 8-11, 11-6" line. */
export async function gamesByMatch(tournamentId: string) {
  const rows = await db
    .select({
      matchId: games.matchId,
      gameNo: games.gameNo,
      scoreA: games.scoreA,
      scoreB: games.scoreB,
    })
    .from(games)
    .innerJoin(matches, eq(matches.id, games.matchId))
    .where(eq(matches.tournamentId, tournamentId))
    .orderBy(asc(games.gameNo))

  const out = new Map<string, Array<{ scoreA: number; scoreB: number }>>()
  for (const g of rows) {
    const list = out.get(g.matchId) ?? []
    list.push({ scoreA: g.scoreA, scoreB: g.scoreB })
    out.set(g.matchId, list)
  }
  return out
}

export async function teamNameMap(tournamentId: string) {
  const rows = await db
    .select({ id: teams.id, name: teams.name, categoryId: teams.categoryId })
    .from(teams)
    .innerJoin(categories, eq(categories.id, teams.categoryId))
    .where(eq(categories.tournamentId, tournamentId))
  return new Map(rows.map((r) => [r.id, r.name]))
}
