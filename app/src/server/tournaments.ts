import 'server-only'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { db, mapCase, transact } from '@/db'
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
import { normalizeName, normalizePhone } from '@/lib/parse-players'
import { bumpStreamVersion } from '@/lib/stream'
import { buildDraw, seededShuffle, type DrawPlan, type SlotSource } from '@/lib/draw'
import { standings, type StandingsMatch } from '@/lib/standings'
import { projectedState } from './scoring'

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
  const [row] = await db
    .insert(tournaments)
    .values({
      id: newId('trn'),
      name: input.name,
      slug: slugify(input.name),
      venueId: venue.id,
      startDate: input.startDate,
      endDate: input.endDate ?? input.startDate,
      description: input.description ?? null,
      status: 'draft',
    })
    // The row that was written, from the write itself — reading it back was a
    // second round trip to learn what we had just sent.
    .returning()
  return row
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
  // Collected, not written one at a time: a pasted list is forty names, and
  // forty inserts is forty round trips. The maps above still do the in-batch
  // dedupe, so a name that appears twice in one paste is still one player.
  const fresh: Array<typeof players.$inferInsert> = []

  for (const row of rows) {
    const name = row.name.trim()
    if (!name) continue
    const nameKey = normalizeName(name)
    const phoneKey = normalizePhone(row.phone)

    let playerId =
      row.linkPlayerId ?? (phoneKey ? byPhone.get(phoneKey) : undefined) ?? byName.get(nameKey)

    if (!playerId) {
      playerId = newId('ply')
      fresh.push({ id: playerId, name, nameKey, phone: row.phone ?? null, phoneKey })
      byName.set(nameKey, playerId)
      if (phoneKey) byPhone.set(phoneKey, playerId)
    }
    playerIds.push(playerId)
  }

  // All of it or none of it: a half-imported paste leaves the organiser
  // guessing which names took.
  await transact(async (tx) => {
    if (fresh.length) await tx.insert(players).values(fresh)
    if (playerIds.length) {
      await tx
        .insert(tournamentPlayers)
        .values(playerIds.map((playerId) => ({ id: newId('tp'), tournamentId, playerId })))
        .onConflictDoNothing()
    }
    await bumpStreamVersion(tournamentId, tx)
  })
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
  const id = newId('cat')
  await transact(async (tx) => {
    await tx.insert(categories).values({
      id,
      tournamentId: input.tournamentId,
      name: input.name,
      discipline: input.discipline,
      gender: input.gender,
      finalsStage: input.finalsStage ?? 'final_only',
      // Counted inside the insert rather than read first: one round trip
      // instead of two, and two admins adding a category at once can no longer
      // both be told they are number three.
      seq: sql`(select count(*)::int from ${categories} where ${categories.tournamentId} = ${input.tournamentId})`,
      rngSeed: newId('seed'),
    })
    await bumpStreamVersion(input.tournamentId, tx)
  })
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

/**
 * Replace the entry list. One transaction: the window between the delete and
 * the insert is a category with nobody in it, and a draw generated in that
 * window is a draw with no teams.
 */
