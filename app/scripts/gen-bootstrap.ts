/** Regenerates src/db/bootstrap-sql.ts from drizzle/*.sql. Run after db:generate. */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

const files = readdirSync('drizzle')
  .filter((f) => f.endsWith('.sql'))
  .sort()
// Joined with a breakpoint: the app runs this one statement at a time, and
// the last statement of one migration glued to the first of the next is a
// multi-statement query the embedded database refuses.
const sql = files.map((f) => readFileSync(`drizzle/${f}`, 'utf8')).join('\n--> statement-breakpoint\n')

const packed = gzipSync(Buffer.from(sql, 'utf8'), { level: 9 }).toString('base64')

writeFileSync(
  'src/db/bootstrap-sql.ts',
  `/**
 * The schema as one string, generated from drizzle/*.sql by scripts/gen-bootstrap.ts.
 *
 * A serverless bundle does not carry the migrations folder, so the embedded
 * demo database applies this on first use. A real deployment sets DATABASE_URL
 * and uses drizzle-kit migrations instead.
 */
import { gunzipSync } from 'node:zlib'

const PACKED = '${packed}'

export function bootstrapSql(): string {
  return gunzipSync(Buffer.from(PACKED, 'base64')).toString('utf8')
}
`,
)
console.log(`bootstrap-sql.ts written from ${files.length} migration(s)`)
