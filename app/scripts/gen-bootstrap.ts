/** Regenerates src/db/bootstrap-migrations.ts from drizzle/. Run after db:generate. */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
  entries: Array<{ tag: string; when: number }>
}

// The same record drizzle's own migrator keeps — tag, timestamp and hash —
// so a database the app set itself up on and one migrated from a laptop are
// indistinguishable, and either tool can take over from the other.
const migrations = journal.entries.map((e) => {
  const sql = readFileSync(`drizzle/${e.tag}.sql`, 'utf8')
  return { tag: e.tag, when: e.when, hash: createHash('sha256').update(sql).digest('hex'), sql }
})

const packed = gzipSync(Buffer.from(JSON.stringify(migrations), 'utf8'), { level: 9 }).toString('base64')

writeFileSync(
  'src/db/bootstrap-migrations.ts',
  `/**
 * The migrations, packed, generated from drizzle/ by scripts/gen-bootstrap.ts.
 *
 * A serverless bundle does not carry the migrations folder, so the app brings
 * them along and applies whatever a database is missing on first use — the
 * embedded demo database and a freshly connected Postgres alike.
 */
import { gunzipSync } from 'node:zlib'

export type BootstrapMigration = { tag: string; when: number; hash: string; sql: string }

const PACKED = '${packed}'

export function bootstrapMigrations(): BootstrapMigration[] {
  return JSON.parse(gunzipSync(Buffer.from(PACKED, 'base64')).toString('utf8'))
}
`,
)
console.log(`bootstrap-migrations.ts written from ${migrations.length} migration(s)`)
