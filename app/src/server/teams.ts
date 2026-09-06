import 'server-only'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { db, transact, type Tx } from '@/db'
import { matches, players, teamPlayers, teams, tournamentPlayers } from '@/db/schema'
import { newId } from '@/lib/ids'
import { bumpStreamVersion } from '@/lib/stream'
import { primaryCategory } from './events'
import { pairingSeedFor, pairRandomly } from './tournaments'

/**
 * Teams — SPEC v4.
 *
 * Doubles only; singles skips the step. Two people who named each other are a
 * pair the moment the screen loads. Everyone else the organiser pairs by hand
 * or at random, and can split and re-make until the schedule exists. After
 * that the pairs are the draw, and changing them is a fix under More.
 *
 * Nothing here touches `category_players` — registration owns that list — and
 * nothing here rebuilds the whole set of teams. `createTeams` in tournaments.ts
 * replaces every team; a pair made by hand has to survive the next one.
 */

export type BoardPlayer = { id: string; name: string }

export type BoardPair = {
  teamId: string
  name: string
  players: BoardPlayer[]
  /** Derived, not stored: `mutual` when both members named each other. */
  how: 'mutual' | 'organiser'
}

export type Unpaired = {
  id: string
  name: string
  /** The partner they asked for, as typed; null when they named nobody. */
  wishText: string | null
  /** The roster player that wish resolved to, when they are still in. */
  wishPlayerId: string | null
  wishPlayerName: string | null
  /** They and the person they want name each other. Should not stay unpaired. */
  mutual: boolean
  /**
   * The grey phrase on the right — "Suresh named Ganesh", "not mutual" —
   * or null when there is nothing to say and the row offers "Pair with…".
   */
  note: string | null
}

export type TeamBoard = {
  discipline: 'singles' | 'doubles'
  pairs: BoardPair[]
  unpaired: Unpaired[]
  /** How many pairs the roster makes (singles: how many players). */
  needed: number
  /** The schedule exists. Nothing on this screen can change any more. */
  locked: boolean
}

export const LOCKED_MESSAGE = 'The schedule is made. Changing pairs is under More.'

type RosterRow = {
  id: string
  name: string
  wishText: string | null
  wishPlayerId: string | null
}

type TeamRow = {
  teamId: string
  name: string
  seed: number | null
  status: string
  players: Array<{ id: string; position: number }>
}

/** Everyone who is in: on the tournament's list and not withdrawn. */
async function activeRoster(tournamentId: string): Promise<RosterRow[]> {
  return db
    .select({
      id: players.id,
      name: players.name,
      wishText: tournamentPlayers.partnerWish,
      wishPlayerId: tournamentPlayers.partnerPlayerId,
    })
    .from(tournamentPlayers)
    .innerJoin(players, eq(players.id, tournamentPlayers.playerId))
    .where(
      and(eq(tournamentPlayers.tournamentId, tournamentId), eq(tournamentPlayers.withdrawn, false)),
    )
    .orderBy(asc(players.name))
}

async function teamsIn(categoryId: string): Promise<TeamRow[]> {
  const rows = await db
    .select({
      teamId: teams.id,
      name: teams.name,
      seed: teams.seed,
      status: teams.status,
      playerId: teamPlayers.playerId,
      position: teamPlayers.position,
    })
    .from(teams)
    .leftJoin(teamPlayers, eq(teamPlayers.teamId, teams.id))
    .where(eq(teams.categoryId, categoryId))
    .orderBy(asc(teams.seed), asc(teamPlayers.position))

  const out = new Map<string, TeamRow>()
  for (const r of rows) {
    let t = out.get(r.teamId)
    if (!t) {
      t = { teamId: r.teamId, name: r.name, seed: r.seed, status: r.status, players: [] }
      out.set(r.teamId, t)
    }
    if (r.playerId) t.players.push({ id: r.playerId, position: r.position ?? 0 })
  }
  return [...out.values()]
}

/** The schedule is made once any match exists — played or not. */
async function isLocked(tournamentId: string) {
  const [m] = await db
    .select({ id: matches.id })
    .from(matches)
    .where(eq(matches.tournamentId, tournamentId))
    .limit(1)
  return !!m
}

