/**
 * Test data for the Teams screen: a doubles tournament with twelve players and
 * every kind of partner wish, and a singles tournament with six.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/seed-teams.ts
 *
 * Prints one line per tournament — `doubles <slug>` / `singles <slug>` — for
 * the Playwright walk to pick up. Re-running makes a fresh pair each time.
 */
import 'dotenv/config'
import { and, eq } from 'drizzle-orm'
import { db } from '../src/db'
import { courts, players, tournamentPlayers } from '../src/db/schema'
import { createEvent, syncCategoryPlayers } from '../src/server/events'
import { importPlayers } from '../src/server/tournaments'

// name → who they asked for (as typed). Karthik/Sathish and Hari/Naveen name
// each other; Manoj → Suresh → Ganesh → Manoj is a chain nobody can satisfy;
// Ravi names someone who never signed up; the rest name nobody.
const DOUBLES: Array<[string, string | null]> = [
  ['Karthik Subramanian', 'Sathish Kumar'],
  ['Sathish Kumar', 'Karthik Subramanian'],
  ['Hari Venkatesh', 'Naveen Krishnan'],
  ['Naveen Krishnan', 'Hari Venkatesh'],
  ['Manoj Pillai', 'Suresh Babu'],
  ['Suresh Babu', 'Ganesh Iyer'],
  ['Ganesh Iyer', 'Manoj Pillai'],
  ['Arun Prakash', null],
  ['Ravi Shankar', 'Priya'],
  ['Vijay Anand', null],
  ['Deepak Raj', null],
  ['Bala Murugan', null],
]

const SINGLES = ['Anita Rao', 'Divya Menon', 'Kavitha Nair', 'Lakshmi Iyer', 'Meera Krishnan', 'Priya Raman']

async function main() {
  const courtRows = await db.select({ id: courts.id, name: courts.name }).from(courts).orderBy(courts.sortOrder)
  if (courtRows.length < 3) throw new Error('Run scripts/setup.ts first — no courts.')
  const day = new Date()
  day.setDate(day.getDate() + 7 + Math.floor(Math.random() * 300))

  const stamp = Math.random().toString(36).slice(2, 6)
  const dbl = await createEvent({
    name: `Men's Doubles ${stamp}`,
    date: day,
    gender: 'mens',
    discipline: 'doubles',
    finalsStage: 'final_only',
    courtIds: courtRows.slice(0, 2).map((c) => c.id),
  })
  const ids = await importPlayers(
    dbl.tournament.id,
    DOUBLES.map(([name]) => ({ name })),
  )
  const idByName = new Map(DOUBLES.map(([name], i) => [name, ids[i]]))
  for (const [name, wish] of DOUBLES) {
    if (!wish) continue
    await db
      .update(tournamentPlayers)
      .set({ partnerWish: wish, partnerPlayerId: idByName.get(wish) ?? null, source: 'link' })
      .where(
        and(
          eq(tournamentPlayers.tournamentId, dbl.tournament.id),
          eq(tournamentPlayers.playerId, idByName.get(name)!),
        ),
      )
  }
  await syncCategoryPlayers(dbl.tournament.id)

  const sgl = await createEvent({
    name: `Women's Singles ${stamp}`,
    date: day,
    gender: 'womens',
    discipline: 'singles',
    finalsStage: 'none',
    courtIds: courtRows.slice(2, 3).map((c) => c.id),
  })
  await importPlayers(
    sgl.tournament.id,
    SINGLES.map((name) => ({ name })),
  )
  await syncCategoryPlayers(sgl.tournament.id)

  // Five people and no wishes: random pairing has to leave one out and say who.
  const odd = await createEvent({
    name: `Mixed Doubles ${stamp}`,
    date: day,
    gender: 'mixed',
    discipline: 'doubles',
    finalsStage: 'none',
    courtIds: courtRows.slice(3, 4).map((c) => c.id),
  })
  await importPlayers(
    odd.tournament.id,
    ['Anand Kumar', 'Bhavana Reddy', 'Chandran Pillai', 'Devi Prasad', 'Ezhil Arasan'].map((name) => ({ name })),
  )
  await syncCategoryPlayers(odd.tournament.id)

  const n = await db.select({ id: players.id }).from(players)
  console.log(`doubles ${dbl.tournament.slug}`)
  console.log(`singles ${sgl.tournament.slug}`)
  console.log(`odd ${odd.tournament.slug}`)
  console.log(`players ${n.length} on the roster`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
