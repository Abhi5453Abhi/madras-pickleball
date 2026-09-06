import { createRequire } from 'node:module'
import { sql, type Column, type SQL } from 'drizzle-orm'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import * as schema from './schema'

/**
 * Two ways to run.
 *
 * MPB_DB=embedded forces the embedded database even when DATABASE_URL is set,
 * which matters because DATABASE_URL is often exported globally in a shell for
 * some other project and would otherwise silently hijack this app.
 *
 * With DATABASE_URL set — a real Postgres (Neon in production). One connection
 * per serverless instance: on Neon this must be the POOLED host with a
 * connection limit of 1, or connections exhaust under exactly the load that
 * matters (SPEC A9).
 *
 * With no DATABASE_URL — an embedded Postgres (PGlite) stored in .pglite/, so
 * `npm install && npm run dev` works on a laptop with nothing else installed.
 * It is real Postgres, so the partial unique indexes and CHECK constraints the
 * schema depends on behave identically.
 */
const globalForDb = globalThis as unknown as { conn?: unknown; db?: DbHandle }

// Load whichever driver is actually needed at runtime, so the production bundle
// never pulls in PGlite's WASM and a laptop never needs a Postgres server.
const req = createRequire(import.meta.url)

type DbHandle = ReturnType<typeof drizzlePg<typeof schema>> | ReturnType<typeof drizzlePglite<typeof schema>>

/** Which database this process is talking to, and why. */
export function dbTarget(): { kind: 'postgres'; url: string } | { kind: 'embedded' } {
  if (process.env.MPB_DB === 'embedded') return { kind: 'embedded' }
  const url = process.env.DATABASE_URL
  return url ? { kind: 'postgres', url } : { kind: 'embedded' }
}

/** Host and database name only — never the password. */
export function describeTarget(): string {
  const t = dbTarget()
  if (t.kind === 'embedded') return 'embedded database (app/.pglite)'
  try {
    const u = new URL(t.url)
    return `postgres at ${u.host}${u.pathname}`
  } catch {
    return 'postgres (DATABASE_URL)'
  }
}

/**
 * Deployed with no DATABASE_URL: the embedded database in /tmp, per instance,
 * wiped whenever the host recycles it. Good enough to look at the app on a
 * phone; wrong for a real Sunday, which is why the sign-in page says so.
 */
export const isDemoDeployment =
  dbTarget().kind === 'embedded' && process.env.NODE_ENV === 'production'

function build(): DbHandle {
  const target = dbTarget()
  const url = target.kind === 'postgres' ? target.url : undefined

  if (url) {
    const postgres = req('postgres') as typeof import('postgres')
    const conn =
      (globalForDb.conn as ReturnType<typeof postgres> | undefined) ??
      postgres(url, { max: process.env.NODE_ENV === 'production' ? 1 : 5, prepare: false })
    if (process.env.NODE_ENV !== 'production') globalForDb.conn = conn
    return drizzlePg(conn, { schema, casing: 'snake_case' })
  }

  const { PGlite } = req('@electric-sql/pglite') as typeof import('@electric-sql/pglite')
  // On a serverless host the working directory is read-only and instances are
  // discarded, so the embedded database lives in /tmp and is per-instance. That
  // is fine for a demo deployment and wrong for a real one, which is why
  // MPB_DEMO has to be set explicitly for it to be allowed in production.
  const path = process.env.VERCEL ? '/tmp/mpb-pglite' : '.pglite'
  const client = (globalForDb.conn as InstanceType<typeof PGlite> | undefined) ?? new PGlite(path)
  globalForDb.conn = client
  return drizzlePglite(client, { schema, casing: 'snake_case' })
}

/**
 * Built on first use, not on import. `next build` imports every server module
 * while collecting page data, and with no DATABASE_URL that used to start the
 * embedded database inside the build worker — where its WASM aborts, and
 * where no database should be opened at all.
 */
function handle(): DbHandle {
  if (!globalForDb.db) globalForDb.db = build()
  return globalForDb.db
}

export const db: DbHandle = new Proxy({} as DbHandle, {
  get(_target, prop) {
    const real = handle() as unknown as Record<string | symbol, unknown>
    const value = real[prop]
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(real) : value
  },
})

export const isEmbeddedDb = dbTarget().kind === 'embedded'
export { schema }
export type Db = typeof db

/**
 * A database transaction.
 *
 * Recording a result is a delete, N inserts and two updates. Without this, two
 * phones submitting at once could interleave into a state neither of them
 * asked for, and a mid-sequence failure left a match with a winner and no
 * games. Both drivers implement the same query surface, so the cast is only
 * there to reconcile the two driver types.
 */
type PgHandle = ReturnType<typeof drizzlePg<typeof schema>>
export type Tx = Parameters<Parameters<PgHandle['transaction']>[0]>[0]

export function transact<T>(fn: (t: Tx) => Promise<T>): Promise<T> {
  return (db as PgHandle).transaction(fn)
}

/**
 * `case <key> when 'a' then 'x' when 'b' then 'y' end` — a many-row UPDATE
 * written as one statement.
 *
 * Updating rows one at a time is a network round trip each. That is invisible
 * on a laptop and it is the entire cost on a serverless host holding a single
 * connection to a database in another region: resolving four bracket slots was
 * eight hops before it was any work at all. Every value is cast, because a
 * CASE whose branches are all untyped parameters has no type Postgres can
 * infer.
 */
export function mapCase(key: Column, pairs: Array<readonly [string, string]>): SQL {
  const branches = sql.join(
    pairs.map(([k, v]) => sql`when ${k} then ${v}::text`),
    sql` `,
  )
  return sql`case ${key} ${branches} end`
}
