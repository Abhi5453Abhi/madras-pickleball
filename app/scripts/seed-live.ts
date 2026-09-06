/**
 * Two doubles tournaments on today's date, ready to start: Men's Doubles on
 * Courts 1–2 (six pairs, league then a final — 16 matches), Mixed Doubles on
 * Court 3 (four pairs, league then a final — 7 matches). Court 4 is nobody's.
 * Neither is started; the live-board walk starts them.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/seed-live.ts
 *
 * Prints the two slugs, one per line, for the walk to pick up.
 */
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from '../src/db'
import { courts, tournaments } from '../src/db/schema'
import { createEvent, syncCategoryPlayers, type Gender } from '../src/server/events'
import {
  createTeams,
  generateDrawForCategory,
  importPlayers,
  listTournamentPlayers,
} from '../src/server/tournaments'

const MENS: string[][] = [
  ['Karthik Subramanian', 'Sathish Kumar'],
  ['Hari Venkatesh', 'Naveen Krishnan'],
  ['Ravi Shankar', 'Vijay Anand'],
  ['Suresh Babu', 'Ganesh Iyer'],
  ['Arun Prakash', 'Manoj Pillai'],
  ['Deepak Raj', 'Bala Murugan'],
]

const MIXED: string[][] = [
  ['Priya Ramesh', 'Rahul Menon'],
  ['Divya Natarajan', 'Vikram Chandran'],
  ['Meera Krishnamurthy', 'Arun Kumar'],
  ['Anjali Nair', 'Ravi Varma'],
]

async function make(name: string, gender: Gender, pairs: string[][], courtNames: string[]) {
  const all = await db.select().from(courts).orderBy(courts.sortOrder)
  const courtIds = courtNames.map((n) => {
    const c = all.find((x) => x.name === n)
    if (!c) throw new Error(`No court called ${n}`)
    return c.id
  })

  const { tournament, categoryId, courts: assigned } = await createEvent({
    name,
    date: new Date(),
    gender,
    discipline: 'doubles',
    finalsStage: 'final_only',
    courtIds,
  })
  if (!assigned.ok) throw new Error(assigned.error)

  await importPlayers(
    tournament.id,
    pairs.flat().map((n) => ({ name: n })),
  )
  await syncCategoryPlayers(tournament.id)

  const roster = await listTournamentPlayers(tournament.id)
  const idByName = new Map(roster.map((p) => [p.name, p.id]))
  const pairIds = pairs.map((pair) => pair.map((n) => idByName.get(n)!))
  await createTeams(categoryId, pairIds, new Map(roster.map((p) => [p.id, p.name])))
  await generateDrawForCategory(categoryId)

  const [t] = await db.select().from(tournaments).where(eq(tournaments.id, tournament.id)).limit(1)
  return t
}

async function main() {
  const mens = await make("Men's Doubles — Sunday", 'mens', MENS, ['Court 1', 'Court 2'])
  const mixed = await make('Mixed Doubles — Sunday', 'mixed', MIXED, ['Court 3'])
  console.log(mens.slug)
  console.log(mixed.slug)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
