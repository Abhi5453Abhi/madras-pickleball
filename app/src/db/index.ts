import { createRequire } from 'node:module'
import { drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import * as schema from './schema'

/**
 * Two ways to run.
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

function build(): DbHandle {
  const url = process.env.DATABASE_URL

  if (url) {
    const postgres = req('postgres') as typeof import('postgres')
    const conn =
      (globalForDb.conn as ReturnType<typeof postgres> | undefined) ??
      postgres(url, { max: process.env.NODE_ENV === 'production' ? 1 : 5, prepare: false })
    if (process.env.NODE_ENV !== 'production') globalForDb.conn = conn
    return drizzlePg(conn, { schema, casing: 'snake_case' })
  }

  const { PGlite } = req('@electric-sql/pglite') as typeof import('@electric-sql/pglite')
  const client = (globalForDb.conn as InstanceType<typeof PGlite> | undefined) ?? new PGlite('.pglite')
  globalForDb.conn = client
  return drizzlePglite(client, { schema, casing: 'snake_case' })
}

export const db: DbHandle = globalForDb.db ?? build()
if (process.env.NODE_ENV !== 'production') globalForDb.db = db

export const isEmbeddedDb = !process.env.DATABASE_URL
export { schema }
export type Db = typeof db
