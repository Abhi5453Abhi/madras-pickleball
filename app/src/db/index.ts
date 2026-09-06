import { createRequire } from 'node:module'
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

function build(): DbHandle {
  const target = dbTarget()
  if (
    target.kind === 'embedded' &&
    process.env.NODE_ENV === 'production' &&
    process.env.MPB_DEMO !== '1'
  ) {
    throw new Error(
      'No DATABASE_URL is set. A production deployment needs a real Postgres — ' +
        'the embedded database is per-instance and resets. Set DATABASE_URL, or ' +
        'set MPB_DEMO=1 to run a throwaway demo.',
    )
  }
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

export const db: DbHandle = globalForDb.db ?? build()
if (process.env.NODE_ENV !== 'production') globalForDb.db = db

export const isEmbeddedDb = dbTarget().kind === 'embedded'
export { schema }
export type Db = typeof db
