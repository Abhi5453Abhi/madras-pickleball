import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { bootstrapMigrations } from '../bootstrap-migrations'

/**
 * The app applies `bootstrapMigrations()` because a serverless bundle does not
 * carry the migrations folder. A schema change that reaches `drizzle/` but not
 * this list is invisible: the site comes up, looks fine, and then fails on the
 * first score of the day with a missing column. It happened. This is why it
 * cannot happen twice.
 */
describe('the packed migrations', () => {
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as {
    entries: Array<{ tag: string; when: number }>
  }

  it('are the journal, in order, with drizzle’s own hashes', () => {
    const fromDisk = journal.entries.map((e) => {
      const sql = readFileSync(`drizzle/${e.tag}.sql`, 'utf8')
      return { tag: e.tag, when: e.when, hash: createHash('sha256').update(sql).digest('hex'), sql }
    })
    expect(fromDisk.length).toBeGreaterThan(0)
    expect(bootstrapMigrations()).toEqual(fromDisk)
  })

  it('cover every .sql file in the folder', () => {
    const onDisk = readdirSync('drizzle')
      .filter((f) => f.endsWith('.sql'))
      .map((f) => f.replace(/\.sql$/, ''))
      .sort()
    // A hand-written .sql that never reached the journal is skipped by every
    // migrator — the two ways of setting a database up would quietly diverge.
    expect(journal.entries.map((e) => e.tag).sort()).toEqual(onDisk)
  })

  it('are strictly ordered in time, as the migrator requires', () => {
    const whens = bootstrapMigrations().map((m) => m.when)
    expect([...whens].sort((a, b) => a - b)).toEqual(whens)
    expect(new Set(whens).size).toBe(whens.length)
  })
})
