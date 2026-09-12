import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { eq, sql } from 'drizzle-orm'
import { bootstrapMigrations } from '@/db/bootstrap-migrations'
import * as schema from '@/db/schema'
import { newId } from '@/lib/ids'

/**
 * A real database for the tests that need one.
 *
 * PGlite is Postgres compiled to WASM, in memory, one instance per test file —
 * so the partial unique indexes and CHECK constraints this feature leans on
 * behave exactly as they will in Neon. That matters more here than anywhere
 * else in the app: capacity is enforced by an index, not by application code,
 * and a fake would test the code rather than the rule.
 *
 * The connection is installed on `globalThis` before anything imports `@/db`,
 * which is the seam `src/db/index.ts` already has — it builds its handle on
 * first property access and caches it there.
 */

type GlobalDb = { conn?: unknown; db?: unknown }

export type TestDb = Awaited<ReturnType<typeof startTestDb>>

export async function startTestDb() {
  const client = new PGlite()
  const handle = drizzle(client, { schema, casing: 'snake_case' })

  // The same migrations the app ships with, applied the same way the runtime
  // applies them — one statement per breakpoint.
  for (const migration of bootstrapMigrations()) {
    for (const statement of migration.sql.split('--> statement-breakpoint')) {
      const trimmed = statement.trim()
      if (trimmed) await client.exec(trimmed)
    }
  }

  const g = globalThis as unknown as GlobalDb
  g.conn = client
  g.db = handle

  // If that seam ever breaks, `src/db/index.ts` would quietly open the dev
  // database in `.pglite` instead of throwing, and the suite would pass while
  // testing the wrong thing. Fail here instead.
  const { db: appDb } = await import('@/db')
  const probe = await appDb.execute(sql`select 1 as ok`)
  if (!probe) throw new Error('the app handle is not the test handle')

  return { client, handle }
}

/** The venue and the organiser every domain call expects to exist. */
export async function seedVenue(db: TestDb['handle']) {
  await db
    .insert(schema.venues)
    .values({ id: 'venue-test', name: 'Madras Pickleball', slug: 'madras-pickleball' })
    .onConflictDoNothing()
  const id = newId('usr')
  await db
    .insert(schema.users)
    .values({ id, name: 'Organiser', username: 'organiser', passwordHash: 'x', role: 'super_admin' })
    .onConflictDoNothing()
  const [row] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.username, 'organiser'))
    .limit(1)
  return { id: row?.id ?? id, username: 'organiser' }
}

/**
 * Between tests: everything this feature touches, nothing it does not.
 *
 * The money tables are named rather than left to `cascade` from `players`: it
 * would reach them, but a list that says what it clears is the one somebody
 * can check. TRUNCATE does not fire the no-delete trigger on those tables,
 * which is why a test can still start from nothing.
 *
 * `venues` and `users` are deliberately NOT in the list — nothing references
 * them in a way `cascade` would reach, so they survive, and the venue and the
 * organiser are seeded once in `beforeAll` rather than re-inserted into a table
 * that still holds them.
 */
export async function truncate(db: TestDb['handle']) {
  await db.execute(
    sql`truncate table session_scheduled_actions, session_participants, game_sessions, scheduler_runs, audit_log, token_attempts, players,
        charges, charge_adjustments, charge_applications, payments, credits, refunds,
        collection_attempts, collection_attempt_charges, webhook_events cascade`,
  )
}
