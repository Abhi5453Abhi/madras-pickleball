/**
 * A tournament with the mockup's registration list on it: twelve people in,
 * most through the link with partner wishes, some added by hand, and one
 * "Ravi S" flagged as a possible duplicate of Ravi Shankar.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/seed-reg.ts
 *
 * With --check it also walks the paths the browser cannot reach without the
 * Teams screen: removing somebody in a pair that has not played splits the
 * pair; a pair on the schedule, or one with a result, is refused.
 */
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from '../src/db'
import { courts, tournamentPlayers } from '../src/db/schema'
import { createEvent, primaryCategory } from '../src/server/events'
import { addPlayer, listRoster, mergePlayers, removePlayer } from '../src/server/registration'
import { submitResult } from '../src/server/scoring'
import { createTeams, generateDrawForCategory, listMatches } from '../src/server/tournaments'

const LIST: Array<[string, string | null, 'link' | 'hand', string?]> = [
  ['Karthik Subramanian', 'Sathish Kumar', 'link'],
  ['Sathish Kumar', 'Karthik Subramanian', 'link', '98400 11111'],
  ['Arun Prakash', null, 'hand', '98400 12345'],
  ['Ravi Shankar', 'Arun Prakash', 'link'],
  ['Hari Venkatesh', 'Naveen Krishnan', 'link'],
  ['Naveen Krishnan', 'Hari Venkatesh', 'link'],
  ['Deepak Raj', null, 'link'],
  ['Ganesh Iyer', 'Bala Murugan', 'link'],
  ['Bala Murugan', 'Ganesh Iyer', 'link'],
  ['Vignesh R', null, 'hand'],
  ['Suresh Babu', 'Vignesh R', 'link'],
  ['Ravi S', null, 'link'],
]

async function main() {
  const check = process.argv.includes('--check')
  const [court] = await db.select({ id: courts.id }).from(courts).limit(1)
  const { tournament } = await createEvent({
    name: check ? "Men's Doubles — check" : "Men's Doubles — seeded",
    date: new Date(),
    gender: 'mens',
    discipline: 'doubles',
    finalsStage: 'final_only',
    courtIds: court ? [court.id] : [],
  })
  for (const [name, partnerWish, source, phone] of LIST) {
    const res = await addPlayer(tournament.id, { name, partnerWish, source, phone })
    if (!res.ok) throw new Error(`${name}: ${res.error}`)
  }
  const roster = await listRoster(tournament.id)
  console.log(`tournament  ${tournament.slug}`)
  for (const r of roster) {
    console.log(
      `  ${r.name.padEnd(22)} ${r.partner ? `wants ${r.partner}` : 'no partner named'} · ${r.source}${
        r.duplicateOf ? ` · same as ${r.duplicateOf.name}?` : ''
      }`,
    )
  }
  if (!check) process.exit(0)

  const fails: string[] = []
  const ok = (label: string, cond: boolean, extra = '') => {
    console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${label} ${cond ? '' : extra}`)
    if (!cond) fails.push(label)
  }
  const id = (name: string) => roster.find((r) => r.name === name)!.playerId

  console.log('\nmerge carries the partner wish across')
  const ravi = roster.find((r) => r.name === 'Ravi S')!
  ok('Ravi S is flagged against Ravi Shankar', ravi.duplicateOf?.name === 'Ravi Shankar')
  // Ravi Shankar already wants Arun; give the duplicate a wish that Deepak named back.
  await db
    .update(tournamentPlayers)
    .set({ partnerWish: 'Deepak Raj', partnerPlayerId: id('Deepak Raj') })
    .where(eq(tournamentPlayers.playerId, ravi.playerId))
  await db
    .update(tournamentPlayers)
    .set({ partnerWish: 'Ravi S', partnerPlayerId: ravi.playerId })
    .where(eq(tournamentPlayers.playerId, id('Deepak Raj')))
  const merged = await mergePlayers(tournament.id, id('Ravi Shankar'), ravi.playerId)
  ok('merge says so', merged.ok && /one person on the list now/.test(merged.note), JSON.stringify(merged))
  let after = await listRoster(tournament.id)
  ok('11 in, no flag', after.length === 11 && after.every((r) => !r.duplicateOf))
  ok(
    'Ravi Shankar keeps his own wish (Arun), Deepak now points at Ravi Shankar',
    after.find((r) => r.name === 'Ravi Shankar')?.partner === 'Arun Prakash' &&
      after.find((r) => r.name === 'Deepak Raj')?.partner === 'Ravi Shankar',
    JSON.stringify(after.map((r) => [r.name, r.partner])),
  )

  console.log('\nremoving somebody in a pair that has not played')
  const category = await primaryCategory(tournament.id)
  const names = new Map(after.map((r) => [r.playerId, r.name]))
  await createTeams(
    category.id,
    [
      [id('Karthik Subramanian'), id('Sathish Kumar')],
      [id('Hari Venkatesh'), id('Naveen Krishnan')],
      [id('Ganesh Iyer'), id('Bala Murugan')],
    ],
    names,
  )
  const split = await removePlayer(tournament.id, id('Karthik Subramanian'))
  ok('splits the pair and says so', split.ok && /the pair Karthik Subramanian \/ Sathish Kumar is split/.test(split.note), JSON.stringify(split))
  after = await listRoster(tournament.id)
  ok('10 in; Sathish still says who he wanted', after.length === 10 && after.find((r) => r.name === 'Sathish Kumar')?.partner === 'Karthik Subramanian')

  console.log('\na pair on the schedule, and one that has played')
  await generateDrawForCategory(category.id)
  const scheduled = await removePlayer(tournament.id, id('Hari Venkatesh'))
  ok('on the schedule → refused, plainly', !scheduled.ok && /on the schedule/.test(scheduled.error), JSON.stringify(scheduled))
  const [m] = (await listMatches(tournament.id)).filter((x) => x.teamAId && x.teamBId)
  const res = await submitResult({
    matchId: m.id,
    games: [
      { gameNo: 1, scoreA: 11, scoreB: 7 },
      { gameNo: 2, scoreA: 11, scoreB: 9 },
    ],
    resultType: 'normal',
    winnerTeamId: m.teamAId,
    submittingTeamId: null,
    attributorKey: 'seed',
    actorType: 'user',
    clientEventId: 'seed-reg-1',
    authoritative: true,
  })
  ok('a result went in', res.ok, JSON.stringify(res))
  const played = await removePlayer(tournament.id, id('Hari Venkatesh'))
  ok('has played → refused, plainly', !played.ok && /already played/.test(played.error), JSON.stringify(played))

  console.log(fails.length ? `\n${fails.length} failed` : '\nall good')
  process.exit(fails.length ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
