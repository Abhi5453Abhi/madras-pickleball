/**
 * A Tuesday evening in the awkward middle: a game most of the way full with
 * some people confirmed and some not, a waitlist behind it, somebody's guest,
 * one person keeping their name off the public list — and last week's game
 * already closed, so the finished state is there to look at too.
 *
 * Design work done against an empty database produces screens that only look
 * right when they are empty.
 *
 *   NODE_OPTIONS="--conditions=react-server" npx tsx scripts/seed-games.ts
 */
import 'dotenv/config'
import { eq } from 'drizzle-orm'
import { db } from '../src/db'
import { users } from '../src/db/schema'
import { ensureReady } from '../src/server/bootstrap'
import {
  confirmSpot,
  createSession,
  endSession,
  joinSession,
  publishSession,
  setPresent,
} from '../src/server/sessions'
import { runTick } from '../src/server/daily-reconcile'

const REGULARS: Array<[string, string]> = [
  ['Karthik Subramanian', '98400 11111'],
  ['Sathish Kumar', '98400 11112'],
  ['Arun Prakash', '98400 11113'],
  ['Ravi Shankar', '98400 11114'],
  ['Hari Venkatesh', '98400 11115'],
  ['Naveen Krishnan', '98400 11116'],
  ['Deepak Raj', '98400 11117'],
  ['Ganesh Iyer', '98400 11118'],
  ['Bala Murugan', '98400 11119'],
  ['Vignesh Rajan', '98400 11120'],
  ['Suresh Babu', '98400 11121'],
  ['Priya Sundaram', '98400 11122'],
  ['Anita Rao', '98400 11123'],
  ['Meera Balaji', '98400 11124'],
]

/**
 * The seeded organiser. `created_by_user_id` and every audit row are real
 * foreign keys, so a made-up actor id fails at the database rather than
 * quietly writing a dangling reference.
 */
async function organiser() {
  const [row] = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(eq(users.role, 'super_admin'))
    .limit(1)
  if (!row) throw new Error('No organiser. Run npm run setup first.')
  return row
}

/** 19:00–21:00 at the venue, n days from today. India is +05:30, always. */
function evening(daysFromNow: number) {
  const d = new Date(Date.now() + daysFromNow * 86_400_000)
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
  return { startsAt: new Date(`${day}T19:00:00+05:30`), endsAt: new Date(`${day}T21:00:00+05:30`) }
}

async function main() {
  await ensureReady()
  const HOST = await organiser()

  // ── the one coming up ──
  const soon = evening(2)
  const made = await createSession(
    { title: 'Tuesday evening social', ...soon, pricePaise: 30000, capacity: 12, courtCount: 2 },
    HOST,
  )
  if (!made.ok) throw new Error(made.error)
  const s = made.session
  await publishSession(s.id, HOST)

  const joined: { participantId: string; playerId: string }[] = []
  for (const [name, phone] of REGULARS) {
    const res = await joinSession({
      sessionId: s.id,
      name,
      phone,
      source: 'self',
      deviceId: `seed-${name.toLowerCase().replace(/\W/g, '')}`,
      hideFromPublic: name === 'Meera Balaji',
    })
    if (!res.ok) throw new Error(`${name}: ${res.error}`)
    joined.push({ participantId: res.participantId, playerId: res.playerId })
  }

  // Most have confirmed; three have not, which is what the gate is for.
  for (const p of joined.slice(0, 9)) await confirmSpot(p.participantId)

  // Somebody's guest: they play, the inviter owes. The inviter is the player
  // who already joined above — adding the same name again is refused, which is
  // the point of that rule.
  const guest = await joinSession({
    sessionId: s.id,
    name: 'Rahul Menon',
    source: 'host',
    guestOfPlayerId: joined[0].playerId,
  })
  if (!guest.ok) console.warn(`guest: ${guest.error}`)

  // ── last week's, already closed ──
  const past = evening(-5)
  const old = await createSession(
    { title: 'Tuesday evening social', ...past, pricePaise: 30000, capacity: 12, courtCount: 2 },
    HOST,
  )
  if (!old.ok) throw new Error(old.error)
  await publishSession(old.session.id, HOST)
  const played: string[] = []
  for (const [name, phone] of REGULARS.slice(0, 10)) {
    const res = await joinSession({ sessionId: old.session.id, name, phone, source: 'host' })
    if (res.ok) played.push(res.participantId)
  }
  // Eight turned up; two did not, and produce no charge when billing arrives.
  for (const id of played.slice(0, 8)) await setPresent(id, true, past.endsAt)
  await endSession(old.session.id, HOST, past.endsAt)
  await runTick(new Date())

  console.log(`\nUpcoming:  /g/${s.slug}`)
  console.log(`Host:      /admin/g/${s.slug}`)
  console.log(`Finished:  /admin/g/${old.session.slug}`)
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