/** Team names are generated — "Ravi / Priya" — never asked for (SPEC A2). */
function teamName(names: string[]) {
  return names.join(' / ')
}

/**
 * Write one team. Seeds are unique per category, so the next one is
 * max + 1; names are unique per category too, which two players called Ravi
 * in a singles draw would otherwise trip over.
 */
async function insertTeam(tx: Tx, categoryId: string, members: BoardPlayer[]) {
  const [agg] = await tx
    .select({ seed: sql<number>`coalesce(max(${teams.seed}), 0)::int` })
    .from(teams)
    .where(eq(teams.categoryId, categoryId))
  const taken = new Set(
    (
      await tx.select({ name: teams.name }).from(teams).where(eq(teams.categoryId, categoryId))
    ).map((r) => r.name),
  )
  const base = teamName(members.map((m) => m.name))
  let name = base
  for (let n = 2; taken.has(name); n++) name = `${base} (${n})`

  const id = newId('tm')
  await tx.insert(teams).values({ id, categoryId, name, seed: (agg?.seed ?? 0) + 1 })
  await tx
    .insert(teamPlayers)
    .values(members.map((m, position) => ({ teamId: id, playerId: m.id, position })))
  return id
}

/**
 * Doubles housekeeping, run on every load before the schedule exists:
 *
 *   - a pair with a member who has since left is undone, so the one still in
 *     goes back to the pile rather than sitting in a team of one;
 *   - two people in the pile who named each other become a pair.
 *
 * Idempotent: a second run finds nothing to do. Returns whether anything moved.
 */
async function settleDoubles(
  tournamentId: string,
  categoryId: string,
  roster: RosterRow[],
  teamRows: TeamRow[],
) {
  const inRoster = new Set(roster.map((p) => p.id))
  const broken = teamRows.filter(
    (t) => t.players.length !== 2 || t.players.some((p) => !inRoster.has(p.id)),
  )
  const brokenIds = new Set(broken.map((t) => t.teamId))

  const paired = new Set(
    teamRows.filter((t) => !brokenIds.has(t.teamId)).flatMap((t) => t.players.map((p) => p.id)),
  )
  const byId = new Map(roster.map((p) => [p.id, p]))
  const fresh: BoardPlayer[][] = []
  for (const p of roster) {
    if (paired.has(p.id) || !p.wishPlayerId) continue
    const q = byId.get(p.wishPlayerId)
    if (!q || paired.has(q.id) || q.wishPlayerId !== p.id) continue
    paired.add(p.id)
    paired.add(q.id)
    fresh.push([
      { id: p.id, name: p.name },
      { id: q.id, name: q.name },
    ])
  }

  if (!broken.length && !fresh.length) return false
  await transact(async (tx) => {
    if (broken.length) {
      await tx.delete(teams).where(
        inArray(
          teams.id,
          broken.map((t) => t.teamId),
        ),
      )
    }
    for (const pair of fresh) await insertTeam(tx, categoryId, pair)
    await bumpStreamVersion(tournamentId, tx)
  })
  return true
}

/**
 * Singles has no pairing step, but the schedule is built from teams, so every
 * player gets a team of one named after them. Created on load, removed when
 * the player leaves — so the schedule step always has something to draw from.
 */
async function settleSingles(
  tournamentId: string,
  categoryId: string,
  roster: RosterRow[],
  teamRows: TeamRow[],
) {
  const inRoster = new Set(roster.map((p) => p.id))
  const stale = teamRows.filter(
    (t) => t.players.length !== 1 || !inRoster.has(t.players[0].id),
  )
  const staleIds = new Set(stale.map((t) => t.teamId))
  const have = new Set(
    teamRows.filter((t) => !staleIds.has(t.teamId)).map((t) => t.players[0].id),
  )
  const missing = roster.filter((p) => !have.has(p.id))

  if (!stale.length && !missing.length) return false
  await transact(async (tx) => {
    if (stale.length) {
      await tx.delete(teams).where(
        inArray(
          teams.id,
          stale.map((t) => t.teamId),
        ),
      )
    }
    for (const p of missing) await insertTeam(tx, categoryId, [{ id: p.id, name: p.name }])
    await bumpStreamVersion(tournamentId, tx)
  })
  return true
}

