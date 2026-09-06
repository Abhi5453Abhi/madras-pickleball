import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A `'use server'` module may export nothing but async functions.
 *
 * TypeScript cannot see this — it is a framework rule enforced when the module
 * is evaluated — and a single exported constant takes the WHOLE module down,
 * every action in it, at runtime only. It happened to `src/app/court/actions.ts`
 * and the consequence was that no score could be entered from the QR on the net
 * post at all: every submit a 500, on the one screen the product exists for.
 *
 * This reads the source rather than importing it, because importing a server
 * module outside Next is its own kind of unreliable.
 */
function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...walk(path))
    else if (/\.tsx?$/.test(entry)) out.push(path)
  }
  return out
}

const files = walk('src/app').filter((f) =>
  /^\s*['"]use server['"]/.test(readFileSync(f, 'utf8').slice(0, 200)),
)

describe("every 'use server' module", () => {
  it('exists to be checked', () => {
    expect(files.length).toBeGreaterThan(3)
  })

  it.each(files)('%s exports only async functions', (file) => {
    const offenders: string[] = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^export\s+(const|let|var|class)\s+([A-Za-z0-9_$]+)/.exec(line)
      if (!m) continue
      // `export const x = async (…) =>` is a function, and is allowed.
      if (m[1] === 'const' && /=\s*async\s*(\(|function)/.test(line)) continue
      offenders.push(`${m[1]} ${m[2]}`)
    }
    expect(offenders, `${file} exports ${offenders.join(', ')}`).toEqual([])
  })
})
