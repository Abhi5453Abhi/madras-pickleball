/**
 * Gets a fresh checkout runnable: applies migrations, then seeds.
 * Safe to run repeatedly — this is what `npm run dev` calls first.
 */
import 'dotenv/config'
import { db, isEmbeddedDb, describeTarget } from '../src/db'
import { seed } from './seed-core'

async function main() {
  console.log(`database  using    ${describeTarget()}`)

  try {
    if (isEmbeddedDb) {
      const { migrate } = await import('drizzle-orm/pglite/migrator')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await migrate(db as any, { migrationsFolder: './drizzle' })
    } else {
      const { migrate } = await import('drizzle-orm/postgres-js/migrator')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await migrate(db as any, { migrationsFolder: './drizzle' })
    }
  } catch (err) {
    if (!isEmbeddedDb) {
      console.error(`\nCouldn't reach ${describeTarget()}.`)
      console.error(
        'DATABASE_URL is set, so the app tried to use that server instead of its own.',
      )
      // Naming the two places it comes from, because "DATABASE_URL is set"
      // sends people hunting through .zshrc when the answer is a file sitting
      // in this folder.
      console.error('It comes from app/.env, or from your shell. Check app/.env first.\n')
      console.error('To ignore it and use the database the app brings with it:\n')
      console.error('    MPB_DB=embedded npm run dev\n')
      console.error('Underlying error:')
    }
    throw err
  }

  console.log(`database  ready    ${describeTarget()}`)
  await seed()
  process.exit(0)
}

main().catch((e) => {
  console.error(e instanceof Error ? `${e.name}: ${e.message}` : e)
  process.exit(1)
})