function firstName(name: string) {
  return name.trim().split(/\s+/)[0] || name
}

/**
 * The right-hand phrase for someone still in the pile. It answers the one
 * question the organiser has when reading the row: why isn't this person
 * paired yet? Null means there is nothing to explain — they named nobody, or
 * named someone who never signed up — and the row offers "Pair with…".
 */
function describeWish(
  p: RosterRow,
  byId: Map<string, RosterRow>,
  paired: Set<string>,
): Pick<Unpaired, 'wishPlayerId' | 'wishPlayerName' | 'mutual' | 'note'> {
  const q = p.wishPlayerId ? byId.get(p.wishPlayerId) : undefined
  if (!q) return { wishPlayerId: null, wishPlayerName: null, mutual: false, note: null }

  const base = { wishPlayerId: q.id, wishPlayerName: q.name, mutual: false }
  if (paired.has(q.id)) return { ...base, note: `${firstName(q.name)} is paired already` }
  if (q.wishPlayerId === p.id) return { ...base, mutual: true, note: '✓ mutual' }
  const r = q.wishPlayerId ? byId.get(q.wishPlayerId) : undefined
  if (r) return { ...base, note: `${firstName(q.name)} named ${firstName(r.name)}` }
  if (q.wishText) return { ...base, note: `${firstName(q.name)} named ${q.wishText}` }
  return { ...base, note: 'not mutual' }
}

/**
 * Settle what can be settled without the organiser: mutual pairs, singles'
 * teams of one, pairs broken by someone leaving. Idempotent and a no-op once
 * the schedule exists. The Teams screen runs it on every load; the schedule
 * step runs it too, so a singles tournament whose Players page was never
 * opened still has something to draw from.
 */
export async function settleTeams(tournamentId: string): Promise<boolean> {
  const category = await primaryCategory(tournamentId)
  const [roster, locked, teamRows] = await Promise.all([
    activeRoster(tournamentId),
    isLocked(tournamentId),
    teamsIn(category.id),
  ])
  if (locked) return false
  return category.discipline === 'singles'
    ? settleSingles(tournamentId, category.id, roster, teamRows)
    : settleDoubles(tournamentId, category.id, roster, teamRows)
}

/**
 * The whole screen in one call. Settles what can be settled without the
 * organiser (mutual pairs, singles' teams of one, pairs broken by someone
 * leaving), then reports the two piles.
 */
export async function teamBoard(tournamentId: string): Promise<TeamBoard> {
  const category = await primaryCategory(tournamentId)
  const discipline = category.discipline === 'singles' ? 'singles' : 'doubles'
  const [roster, locked] = await Promise.all([activeRoster(tournamentId), isLocked(tournamentId)])
  let teamRows = await teamsIn(category.id)

  if (!locked) {
    const moved =
      discipline === 'singles'
        ? await settleSingles(tournamentId, category.id, roster, teamRows)
        : await settleDoubles(tournamentId, category.id, roster, teamRows)
    if (moved) teamRows = await teamsIn(category.id)
  }

  const byId = new Map(roster.map((p) => [p.id, p]))
  // Members of any team, withdrawn ones included: a pair that has withdrawn is
  // out of the day, not back in the pile.
  const paired = new Set(teamRows.flatMap((t) => t.players.map((p) => p.id)))

  const pairs: BoardPair[] = teamRows
    .filter((t) => t.status !== 'withdrawn')
    .map((t) => {
      const members = t.players.map((m) => ({ id: m.id, name: byId.get(m.id)?.name ?? '' }))
      const [a, b] = t.players
      const mutual =
        !!a && !!b && byId.get(a.id)?.wishPlayerId === b.id && byId.get(b.id)?.wishPlayerId === a.id
      return { teamId: t.teamId, name: t.name, players: members, how: mutual ? 'mutual' : 'organiser' }
    })

  const unpaired: Unpaired[] = roster
    .filter((p) => !paired.has(p.id))
    .map((p) => ({ id: p.id, name: p.name, wishText: p.wishText, ...describeWish(p, byId, paired) }))

  return {
    discipline,
    pairs,
    unpaired,
    needed: discipline === 'singles' ? roster.length : Math.floor(roster.length / 2),
    locked,
  }
}

