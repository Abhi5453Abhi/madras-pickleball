import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'

/**
 * One connection per serverless instance. On Neon this must be the POOLED host
 * with a connection limit of 1, or connections exhaust under exactly the load
 * that matters (SPEC A9).
 */
const globalForDb = globalThis as unknown as { conn?: postgres.Sql }

const conn =
  globalForDb.conn ??
  postgres(process.env.DATABASE_URL!, {
    max: process.env.NODE_ENV === 'production' ? 1 : 5,
    prepare: false,
  })

if (process.env.NODE_ENV !== 'production') globalForDb.conn = conn

export const db = drizzle(conn, { schema, casing: 'snake_case' })
export { schema }
export type Db = typeof db
