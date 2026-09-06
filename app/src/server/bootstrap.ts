import 'server-only'
import { sql } from 'drizzle-orm'
import { db, isDemoDeployment, isEmbeddedDb } from '@/db'
import { bootstrapSql } from '@/db/bootstrap-sql'
import { courts, players, users, venues } from '@/db/schema'
import { newId } from '@/lib/ids'
import { hashPin } from '@/lib/password'
import { ensureOrganiserPins, TEMP_PINS } from './organisers'
import { createEvent, startEvent, syncCategoryPlayers } from './events'
import { parsePlayerList } from '@/lib/parse-players'
import {
  createTeams,
  generateDrawForCategory,
  importPlayers,
  listMatches,
  listTournamentPlayers,
  pairRandomly,
} from './tournaments'
import { submitResult } from './scoring'
import { flowTournament } from './board'
import { tournaments } from '@/db/schema'

/**
 * Brings an empty embedded database up on first use.
 *
 * A serverless bundle does not carry the migrations folder, and a demo instance
 * is discarded whenever the host recycles it, so this has to be idempotent and
 * cheap. A real deployment sets DATABASE_URL and never comes through here.
 */
const globalForBoot = globalThis as unknown as { mpbBooted?: Promise<void> }

const COURT_COLOURS = ['blue', 'orange', 'teal', 'violet']

async function tablesExist() {
  try {
    const res = await db.execute(
      sql`select to_regclass('public.tournaments') is not null as ok`,
    )
    const rows = (res as unknown as { rows?: Array<{ ok: boolean }> }).rows ?? (res as unknown as Array<{ ok: boolean }>)
    return !!rows?.[0]?.ok
  } catch {
    return false
  }
}

async function applySchema() {
  for (const statement of bootstrapSql().split('--> statement-breakpoint')) {
    const trimmed = statement.trim()
    if (!trimmed) continue
    try {
      await db.execute(sql.raw(trimmed))
    } catch (err) {
      // "already exists" is expected when two instances race each other.
      const message = err instanceof Error ? err.message : String(err)
      if (!/already exists/i.test(message)) throw err
    }
  }
}

async function seedCore() {
  const [venue] = await db.select().from(venues).limit(1)
  let venueId = venue?.id
  if (!venueId) {
    venueId = newId('ven')
    await db
      .insert(venues)
      .values({ id: venueId, name: 'Madras Pickleball', slug: 'madras-pickleball' })
  }

  const existingCourts = await db.select().from(courts).limit(1)
  if (existingCourts.length === 0) {
    await db.insert(courts).values(
      COURT_COLOURS.map((colorKey, i) => ({
        id: newId('crt'),
        venueId: venueId!,
        name: `Court ${i + 1}`,
        sortOrder: i,
        colorKey,
      })),
    )
  }

  const existingUsers = await db.select().from(users).limit(1)
  if (existingUsers.length === 0) {
    // One organiser. The PIN is the whole credential (SPEC v4): a fixed
    // temporary one that must be replaced on first sign-in, or the one the
    // deployment sets.
    const pin = process.env.MPB_SEED_PIN ?? TEMP_PINS[0]
    const digest = await hashPin(pin)
    await db.insert(users).values({
      id: newId('usr'),
      name: 'Organiser',
      username: 'organiser',
      role: 'super_admin' as const,
      passwordHash: digest,
      pinHash: digest,
      mustChangePassword: !process.env.MPB_SEED_PIN,
    })
  }
  // Accounts from before PIN sign-in get a temporary PIN; umpire accounts
  // are switched off.
  await ensureOrganiserPins()
}

const DEMO_PLAYERS = `1. Ravi Kumar
2. Priya Sundaram
3. Karthik Raman
4. Meera Nair
5. Arun Prakash
6. Deepa Krishnan
7. Suresh Iyer
8. Kiran Balaji`

/**
 * A demo deployment should look like a real Saturday on arrival: a Men's
 * Doubles on Courts 1 and 2, two results in, two matches on court.
 */
async function seedDemo() {
  const existing = await db.select().from(tournaments).limit(1)
  if (existing.length > 0) return

  const courtRows = await db.select({ id: courts.id }).from(courts).orderBy(courts.sortOrder).limit(2)
  const { tournament, categoryId } = await createEvent({
    name: "Men's Doubles — demo",
    date: new Date(),
    gender: 'mens',
    discipline: 'doubles',
    finalsStage: 'final_only',
    courtIds: courtRows.map((c) => c.id),
  })

  const parsed = parsePlayerList(DEMO_PLAYERS).filter((r) => r.name)
  await importPlayers(tournament.id, parsed.map((r) => ({ name: r.name, phone: r.phone })))
  await syncCategoryPlayers(tournament.id)

  const roster = await listTournamentPlayers(tournament.id)
  const pairs = pairRandomly(roster.map((p) => p.id), 'demo-seed', 2)
  await createTeams(categoryId, pairs, new Map(roster.map((p) => [p.id, p.name])))
  await generateDrawForCategory(categoryId)

  // Start: the first matches flow onto the two courts by themselves. Then
  // score them, and the next two flow on.
  const started = await startEvent(tournament.id)
  if (!started.ok) return

  const scripted: Array<[number, number][]> = [
    [
      [11, 7],
      [11, 9],
    ],
    [
      [9, 11],
      [11, 8],
      [11, 6],
    ],
  ]
  const live = (await listMatches(tournament.id)).filter((m) => m.status === 'live')
  for (const [i, m] of live.slice(0, 2).entries()) {
    if (!m.teamAId || !m.teamBId) continue
    const gs = scripted[i].map(([scoreA, scoreB], idx) => ({ gameNo: idx + 1, scoreA, scoreB }))
    let a = 0
    for (const g of gs) if (g.scoreA > g.scoreB) a++
    await submitResult({
      matchId: m.id,
      games: gs,
      resultType: 'normal',
      winnerTeamId: a >= 2 ? m.teamAId : m.teamBId,
      submittingTeamId: null,
      attributorKey: 'user:demo',
      actorType: 'user',
      clientEventId: newId('ce'),
      authoritative: true,
    })
    await flowTournament(tournament.id)
  }
}

async function run() {
  if (!isEmbeddedDb) return
  if (!(await tablesExist())) await applySchema()
  await seedCore()
  // A deployment with no database of its own arrives looking like a real
  // Saturday, so there is something to look at; a laptop asks for it.
  if (process.env.MPB_DEMO === '1' || isDemoDeployment) {
    const anyPlayer = await db.select().from(players).limit(1)
    if (anyPlayer.length === 0) await seedDemo()
  }
}

export function ensureReady(): Promise<void> {
  globalForBoot.mpbBooted ??= run().catch((err) => {
    globalForBoot.mpbBooted = undefined
    throw err
  })
  return globalForBoot.mpbBooted
}