type Result<T = object> = ({ ok: true } & T) | { ok: false; error: string }

async function doublesGate(tournamentId: string) {
  const category = await primaryCategory(tournamentId)
  if (category.discipline === 'singles') {
    return { ok: false as const, error: 'Singles has no pairs to make.' }
  }
  if (await isLocked(tournamentId)) return { ok: false as const, error: LOCKED_MESSAGE }
  return { ok: true as const, category }
}

/** Put two people from the pile together. Either already in a pair refuses. */
export async function pairWith(
  tournamentId: string,
  playerA: string,
  playerB: string,
): Promise<Result<{ teamId: string }>> {
  const gate = await doublesGate(tournamentId)
  if (!gate.ok) return gate
  if (!playerA || !playerB || playerA === playerB) {
    return { ok: false, error: 'Pick two different people.' }
  }

  const [roster, teamRows] = await Promise.all([
    activeRoster(tournamentId),
    teamsIn(gate.category.id),
  ])
  const byId = new Map(roster.map((p) => [p.id, p]))
  const a = byId.get(playerA)
  const b = byId.get(playerB)
  if (!a || !b) return { ok: false, error: 'One of them is no longer on the list.' }

  const paired = new Set(teamRows.flatMap((t) => t.players.map((p) => p.id)))
  for (const p of [a, b]) {
    if (paired.has(p.id)) return { ok: false, error: `${p.name} is in a pair already. Split it first.` }
  }

  const teamId = await transact(async (tx) => {
    const id = await insertTeam(tx, gate.category.id, [
      { id: a.id, name: a.name },
      { id: b.id, name: b.name },
    ])
    await bumpStreamVersion(tournamentId, tx)
    return id
  })
  return { ok: true, teamId }
}

/** Undo a pair. Both go back to the pile; a mutual pair re-forms on the next load. */
export async function splitTeam(tournamentId: string, teamId: string): Promise<Result> {
  const gate = await doublesGate(tournamentId)
  if (!gate.ok) return gate
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(and(eq(teams.id, teamId), eq(teams.categoryId, gate.category.id)))
    .limit(1)
  if (!team) return { ok: false, error: 'That pair is already gone.' }

  await transact(async (tx) => {
    await tx.delete(teams).where(eq(teams.id, team.id))
    await bumpStreamVersion(tournamentId, tx)
  })
  return { ok: true }
}

/**
 * Pair whoever is left, at random — with the category's own seed, so the same
 * pile always comes out the same way and "why am I with him" has one answer.
 * An odd pile leaves one person out, and says who.
 */
export async function pairRestRandomly(
  tournamentId: string,
): Promise<Result<{ made: number; oddOut: BoardPlayer | null }>> {
  const gate = await doublesGate(tournamentId)
  if (!gate.ok) return gate

  const roster = await activeRoster(tournamentId)
  let teamRows = await teamsIn(gate.category.id)
  // Mutual pairs first: they are not the organiser's to gamble with.
  if (await settleDoubles(tournamentId, gate.category.id, roster, teamRows)) {
    teamRows = await teamsIn(gate.category.id)
  }
  const paired = new Set(teamRows.flatMap((t) => t.players.map((p) => p.id)))
  const pile = roster.filter((p) => !paired.has(p.id))
  if (pile.length === 0) return { ok: false, error: 'Everyone is paired.' }
  if (pile.length === 1) {
    return { ok: false, error: `Only ${pile[0].name} is left — there is nobody to pair them with.` }
  }

  const byId = new Map(pile.map((p) => [p.id, p]))
  const seed = await pairingSeedFor(gate.category.id)
  const groups = pairRandomly(
    pile.map((p) => p.id),
    seed,
    2,
  )
  const used = new Set(groups.flat())
  const left = pile.find((p) => !used.has(p.id)) ?? null

  await transact(async (tx) => {
    for (const g of groups) {
      await insertTeam(
        tx,
        gate.category.id,
        g.map((id) => ({ id, name: byId.get(id)!.name })),
      )
    }
    await bumpStreamVersion(tournamentId, tx)
  })
  return { ok: true, made: groups.length, oddOut: left ? { id: left.id, name: left.name } : null }
}
