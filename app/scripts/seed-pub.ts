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
import { clearCourt, flowTournament, sendToCourt } from '../src/server/board'
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

/**
 * Score matches in play order. Starting a tournament puts the first matches
 * on court by itself, and every saved score pulls the next one on, so this
 * only ever scores whatever is live — and sends one itself only when the
 * flow has nothing on court.
 */
async function play(tournamentId: string, courtIds: string[], results: number, leaveOnCourt: number) {
  let scored = 0
  for (let guard = 0; guard < 80 && scored < results; guard++) {
    const all = await listMatches(tournamentId)
    let live = all.filter((m) => m.status === 'live' && m.teamAId && m.teamBId)
    if (!live.length) {
      const next = all.find((m) => m.status === 'ready' && m.resultState === 'none' && m.teamAId && m.teamBId)
      if (!next) break
      const sent = await sendToCourt(next.id, courtIds[0])
      if (!sent.ok) throw new Error(sent.error)
      live = [{ ...next, status: 'live' as const }]
    }
    const m = live.sort((a, b) => a.roundIndex - b.roundIndex || a.seq - b.seq)[0]
    const gs = SCORES[scored % SCORES.length].map(([scoreA, scoreB], i) => ({ gameNo: i + 1, scoreA, scoreB }))
    const aWins = gs.filter((g) => g.scoreA > g.scoreB).length
    const res = await submitResult({
      matchId: m.id,
      games: gs,
      resultType: 'normal',
      winnerTeamId: aWins >= 2 ? m.teamAId! : m.teamBId!,
      submittingTeamId: null,
      attributorKey: 'user:seed',
      actorType: 'user',
      clientEventId: newId('ce'),
      authoritative: true,
    })
    if (!res.ok) throw new Error(res.error)
    // `submitResult` from a script does not flow; the app's action does.
    await flowTournament(tournamentId)
    scored++
  }
  // Leave the courts as asked: the flow fills them; clear the rest.
  const all = await listMatches(tournamentId)
  const live = all.filter((m) => m.status === 'live')
  for (const m of live.slice(leaveOnCourt)) await clearCourt(m.id)
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
