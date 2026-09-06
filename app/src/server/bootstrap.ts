import 'server-only'
import { sql } from 'drizzle-orm'
import { db, isDemoDeployment, transact, type Tx } from '@/db'
import { bootstrapMigrations } from '@/db/bootstrap-migrations'
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
 * Brings a database up on first use — the embedded one, or a Postgres that
 * was connected a minute ago and has nothing in it yet.
 *
 * A serverless bundle does not carry the migrations folder and there is
 * nobody to run a setup command, so this has to be idempotent, cheap, and
 * safe when two instances wake up at the same moment.
 */
const globalForBoot = globalThis as unknown as { mpbBooted?: Promise<void> }

const COURT_COLOURS = ['blue', 'orange', 'teal', 'violet']

/** One key for the whole venue; two instances take turns rather than race. */
const LOCK = 'select pg_advisory_xact_lock(7231001)'

type Handle = Pick<Tx, 'select' | 'insert' | 'execute'>

function rows<T>(res: unknown): T[] {
  const r = res as { rows?: T[] } | T[]
  return Array.isArray(r) ? r : (r.rows ?? [])
}

/**
 * The timestamp of the newest migration a database has — drizzle's own
 * bookkeeping, so `npm run db:migrate` from a laptop and this agree on what
 * has been done. Null when the table is not there yet.
 */
async function newestApplied(h: Handle): Promise<number | null> {
  const res = await h.execute(
    sql`select created_at from "drizzle"."__drizzle_migrations" order by created_at desc limit 1`,
  )
  const [row] = rows<{ created_at: number | string | null }>(res)
  return row?.created_at == null ? null : Number(row.created_at)
}

async function applyMissing(tx: Handle) {
  await tx.execute(sql`create schema if not exists "drizzle"`)
  await tx.execute(
    sql`create table if not exists "drizzle"."__drizzle_migrations" (id serial primary key, hash text not null, created_at bigint)`,
  )
  const applied = await newestApplied(tx)
  for (const m of bootstrapMigrations()) {
    if (applied !== null && applied >= m.when) continue
    for (const statement of m.sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await tx.execute(sql.raw(trimmed))
    }
    await tx.execute(
      sql`insert into "drizzle"."__drizzle_migrations" ("hash", "created_at") values (${m.hash}, ${m.when})`,
    )
  }
}

async function seedCore(h: Handle) {
  const [venue] = await h.select().from(venues).limit(1)
  let venueId = venue?.id
  if (!venueId) {
    venueId = newId('ven')
    await h.insert(venues).values({ id: venueId, name: 'Madras Pickleball', slug: 'madras-pickleball' })
  }

  const existingCourts = await h.select().from(courts).limit(1)
  if (existingCourts.length === 0) {
    await h.insert(courts).values(
      COURT_COLOURS.map((colorKey, i) => ({
        id: newId('crt'),
        venueId: venueId!,
        name: `Court ${i + 1}`,
        sortOrder: i,
        colorKey,
      })),
    )
  }

  const existingUsers = await h.select().from(users).limit(1)
  if (existingUsers.length === 0) {
    // One organiser. The PIN is the whole credential (SPEC v4): a fixed
    // temporary one that must be replaced on first sign-in, or the one the
    // deployment sets.
    const pin = process.env.MPB_SEED_PIN ?? TEMP_PINS[0]
    const digest = await hashPin(pin)
    await h.insert(users).values({
      id: newId('usr'),
      name: 'Organiser',
      username: 'organiser',
      role: 'super_admin' as const,
      passwordHash: digest,
      pinHash: digest,
      // A demo copy resets itself, so a forced change would be asked for
      // every time; its PIN is on the sign-in page instead.
      mustChangePassword: !process.env.MPB_SEED_PIN && !isDemoDeployment,
    })
  }
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

/** True when nothing needs doing — the usual case, one cheap read. */
async function upToDate() {
  try {
    const applied = await newestApplied(db as unknown as Handle)
    const newest = bootstrapMigrations().at(-1)?.when ?? 0
    if (applied === null || applied < newest) return false
    const [anyone] = await db.select({ id: users.id }).from(users).limit(1)
    return !!anyone
  } catch {
    // No migrations table: an empty database.
    return false
  }
}

async function run() {
  // `next build` renders pages to collect their shells; a database opened
  // in the build worker would be thrown away — and the embedded one aborts.
  if (process.env.NEXT_PHASE === 'phase-production-build') return

  if (!(await upToDate())) {
    // One transaction under one lock: whichever instance gets there first
    // does the work, the other waits and then finds nothing left to do.
    // Postgres rolls schema changes back with everything else, so a crash
    // halfway leaves nothing half-made.
    await transact(async (tx) => {
      await tx.execute(sql.raw(LOCK))
      await applyMissing(tx)
      await seedCore(tx)
    })
  }
  // Accounts from before PIN sign-in get a temporary PIN; umpire accounts
  // are switched off.
  await ensureOrganiserPins()

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
