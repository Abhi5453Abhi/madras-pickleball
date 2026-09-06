/**
 * Two doubles tournaments today, on different courts, for walking the public
 * pages and More: Men's Doubles on Courts 1–2 part-played with two matches on
 * court, Mixed Doubles on Court 3 played to the end and finished.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/seed-pub.ts
 */
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from '../src/db'
import { courts, tournaments } from '../src/db/schema'
import { newId } from '../src/lib/ids'
import { sendToCourt } from '../src/server/board'
import { createEvent, finishEvent, startEvent, syncCategoryPlayers } from '../src/server/events'
import { submitResult } from '../src/server/scoring'
import {
  createTeams,
  generateDrawForCategory,
  importPlayers,
  listMatches,
  listTournamentPlayers,
} from '../src/server/tournaments'

const MENS = [
  'Karthik Subramanian',
  'Sathish Kumar',
  'Ravi Shankar',
  'Vijay Anand',
  'Hari Venkatesh',
  'Naveen Krishnan',
  'Deepak Raj',
  'Bala Murugan',
  'Arun Prakash',
  'Manoj Pillai',
  'Suresh Babu',
  'Ganesh Iyer',
]

const MIXED = [
  'Priya Ramesh',
  'Rahul Menon',
  'Divya Natarajan',
  'Vikram Sethu',
  'Meera Krishnamurthy',
  'Anand Raghavan',
  'Lakshmi Narayanan',
  'Kiran Balaji',
]

const SCORES: Array<Array<[number, number]>> = [
  [[11, 7], [11, 9]],
  [[9, 11], [11, 8], [11, 6]],
  [[11, 4], [11, 8]],
  [[11, 9], [7, 11], [11, 9]],
  [[11, 6], [11, 3]],
  [[8, 11], [11, 9], [11, 7]],
  [[11, 8], [11, 10]],
]

async function make(
  name: string,
  gender: 'mens' | 'mixed',
  names: string[],
  courtIds: string[],
  phoneFrom: number,
) {
  const { tournament, categoryId } = await createEvent({
    name,
    date: new Date(),
    gender,
    discipline: 'doubles',
    finalsStage: 'final_only',
    courtIds,
  })
  await importPlayers(
    tournament.id,
    // Phones are the dedupe key, so each list gets its own range.
    names.map((n, i) => ({ name: n, phone: `+9198765${String(phoneFrom + i).padStart(5, '0')}` })),
  )
  await syncCategoryPlayers(tournament.id)
  const roster = await listTournamentPlayers(tournament.id)
  const byName = new Map(roster.map((p) => [p.name, p.id]))
  const pairs: string[][] = []
  for (let i = 0; i < names.length; i += 2) pairs.push([byName.get(names[i])!, byName.get(names[i + 1])!])
  await createTeams(categoryId, pairs, new Map(roster.map((p) => [p.id, p.name])))
  await generateDrawForCategory(categoryId)
  const started = await startEvent(tournament.id)
  if (!started.ok) throw new Error(started.error)
  return tournament
}

/** Play matches in order: send the next ready one to a free court, score it. */
async function play(tournamentId: string, courtIds: string[], results: number, leaveOnCourt: number) {
  let scored = 0
  for (let guard = 0; guard < 60 && scored < results; guard++) {
    const all = await listMatches(tournamentId)
    const next = all.find((m) => m.status === 'ready' && m.resultState === 'none' && m.teamAId && m.teamBId)
    if (!next) break
    const live = new Set(all.filter((m) => m.status === 'live').map((m) => m.courtId))
    const court = courtIds.find((c) => !live.has(c)) ?? courtIds[0]
    const sent = await sendToCourt(next.id, court)
    if (!sent.ok) throw new Error(sent.error)
    const gs = SCORES[scored % SCORES.length].map(([scoreA, scoreB], i) => ({ gameNo: i + 1, scoreA, scoreB }))
    const aWins = gs.filter((g) => g.scoreA > g.scoreB).length
    const res = await submitResult({
      matchId: next.id,
      games: gs,
      resultType: 'normal',
      winnerTeamId: aWins >= 2 ? next.teamAId! : next.teamBId!,
      submittingTeamId: null,
      attributorKey: 'user:seed',
      actorType: 'user',
      clientEventId: newId('ce'),
      authoritative: true,
    })
    if (!res.ok) throw new Error(res.error)
    scored++
  }
  // Then put the next matches on court and leave them there.
  for (let i = 0; i < leaveOnCourt; i++) {
    const all = await listMatches(tournamentId)
    const live = new Set(all.filter((m) => m.status === 'live').map((m) => m.courtId))
    const court = courtIds.find((c) => !live.has(c))
    const next = all.find((m) => m.status === 'ready' && m.resultState === 'none' && m.teamAId && m.teamBId)
    if (!court || !next) break
    const sent = await sendToCourt(next.id, court)
    if (!sent.ok) throw new Error(sent.error)
  }
  return scored
}

async function main() {
  const courtRows = await db.select().from(courts).orderBy(courts.sortOrder)
  const [c1, c2, c3] = courtRows.map((c) => c.id)

  const mens = await make("Men's Doubles", 'mens', MENS, [c1, c2], 43210)
  const n = await play(mens.id, [c1, c2], 7, 2)
  console.log(`Men's Doubles   /t/${mens.slug}  ${n} played, 2 on court`)

  const mixed = await make('Mixed Doubles', 'mixed', MIXED, [c3], 43300)
  const m = await play(mixed.id, [c3], 99, 0)
  const fin = await finishEvent(mixed.id)
  if (!fin.ok) throw new Error(fin.error)
  console.log(`Mixed Doubles   /t/${mixed.slug}  ${m} played, finished`)

  const [row] = await db.select({ slug: tournaments.slug }).from(tournaments).where(eq(tournaments.id, mens.id))
  console.log(JSON.stringify({ mens: row.slug, mixed: mixed.slug }))
  process.exit(0)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