export async function setCategoryPlayers(categoryId: string, playerIds: string[]) {
  await transact(async (tx) => {
    await tx.delete(categoryPlayers).where(eq(categoryPlayers.categoryId, categoryId))
    if (playerIds.length) {
      await tx.insert(categoryPlayers).values(
        playerIds.map((playerId) => ({ id: newId('cp'), categoryId, playerId })),
      )
    }
  })
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

/**
 * Build the whole set of teams for a category in three statements, inside one
 * transaction. Team-by-team it was two round trips per pair — and a failure
 * halfway left the category with the old teams deleted and half the new ones
 * written, which is a draw nobody can play.
 */
export async function createTeams(
  categoryId: string,
  pairs: string[][],
  namesById: Map<string, string>,
) {
  const created: string[] = []
  const teamRows: Array<typeof teams.$inferInsert> = []
  const memberRows: Array<typeof teamPlayers.$inferInsert> = []

  let seed = 1
  for (const pair of pairs) {
    if (pair.length === 0) continue
    const id = newId('tm')
    teamRows.push({
      id,
      categoryId,
      name: teamName(pair.map((p) => namesById.get(p) ?? '?')),
      seed: seed++,
    })
    for (const [position, playerId] of pair.entries()) {
      memberRows.push({ teamId: id, playerId, position })
    }
    created.push(id)
  }

  await transact(async (tx) => {
    await tx.delete(teams).where(eq(teams.categoryId, categoryId))
    if (teamRows.length) {
      await tx.insert(teams).values(teamRows)
      await tx.insert(teamPlayers).values(memberRows)
    }
  })
  return created
}

/**
 * The seed a category was created with. Random pairing has to be reproducible:
 * "why am I with him" is a question that gets asked, and re-running the draw
 * from a fresh seed the second time gives a different answer to the same
 * question (SPEC A2).
 */
export async function pairingSeedFor(categoryId: string): Promise<string> {
  const [row] = await db
    .select({ rngSeed: categories.rngSeed })
    .from(categories)
    .where(eq(categories.id, categoryId))
    .limit(1)
  if (row?.rngSeed) return row.rngSeed
  const seed = newId('seed')
  await db.update(categories).set({ rngSeed: seed }).where(eq(categories.id, categoryId))
  return seed
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

function resolveSource(
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
 *
 * The whole draw goes down as seven statements inside one transaction. It used
 * to be one insert per match and two per match slot — a hundred round trips for
 * a thirty-one match draw, which on a serverless host is the organiser watching
 * a spinner for several seconds. Worse, a failure in the middle left a category
 * with its old draw deleted and half a new one written, and there is no screen
 * in the product that can explain that state to anybody.
 */
export async function persistDraw(categoryId: string, tournamentId: string, plan: DrawPlan) {
  const groupIdByName = new Map<string, string>()
  const groupRows: Array<typeof groups.$inferInsert> = []
  const teamGroup: Array<readonly [string, string]> = []

  for (const [i, g] of plan.groups.entries()) {
    const id = newId('grp')
    groupIdByName.set(g.name, id)
    groupRows.push({ id, categoryId, name: g.name, advanceCount: g.advanceCount, sortOrder: i })
    for (const teamId of g.teamIds) teamGroup.push([teamId, id])
  }

  const keyToMatchId = new Map<string, string>()
  for (const m of plan.matches) keyToMatchId.set(m.key, newId('mch'))

  const now = new Date()
  const matchRows: Array<typeof matches.$inferInsert> = []
  const slotRows: Array<typeof matchSlots.$inferInsert> = []

  for (const m of plan.matches) {
    const id = keyToMatchId.get(m.key)!
    const a = resolveSource(m.slotA, keyToMatchId, groupIdByName)
    const b = resolveSource(m.slotB, keyToMatchId, groupIdByName)
    const teamAId = 'resolvedTeamId' in a ? a.resolvedTeamId : null
    const teamBId = 'resolvedTeamId' in b ? b.resolvedTeamId : null

    matchRows.push({
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
      slotRows.push({
        id: newId('slt'),
        matchId: id,
        slot,
        sourceType: src.sourceType,
        sourceMatchId: 'sourceMatchId' in src ? src.sourceMatchId : null,
        sourceGroupId: 'sourceGroupId' in src ? src.sourceGroupId : null,
        sourceRank: 'sourceRank' in src ? src.sourceRank : null,
        resolvedTeamId: 'resolvedTeamId' in src ? src.resolvedTeamId : null,
        resolvedAt: 'resolvedTeamId' in src ? now : null,
      })
    }
  }

  // The qualification line on both tables is drawn at `advance_per_group`, and
  // nothing ever wrote it — so it sat at its default of 2 while a
  // semis-and-final draw calls four teams through. The public table told 3rd
  // and 4th they were out, and then the board called them to a semi-final.
  const advance = Math.max(...plan.groups.map((g) => g.advanceCount), 0)

  await transact(async (tx) => {
    await tx.delete(matches).where(eq(matches.categoryId, categoryId))
    await tx.delete(groups).where(eq(groups.categoryId, categoryId))

    if (groupRows.length) await tx.insert(groups).values(groupRows)
    if (teamGroup.length) {
      await tx
        .update(teams)
        .set({ groupId: mapCase(teams.id, teamGroup) })
        .where(inArray(teams.id, teamGroup.map(([teamId]) => teamId)))
    }
    if (matchRows.length) await tx.insert(matches).values(matchRows)
    if (slotRows.length) await tx.insert(matchSlots).values(slotRows)

    await tx
      .update(categories)
      .set({
        advancePerGroup: advance,
        status: 'draw_locked',
        drawLockedAt: now,
        drawVersion: sql`${categories.drawVersion} + 1`,
        seedOrder: plan.groups.flatMap((g) => g.teamIds),
        updatedAt: now,
      })
      .where(eq(categories.id, categoryId))

    await bumpStreamVersion(tournamentId, tx)
  })

  return keyToMatchId.size
}

export async function generateDrawForCategory(categoryId: string) {
  const category = await getCategory(categoryId)
  if (!category) throw new Error('Category not found')
  // A pair that pulled out before the schedule was made is out of the day:
  // drawing them in gave them matches nobody would ever play.
  const teamRows = (await listTeams(categoryId)).filter((t) => t.status !== 'withdrawn')
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
  // Four independent reads — the table needs all of them and none of them needs
  // any of the others, so they go out together. The games are scoped by joining
  // back to the category rather than by a list of match ids, which is what
  // takes them off the end of the chain.
  const [category, teamRows, matchRows, gameRows] = await Promise.all([
    getCategory(categoryId),
    listTeams(categoryId),
    db
      .select({
        id: matches.id,
        teamAId: matches.teamAId,
        teamBId: matches.teamBId,
        winnerTeamId: matches.winnerTeamId,
        resultState: matches.resultState,
        reportedAt: matches.reportedAt,
        resultType: matches.resultType,
      })
      .from(matches)
      .where(and(eq(matches.categoryId, categoryId), eq(matches.stage, 'group'))),
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
      .where(and(eq(matches.categoryId, categoryId), eq(matches.stage, 'group'))),
  ])
  if (!category) return { rows: [], rule: 'points_scored_first' as const, teams: [] }

  const gamesByMatch = new Map<string, typeof gameRows>()
  for (const g of gameRows) {
    const list = gamesByMatch.get(g.matchId) ?? []
    list.push(g)
    gamesByMatch.set(g.matchId, list)
  }

  const input: StandingsMatch[] = matchRows
    .filter((m) => m.teamAId && m.teamBId && projectedState(m) !== 'none')
    .map((m) => ({
      matchId: m.id,
      teamAId: m.teamAId!,
      teamBId: m.teamBId!,
      winnerTeamId: m.winnerTeamId,
      // Projected, not stored: a result that auto-confirmed at the ten-minute
      // mark would otherwise read "Provisional" forever.
      state: projectedState(m) as StandingsMatch['state'],
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
