/**
 * A realistic Sunday, mid-afternoon — for looking at, not for testing.
 *
 * Design work done against an empty database produces screens that only look
 * right when they are empty. This builds the awkward middle of a real day:
 * three categories sharing four courts, long Tamil names that wrap, a court
 * standing idle, a match that has been on far too long, a disagreement waiting
 * to be settled, and a pool table where the qualifying place turns on the
 * tiebreak rather than on wins.
 *
 *   DATABASE_URL=... npx tsx scripts/demo.ts
 */
import { db } from '../src/db'
import { courts, matches, tournaments } from '../src/db/schema'
import { eq } from 'drizzle-orm'
import { newId } from '../src/lib/ids'
import {
  createCategory,
  createTeams,
  createTournament,
  generateDrawForCategory,
  importPlayers,
  listCategories,
  listMatches,
  listTournamentPlayers,
  pairingSeedFor,
  pairRandomly,
  setCategoryPlayers,
} from '../src/server/tournaments'
import { submitResult } from '../src/server/scoring'
import { sendToCourt } from '../src/server/board'
import { ensureReady } from '../src/server/bootstrap'

const MENS = `
Karthik Subramanian
Ravi Shankar
Arun Prakash
Vijay Anand
Sathish Kumar
Bala Murugan
Naveen Krishnan
Deepak Raj
Hari Venkatesh
Manoj Pillai
Suresh Babu
Ganesh Iyer
`

const WOMENS = `
Priya Ramesh
Divya Natarajan
Meera Krishnamurthy
Anjali Raghavan
Lakshmi Narayanan
Kavitha Selvam
Sowmya Balaji
Nithya Sundaram
`

const MIXED_EXTRA = `
Rahul Menon
Aishwarya Rajan
Vikram Chandran
Shruti Mohan
`

async function main() {
  await ensureReady()

  const existing = await db.select().from(tournaments).limit(1)
  if (existing.length) {
    console.log('There is already a tournament here — reset the database first.')
    process.exit(1)
  }

  const t = await createTournament({
    name: 'Sunday Social — September',
    startDate: new Date(),
    description: 'Demo data.',
  })

  const shapes = [
    { name: "Men's Doubles", roster: MENS, discipline: 'doubles' as const, gender: 'mens' as const, size: 2 },
    { name: "Women's Doubles", roster: WOMENS, discipline: 'doubles' as const, gender: 'womens' as const, size: 2 },
    { name: 'Mixed Doubles', roster: MIXED_EXTRA + MENS.split('\n').slice(1, 5).join('\n') + '\n' + WOMENS.split('\n').slice(1, 5).join('\n'), discipline: 'doubles' as const, gender: 'mixed' as const, size: 2 },
  ]

  for (const shape of shapes) {
    const names = shape.roster
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean)
    await importPlayers(t.id, names.map((name) => ({ name })))
  }

  const roster = await listTournamentPlayers(t.id)
  const byName = new Map(roster.map((p) => [p.name, p.id]))

  for (const shape of shapes) {
    const categoryId = await createCategory({
      tournamentId: t.id,
      name: shape.name,
      discipline: shape.discipline,
      gender: shape.gender,
      finalsStage: 'final_only',
    })
    const ids = shape.roster
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean)
      .map((n) => byName.get(n))
      .filter(Boolean) as string[]

    await setCategoryPlayers(categoryId, ids)
    const seed = await pairingSeedFor(categoryId)
    const pairs = pairRandomly(ids, seed, shape.size)
    await createTeams(categoryId, pairs, new Map(roster.map((p) => [p.id, p.name])))
    await generateDrawForCategory(categoryId)
  }

  await db
    .update(tournaments)
    .set({ status: 'live', publishedAt: new Date() })
    .where(eq(tournaments.id, t.id))

  // ── play most of it out ─────────────────────────────────────────────────
  const cats = await listCategories(t.id)
  const scorelines: Array<[number, number][]> = [
    [[11, 7], [11, 9]],
    [[9, 11], [11, 8], [11, 6]],
    [[11, 4], [11, 6]],
    [[11, 9], [8, 11], [12, 10]],
    [[11, 2], [11, 5]],
    [[7, 11], [11, 9], [11, 7]],
  ]

  let n = 0
  for (const cat of cats) {
    const all = await listMatches(t.id)
    const group = all.filter((m) => m.categoryId === cat.id && m.stage === 'group')
    // Leave the last two of each pool unplayed, so the board has a queue.
    for (const m of group.slice(0, Math.max(1, group.length - 2))) {
      if (!m.teamAId || !m.teamBId) continue
      const line = scorelines[n++ % scorelines.length]
      const gs = line.map(([scoreA, scoreB], idx) => ({ gameNo: idx + 1, scoreA, scoreB }))
      const res = await submitResult({
        matchId: m.id,
        games: gs,
        resultType: 'normal',
        winnerTeamId: null,
        submittingTeamId: null,
        attributorKey: `user:demo:${m.id}`,
        actorType: 'user',
        clientEventId: newId('ce'),
        authoritative: true,
      })
      if (!res.ok) console.error('  submit failed:', res.error)
    }
  }

  // ── the awkward middle ──────────────────────────────────────────────────
  const courtRows = await db.select().from(courts).where(eq(courts.active, true))
  const ready = (await listMatches(t.id)).filter(
    (m) => m.status === 'ready' && m.teamAId && m.teamBId && m.resultState === 'none',
  )

  // Two matches on court; one of them has been on far too long, so the board
  // asks about it.
  let placed = 0
  for (const m of ready) {
    if (placed >= 2) break
    const res = await sendToCourt(m.id, courtRows[placed].id)
    if (res.ok) placed++
  }

  const live = (await listMatches(t.id)).filter((m) => m.status === 'live')
  if (live[0]) {
    await db
      .update(matches)
      .set({ startedAt: new Date(Date.now() - 58 * 60_000) })
      .where(eq(matches.id, live[0].id))
  }

  // One result reported and not yet settled, and one the two sides disagree on.
  const settled = (await listMatches(t.id)).filter((m) => m.resultState === 'final')
  if (settled[0]) {
    await db
      .update(matches)
      .set({ resultState: 'reported', reportedAt: new Date(), confirmedAt: null })
      .where(eq(matches.id, settled[0].id))
  }
  if (settled[1]) {
    await db
      .update(matches)
      .set({ resultState: 'disputed', disputeOpenedAt: new Date() })
      .where(eq(matches.id, settled[1].id))
  }

  const finalCount = (await listMatches(t.id)).length
  console.log(
    `Sunday Social ready: ${cats.length} categories, ${roster.length} players, ${finalCount} matches, ${placed} on court.`,
  )
  console.log(`  public   /t/${t.slug}`)
  console.log(`  board    /admin/t/${t.slug}/board`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
