import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { bootstrapSql } from '../bootstrap-sql'

/**
 * The embedded database applies `bootstrapSql()` because a serverless bundle
 * does not carry the migrations folder. A schema change that reaches
 * `drizzle/` but not this string is invisible: `npm run dev` on a clean laptop
 * comes up, looks fine, and then fails on the first score of the day with a
 * missing column. It happened. This is why it cannot happen twice.
 */
describe('the packed schema', () => {
  it('is in step with the migrations', () => {
    const files = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .sort()
    const fromDisk = files.map((f) => readFileSync(`drizzle/${f}`, 'utf8')).join('\n')

    expect(files.length).toBeGreaterThan(0)
    expect(bootstrapSql()).toBe(fromDisk)
  })

  it('covers every migration in the journal, in order', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
      entries: Array<{ tag: string }>
    }
    const onDisk = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort()

    // A hand-written .sql that never reached the journal is skipped by the
    // migrator on a real Postgres while still applying to the embedded one —
    // so the two databases quietly diverge.
    expect(journal.entries.map((e) => e.tag).sort()).toEqual(onDisk)
  })
})
