/**
 * Gets a fresh checkout runnable: applies migrations, then seeds.
 * Safe to run repeatedly — this is what `npm run dev` calls first.
 */
import 'dotenv/config'
import { db, isEmbeddedDb } from '../src/db'
import { seed } from './seed-core'

async function main() {
  if (isEmbeddedDb) {
    const { migrate } = await import('drizzle-orm/pglite/migrator')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder: './drizzle' })
  } else {
    const { migrate } = await import('drizzle-orm/postgres-js/migrator')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder: './drizzle' })
  }
  console.log(`database  ready    ${isEmbeddedDb ? 'embedded (.pglite)' : 'postgres (DATABASE_URL)'}`)
  await seed()
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
