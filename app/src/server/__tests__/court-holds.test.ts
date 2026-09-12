import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { transact } from '@/db'
import { courtHolds, courtHoldSlots, courts, gameSessions, tournaments } from '@/db/schema'
import { venueDayKey } from '@/lib/time'
import { seedVenue, startTestDb, truncate, type TestDb } from '@/test/db'
import {
  blockCourt,
  CourtTaken,
  courtDay,
  courtsHeldBy,
  dayEnd,
  dayKeysBetween,
  dayStart,
  freeCourtsBetween,
  gaps,
  holdsBetween,
  holdsCourtAt,
  isCourtClash,
  lastSlot,
  setHolds,
  slotFloor,
  tournamentWindows,
  unblockCourt,
} from '../courts'
import { assignCourts, deleteEvent, finishEvent, tournamentHours } from '../events'
import {
  cancelSession,
  createSession,
  endSession,
  extendSession,
  publishSession,
  rescheduleSession,
  setSessionCourts,
  startSession,
} from '../sessions'
import { venueCourts } from '../venue'

/**
 * Court occupancy, against a real Postgres.
 *
 * The guarantee under test is a unique index on a quarter-hour grid, maintained
 * by a trigger — neither of which exists in a fake. Every "is this refused"
 * assertion here is asking Postgres, which is the only place the answer is
 * binding.
 */

let tdb: TestDb
let actor: { id: string; username: string }

/**
 * An evening at the venue (+05:30), always in the future.
 *
 * Derived from today rather than written down: a fixed date stops being the
 * future, and two thirds of this file would have started failing on the day it
 * passed — with failures about "hours that have already gone" rather than about
 * anything the code had done wrong.
 */
const plusDays = (n: number) => venueDayKey(new Date(Date.now() + n * 24 * 60 * 60_000))
const DAY = plusDays(4)
const NEXT_DAY = plusDays(5)
const WEEKEND = plusDays(8)
const WEEKEND_2 = plusDays(9)
const WEEKEND_3 = plusDays(10)
const at = (hhmm: string, day = DAY) => new Date(`${day}T${hhmm}:00+05:30`)

beforeAll(async () => {
  tdb = await startTestDb()
  actor = await seedVenue(tdb.handle)
})

afterAll(async () => {
  await tdb.client.close()
})

beforeEach(async () => {
  await truncate(tdb.handle)
  await tdb.handle.delete(courtHolds)
  await tdb.handle.delete(courts)
  await tdb.handle.delete(tournaments)
  await tdb.handle.insert(courts).values([
    { id: 'c1', venueId: 'venue-test', name: 'Court 1', sortOrder: 1 },
    { id: 'c2', venueId: 'venue-test', name: 'Court 2', sortOrder: 2 },
    { id: 'c3', venueId: 'venue-test', name: 'Court 3', sortOrder: 3 },
  ])
})

async function makeTournament(
  id: string,
  name: string,
  opts: { start?: string; end?: string; status?: 'draft' | 'registration' | 'live' } = {},
) {
  await tdb.handle.insert(tournaments).values({
    id,
    name,
    slug: id,
    venueId: 'venue-test',
    startDate: at('08:00', opts.start ?? DAY),
    endDate: at('08:00', opts.end ?? opts.start ?? DAY),
    status: opts.status ?? 'live',
  })
  return id
}

async function makeGame(
  title: string,
  from: string,
  to: string,
  courtIds: string[],
  day = DAY,
) {
  const res = await createSession(
    {
      title,
      startsAt: at(from, day),
      endsAt: at(to, day),
      pricePaise: 30000,
      capacity: 8,
      courtCount: courtIds.length,
      courtIds,
    },
    actor,
    at('08:00', day),
  )
  return res
}

// ─────────────────────────── the grid itself ───────────────────────────

describe('the quarter-hour grid', () => {
  it('floors to the quarter hour, and the last slot of a window is inside it', () => {
    expect(slotFloor(at('19:07')).toISOString()).toBe(at('19:00').toISOString())
    expect(slotFloor(at('19:15')).toISOString()).toBe(at('19:15').toISOString())
    // 19:00–21:00 occupies 19:00 … 20:45. The 21:00 slot belongs to whoever
    // comes next, which is why abutting holds do not fight.
    expect(lastSlot(at('21:00')).toISOString()).toBe(at('20:45').toISOString())
  })

  it('holds a whole day as 96 slots, and hours as the hours', async () => {
    await makeTournament('t1', 'All day')
    expect((await assignCourts('t1', ['c1'])).ok).toBe(true)
    const all = await tdb.handle.select().from(courtHoldSlots)
    expect(all.length).toBe(96)
  })

  it('rounds outward, so a five-minute hold still costs its quarter hour', async () => {
    const block = await blockCourt({
      courtId: 'c1',
      reason: 'Net repair',
      from: at('19:05'),
      until: at('19:10'),
    })
    expect(block.ok).toBe(true)
    const slots = await tdb.handle.select().from(courtHoldSlots)
    expect(slots.length).toBe(1)
    // Which means 19:00–19:15 is gone, not just 19:05–19:10. Over-reserving is
    // the safe direction: the other way round puts two games on one court.
    const clash = await blockCourt({ courtId: 'c1', reason: 'Coaching', from: at('19:00'), until: at('19:15') })
    expect(clash.ok).toBe(false)
  })
})

// ─────────────────────── the headline of stage 2 ───────────────────────

describe('courts held for a time range', () => {
  it('lets a seven o’clock game have a court a tournament had all morning', async () => {
    await makeTournament('t1', 'Men’s Doubles')
    // 9 to 3, not "Tuesday".
    const assigned = await assignCourts('t1', ['c1', 'c2'], { fromMin: 9 * 60, untilMin: 15 * 60 })
    expect(assigned.ok).toBe(true)

    const evening = await makeGame('Tuesday social', '19:00', '21:00', ['c1'])
    expect(evening.ok).toBe(true)
    const held = await courtsHeldBy({ kind: 'session', sessionId: evening.ok ? evening.session.id : '' })
    expect(held.map((c) => c.name)).toEqual(['Court 1'])
  })

  it('still refuses the court while the tournament is on it', async () => {
    await makeTournament('t1', 'Men’s Doubles')
    await assignCourts('t1', ['c1'], { fromMin: 9 * 60, untilMin: 15 * 60 })
    const clash = await makeGame('Lunchtime', '14:00', '16:00', ['c1'])
    expect(clash.ok).toBe(false)
    // The sentence names who has it and until when — "blocked" is not a next step.
    expect(clash.ok === false && clash.error).toContain('Court 1')
    expect(clash.ok === false && clash.error).toContain('Men’s Doubles')
  })

  it('holds a two-day tournament’s courts on BOTH days', async () => {
    await makeTournament('t1', 'Weekender', { start: WEEKEND, end: WEEKEND_2 })
    expect((await assignCourts('t1', ['c1'])).ok).toBe(true)
    const holds = await tdb.handle.select().from(courtHolds).where(eq(courtHolds.tournamentId, 't1'))
    expect(holds.length).toBe(2)
    // Day two is the bug the old `unique (tournament_id, court_id)` made
    // unrepresentable: the tournament simply lost its court overnight.
    const dayTwo = await holdsBetween(at('10:00', WEEKEND_2), at('11:00', WEEKEND_2))
    expect(dayTwo.map((h) => h.holderName)).toEqual(['Weekender'])
  })

  it('lets two games share the evening on different courts, and not on one', async () => {
    const beginners = await makeGame('Beginners', '18:00', '20:00', ['c1'])
    const intermediate = await makeGame('Intermediate', '19:00', '21:00', ['c2'])
    expect(beginners.ok).toBe(true)
    expect(intermediate.ok).toBe(true)

    const both = await makeGame('Third', '19:30', '20:30', ['c1'])
    expect(both.ok).toBe(false)
    expect(both.ok === false && both.error).toContain('Beginners')
  })

  it('lets one game follow another on the same court with no gap', async () => {
    const first = await makeGame('Six to eight', '18:00', '20:00', ['c1'])
    const second = await makeGame('Eight to ten', '20:00', '22:00', ['c1'])
    expect(first.ok).toBe(true)
    expect(second.ok).toBe(true)
  })
})

// ──────────────────────────── blocking ────────────────────────────

describe('taking a court out of action', () => {
  it('keeps a game off it, and gives it back on time', async () => {
    const block = await blockCourt({
      courtId: 'c1',
      reason: 'Coaching batch',
      from: at('17:00'),
      until: at('19:00'),
    })
    expect(block.ok).toBe(true)

    const during = await makeGame('Too early', '18:00', '20:00', ['c1'])
    expect(during.ok).toBe(false)
    expect(during.ok === false && during.error).toContain('Coaching batch')

    const after = await makeGame('Seven o’clock', '19:00', '21:00', ['c1'])
    expect(after.ok).toBe(true)
  })

  it('refuses a block with nothing said about why', async () => {
    const blank = await blockCourt({ courtId: 'c1', reason: '   ', from: at('17:00'), until: at('19:00') })
    expect(blank.ok).toBe(false)
  })

  it('refuses a block that ends before it starts', async () => {
    const backwards = await blockCourt({ courtId: 'c1', reason: 'x', from: at('19:00'), until: at('17:00') })
    expect(backwards.ok).toBe(false)
  })

  it('frees the court the moment the block is given back', async () => {
    const block = await blockCourt({ courtId: 'c1', reason: 'Net', from: at('17:00'), until: at('19:00') })
    expect(block.ok).toBe(true)
    const given = await unblockCourt(block.ok ? block.id : '')
    expect(given.ok).toBe(true)
    expect((await tdb.handle.select().from(courtHoldSlots)).length).toBe(0)
    const now = await makeGame('Five o’clock', '17:00', '19:00', ['c1'])
    expect(now.ok).toBe(true)
  })

  it('will not give back something that is not a block', async () => {
    const game = await makeGame('Evening', '19:00', '21:00', ['c1'])
    const [hold] = await tdb.handle.select().from(courtHolds)
    expect(game.ok).toBe(true)
    const wrong = await unblockCourt(hold.id)
    expect(wrong.ok).toBe(false)
    expect((await tdb.handle.select().from(courtHolds)).length).toBe(1)
  })
})

// ───────────────────── holds end when the holder does ─────────────────────

describe('letting go', () => {
  it('gives back a tournament’s courts outright when it finishes before they start', async () => {
    await makeTournament('t1', 'Morning')
    await assignCourts('t1', ['c1'], { fromMin: 9 * 60, untilMin: 21 * 60 })
    // Before: the evening is the tournament's.
    expect((await makeGame('Evening', '19:00', '21:00', ['c1'])).ok).toBe(false)

    expect((await finishEvent('t1')).ok).toBe(true)

    // Its hours had not started, so there is nothing to truncate — the whole
    // hold goes. The old model left the rows in place and only *said* the
    // courts were free, which is how the evening's organiser met a constraint
    // error instead of a court.
    const left = await tdb.handle.select().from(courtHolds).where(eq(courtHolds.tournamentId, 't1'))
    expect(left.length).toBe(0)
    expect((await makeGame('Evening', '19:00', '21:00', ['c1'])).ok).toBe(true)
  })

  it('truncates a tournament’s hold to the minute it finishes, mid-run', async () => {
    // A hold that began this morning, so "now" is genuinely inside it. A hold
    // taken up this second starts at the next quarter hour and has not begun,
    // which is the other branch and is covered above.
    const today = venueDayKey(new Date())
    await makeTournament('t2', 'Today', { start: today })
    await tdb.handle.insert(courtHolds).values({
      id: 'ch_running',
      courtId: 'c2',
      kind: 'tournament',
      tournamentId: 't2',
      heldFrom: dayStart(today),
      heldUntil: dayEnd(today),
    })
    const before = new Date()

    expect((await finishEvent('t2')).ok).toBe(true)

    const [hold] = await tdb.handle.select().from(courtHolds).where(eq(courtHolds.tournamentId, 't2'))
    expect(hold).toBeTruthy()
    // The morning it already played stays on the record; the rest of the day
    // goes back to the venue.
    expect(hold.heldFrom.toISOString()).toBe(dayStart(today).toISOString())
    // Rounded down to the quarter hour it ended in, so the court is usable
    // again straight away rather than fifteen minutes later.
    expect(hold.heldUntil.getTime()).toBeGreaterThan(before.getTime() - 15 * 60_000 - 1000)
    expect(hold.heldUntil.getTime()).toBeLessThanOrEqual(Date.now())
    expect(hold.heldUntil.getTime() % (15 * 60_000)).toBe(0)
    expect(hold.releasedAt).not.toBe(null)
  })

  it('lets the evening’s tournament have the court the morning’s just finished on', async () => {
    const today = venueDayKey(new Date())
    await makeTournament('t1', 'Morning', { start: today })
    await assignCourts('t1', ['c1'], null)
    expect((await finishEvent('t1')).ok).toBe(true)

    // The morning's hold is truncated to a minute ago, so a whole-day hold for
    // the evening's tournament would overlap every quarter hour before it. The
    // hold is taken up from now instead — nobody can hold a court in the past.
    await makeTournament('t2', 'Evening', { start: today })
    const res = await assignCourts('t2', ['c1'], null)
    expect(res.ok).toBe(true)
    const [hold] = await tdb.handle.select().from(courtHolds).where(eq(courtHolds.tournamentId, 't2'))
    expect(hold.heldFrom.getTime()).toBeGreaterThan(dayStart(today).getTime())
    // ...and still runs to the end of the day.
    expect(hold.heldUntil.getTime()).toBe(dayStart(today).getTime() + 24 * 60 * 60_000)
  })

  it('leaves a court it has been playing on all morning exactly where it is', async () => {
    const today = venueDayKey(new Date())
    await makeTournament('t1', 'Today', { start: today })
    // A hold that began this morning, as if the tournament had been running.
    await tdb.handle.insert(courtHolds).values({
      id: 'ch_since_morning',
      courtId: 'c1',
      kind: 'tournament',
      tournamentId: 't1',
      heldFrom: dayStart(today),
      heldUntil: dayEnd(today),
    })

    expect((await assignCourts('t1', ['c1', 'c2'], null)).ok).toBe(true)
    const after = await tdb.handle.select().from(courtHolds).where(eq(courtHolds.tournamentId, 't1'))
    const one = after.find((h) => h.courtId === 'c1')!
    const two = after.find((h) => h.courtId === 'c2')!
    // Same row, same hours: adding a fourth court at eleven must not rewrite
    // the three that have been played on since nine.
    expect(one.id).toBe('ch_since_morning')
    expect(one.heldFrom.toISOString()).toBe(dayStart(today).toISOString())
    // The one it is taking up now starts now, not this morning.
    expect(two.heldFrom.getTime()).toBeGreaterThan(dayStart(today).getTime())
  })

  it('gives a deleted tournament’s courts back outright', async () => {
    await makeTournament('t1', 'Cancelled thing')
    await assignCourts('t1', ['c1', 'c2'])
    expect((await deleteEvent('t1')).ok).toBe(true)
    expect((await tdb.handle.select().from(courtHolds)).length).toBe(0)
    expect((await tdb.handle.select().from(courtHoldSlots)).length).toBe(0)
  })

  it('gives a called-off game’s courts back whole', async () => {
    const game = await makeGame('Called off', '19:00', '21:00', ['c1'])
    expect(game.ok).toBe(true)
    const id = game.ok ? game.session.id : ''
    await publishSession(id, actor)
    expect((await cancelSession(id, 'Rain', actor)).ok).toBe(true)
    expect((await tdb.handle.select().from(courtHolds)).length).toBe(0)
    // Which is the point: somebody else can have the evening.
    expect((await makeGame('Instead', '19:00', '21:00', ['c1'])).ok).toBe(true)
  })

  it('frees the court where a game actually ended, not where it was scheduled to', async () => {
    const game = await makeGame('Early finish', '19:00', '21:00', ['c1'])
    expect(game.ok).toBe(true)
    const id = game.ok ? game.session.id : ''
    await publishSession(id, actor)
    await startSession(id, actor)
    expect((await endSession(id, actor, at('20:00'))).ok).toBe(true)

    const [hold] = await tdb.handle.select().from(courtHolds)
    expect(hold.heldUntil.toISOString()).toBe(at('20:00').toISOString())
    // Eight o'clock onwards is somebody else's now.
    expect((await makeGame('Eight o’clock', '20:00', '22:00', ['c1'])).ok).toBe(true)
  })
})

// ───────────────────── changing your mind mid-evening ─────────────────────

describe('“can we go till 9:30, Court 3 is free”', () => {
  it('extends a live game and its hold with it', async () => {
    const game = await makeGame('Tuesday social', '19:00', '21:00', ['c1'])
    expect(game.ok).toBe(true)
    const id = game.ok ? game.session.id : ''
    await publishSession(id, actor)
    await startSession(id, actor)

    expect((await extendSession(id, at('21:30'), actor, at('20:45'))).ok).toBe(true)
    const [hold] = await tdb.handle.select().from(courtHolds)
    expect(hold.heldUntil.toISOString()).toBe(at('21:30').toISOString())
  })

  it('refuses an extension into somebody else’s hours, and moves nothing', async () => {
    const first = await makeGame('Early', '19:00', '21:00', ['c1'])
    const after = await makeGame('Late', '21:00', '23:00', ['c1'])
    expect(first.ok && after.ok).toBe(true)
    const id = first.ok ? first.session.id : ''
    await publishSession(id, actor)

    const refused = await extendSession(id, at('22:00'), actor, at('20:45'))
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.error).toContain('Late')

    const still = await tdb.handle
      .select()
      .from(courtHolds)
      .where(and(eq(courtHolds.courtId, 'c1')))
    expect(still.length).toBe(2)
    const early = still.find((h) => h.heldFrom.getTime() === at('19:00').getTime())
    expect(early?.heldUntil.toISOString()).toBe(at('21:00').toISOString())
  })

  it('swaps a court under a running game', async () => {
    const game = await makeGame('Tuesday social', '19:00', '21:00', ['c1'])
    expect(game.ok).toBe(true)
    const id = game.ok ? game.session.id : ''
    await publishSession(id, actor)
    await startSession(id, actor)

    const swapped = await setSessionCourts(id, ['c2', 'c3'], actor)
    expect(swapped.ok).toBe(true)
    const now = await courtsHeldBy({ kind: 'session', sessionId: id })
    expect(now.map((c) => c.name)).toEqual(['Court 2', 'Court 3'])
    // And Court 1 is genuinely back: nothing of this game is left on it.
    expect((await holdsBetween(at('19:00'), at('21:00'), ['c1'])).length).toBe(0)
  })

  it('keeps the court count honest when the courts change', async () => {
    const game = await makeGame('Tuesday social', '19:00', '21:00', ['c1'])
    expect(game.ok && game.session.courtCount).toBe(1)
    const id = game.ok ? game.session.id : ''
    await setSessionCourts(id, ['c1', 'c2'], actor)
    const [row] = await tdb.handle.select().from(courtHolds).where(eq(courtHolds.sessionId, id)).limit(1)
    expect(row).toBeTruthy()
    const after = await courtsHeldBy({ kind: 'session', sessionId: id })
    expect(after.length).toBe(2)
  })
})

// ─────────────────────────── what a screen asks ───────────────────────────

describe('what the screens read', () => {
  it('answers “is this court yours right now” by the clock, not by the day', async () => {
    await makeTournament('t1', 'Morning')
    await assignCourts('t1', ['c1'], { fromMin: 9 * 60, untilMin: 15 * 60 })
    expect(await holdsCourtAt({ kind: 'tournament', tournamentId: 't1' }, 'c1', at('10:00'))).toBe(true)
    expect(await holdsCourtAt({ kind: 'tournament', tournamentId: 't1' }, 'c1', at('08:00'))).toBe(false)
    expect(await holdsCourtAt({ kind: 'tournament', tournamentId: 't1' }, 'c1', at('16:00'))).toBe(false)
  })

  it('reads a tournament’s hours back off its holds', async () => {
    await makeTournament('t1', 'Morning')
    await assignCourts('t1', ['c1'], { fromMin: 9 * 60, untilMin: 15 * 60 })
    expect(await tournamentHours('t1')).toEqual({ fromMin: 540, untilMin: 900 })
    await assignCourts('t1', ['c1'], null)
    // A whole day reads back as "no hours", which is what the form shows blank.
    expect(await tournamentHours('t1')).toBe(null)
  })

  it('shows the day as what is on and what is left', async () => {
    await makeTournament('t1', 'Morning')
    await assignCourts('t1', ['c1'], { fromMin: 9 * 60, untilMin: 15 * 60 })
    await blockCourt({ courtId: 'c1', reason: 'Coaching', from: at('17:00'), until: at('18:00') })

    const day = await courtDay(DAY, 'venue-test')
    const one = day.find((d) => d.court.id === 'c1')!
    expect(one.holds.map((h) => h.holderName)).toEqual(['Morning', 'Coaching'])
    expect(one.free.map((f) => `${f.from.toISOString()}–${f.until.toISOString()}`)).toEqual([
      `${dayStart(DAY).toISOString()}–${at('09:00').toISOString()}`,
      `${at('15:00').toISOString()}–${at('17:00').toISOString()}`,
      `${at('18:00').toISOString()}–${dayStart(NEXT_DAY).toISOString()}`,
    ])
    // A court nothing is on is free all day, in one piece.
    const three = day.find((d) => d.court.id === 'c3')!
    expect(three.free.length).toBe(1)
  })

  it('says which courts are free for a window, and who has the rest', async () => {
    await makeTournament('t1', 'Morning')
    await assignCourts('t1', ['c1'], { fromMin: 9 * 60, untilMin: 21 * 60 })
    const free = await freeCourtsBetween(at('19:00'), at('21:00'), 'venue-test')
    expect(free.map((c) => `${c.name}:${c.takenBy?.holderName ?? 'free'}`)).toEqual([
      'Court 1:Morning',
      'Court 2:free',
      'Court 3:free',
    ])
  })

  it('names every holder when a court is asked to be taken out of the venue', async () => {
    await makeTournament('t1', 'Morning')
    await assignCourts('t1', ['c1'], { fromMin: 9 * 60, untilMin: 15 * 60 })
    await makeGame('Evening', '19:00', '21:00', ['c1'])
    const list = await venueCourts()
    const one = list.find((c) => c.id === 'c1')!
    expect(one.heldBy).toContain('Morning')
    expect(one.heldBy).toContain('Evening')
  })
})

// ─────────────────────────── the pure helpers ───────────────────────────

describe('the arithmetic', () => {
  it('walks the days a tournament runs', () => {
    expect(dayKeysBetween(WEEKEND, WEEKEND_3)).toEqual([WEEKEND, WEEKEND_2, WEEKEND_3])
    expect(dayKeysBetween(WEEKEND, WEEKEND)).toEqual([WEEKEND])
    // Backwards is not a range; a typo must not become a loop.
    expect(dayKeysBetween(WEEKEND_3, WEEKEND)).toEqual([])
  })

  it('turns a tournament’s days and hours into windows', () => {
    const w = tournamentWindows(at('08:00', WEEKEND), at('08:00', WEEKEND_2), {
      fromMin: 9 * 60,
      untilMin: 15 * 60,
    })
    expect(w.length).toBe(2)
    expect(w[0].from.toISOString()).toBe(at('09:00', WEEKEND).toISOString())
    expect(w[1].until.toISOString()).toBe(at('15:00', WEEKEND_2).toISOString())
  })

  it('finds the gaps between holds, merging overlaps and clipping the edges', () => {
    const from = at('00:00')
    const until = at('00:00', NEXT_DAY)
    const out = gaps(
      [
        { heldFrom: at('09:00'), heldUntil: at('12:00') },
        { heldFrom: at('11:00'), heldUntil: at('15:00') },
        { heldFrom: at('19:00'), heldUntil: at('21:00') },
      ],
      from,
      until,
    )
    expect(out.map((g) => `${g.from.toISOString()}–${g.until.toISOString()}`)).toEqual([
      `${from.toISOString()}–${at('09:00').toISOString()}`,
      `${at('15:00').toISOString()}–${at('19:00').toISOString()}`,
      `${at('21:00').toISOString()}–${until.toISOString()}`,
    ])
  })

  it('returns the whole window when nothing is on, and nothing when it is full', () => {
    expect(gaps([], at('09:00'), at('17:00')).length).toBe(1)
    expect(gaps([{ heldFrom: at('08:00'), heldUntil: at('18:00') }], at('09:00'), at('17:00')).length).toBe(0)
  })
})

// ─────────────── what the first review round found ───────────────

describe('when two people press Save in the same second', () => {
  it('turns the index’s refusal into CourtTaken rather than a 500', async () => {
    await blockCourt({ courtId: 'c1', reason: 'Coaching', from: at('17:00'), until: at('21:00') })
    await makeTournament('t9', 'Optimist')

    // Straight past the pre-check, the way a racing transaction arrives: the
    // only thing standing in the way is the index.
    let caught: unknown = null
    try {
      await transact(async (tx) => {
        await setHolds(
          tx,
          { kind: 'tournament', tournamentId: 't9' },
          ['c1'],
          [{ from: at('18:00'), until: at('19:00') }],
          {},
          at('08:00'),
        )
      })
    } catch (e) {
      caught = e
    }
    expect(caught instanceof CourtTaken).toBe(true)
  })

  it('does not mistake somebody else’s constraint for a court clash', () => {
    expect(isCourtClash({ code: '23505', constraint_name: 'session_participants_seat_uq' })).toBe(false)
    expect(isCourtClash({ code: '23503', constraint_name: 'court_hold_slots_court_id_courts_id_fk' })).toBe(false)
    expect(isCourtClash({ code: '42P01', message: 'relation "court_hold_slots" does not exist' })).toBe(false)
    // postgres.js, PGlite, and either of them wrapped by drizzle.
    expect(isCourtClash({ code: '23505', constraint_name: 'court_hold_slots_court_id_slot_start_pk' })).toBe(true)
    expect(isCourtClash({ code: '23505', constraint: 'court_hold_slots_court_id_slot_start_pk' })).toBe(true)
    expect(
      isCourtClash({
        message: 'Failed query: insert into "court_holds" ...',
        cause: { code: '23505', constraint: 'court_hold_slots_court_id_slot_start_pk' },
      }),
    ).toBe(true)
  })
})

describe('the check and the write agree about what is being taken', () => {
  it('does not drag a game’s old start along when it is moved later', async () => {
    // The game is on Court 1 from seven, and somebody has the court at nine.
    const game = await makeGame('Evening', '19:00', '21:00', ['c1'])
    expect(game.ok).toBe(true)
    const id = game.ok ? game.session.id : ''
    await publishSession(id, actor)
    await blockCourt({ courtId: 'c1', reason: 'Coaching', from: at('21:00'), until: at('21:30') })

    // Moved to ten. The hold must move with it — not stretch from seven to
    // eleven, which would collide with the nine o'clock block and refuse a
    // move that nothing is in the way of.
    const moved = await rescheduleSession(
      id,
      {
        startsAt: at('22:00'),
        endsAt: at('23:00'),
        pricePaise: 30000,
        courtCount: 1,
        title: 'Evening',
        notes: null,
        confirmationGate: true,
      },
      actor,
      at('19:30'),
    )
    expect(moved.ok).toBe(true)
    const [hold] = await tdb.handle.select().from(courtHolds).where(eq(courtHolds.sessionId, id))
    expect(hold.heldFrom.toISOString()).toBe(at('22:00').toISOString())
    expect(hold.heldUntil.toISOString()).toBe(at('23:00').toISOString())
  })

  it('refuses hours that have entirely gone instead of holding nothing and saying yes', async () => {
    const late = await createSession(
      {
        title: 'Already over',
        startsAt: at('18:00'),
        endsAt: at('18:50'),
        pricePaise: 0,
        capacity: 4,
        courtCount: 1,
        courtIds: ['c1'],
      },
      actor,
      at('19:30'),
    )
    expect(late.ok).toBe(false)
    expect(late.ok === false && late.error).toContain('past')
  })
})

describe('a court is usable the second it is taken', () => {
  it('has no fifteen-minute dead zone at the start', async () => {
    const now = new Date()
    const today = venueDayKey(now)
    await makeTournament('t1', 'Right now', { start: today })
    expect((await assignCourts('t1', ['c1'], null)).ok).toBe(true)
    // Assigned this second, playable this second. Rounding the start UP to the
    // next quarter hour left the court owned by nobody for up to fifteen
    // minutes at exactly the moment play began.
    expect(await holdsCourtAt({ kind: 'tournament', tournamentId: 't1' }, 'c1', now)).toBe(true)
  })

  it('lets the next holder have the quarter hour the last one finished in', async () => {
    const today = venueDayKey(new Date())
    await makeTournament('t1', 'Morning', { start: today })
    await tdb.handle.insert(courtHolds).values({
      id: 'ch_morning',
      courtId: 'c1',
      kind: 'tournament',
      tournamentId: 't1',
      heldFrom: dayStart(today),
      heldUntil: dayEnd(today),
    })
    expect((await finishEvent('t1')).ok).toBe(true)

    await makeTournament('t2', 'Afternoon', { start: today })
    expect((await assignCourts('t2', ['c1'], null)).ok).toBe(true)
    expect(await holdsCourtAt({ kind: 'tournament', tournamentId: 't2' }, 'c1', new Date())).toBe(true)
  })
})

describe('the screens and the index mean the same thing by “free”', () => {
  it('does not offer a court whose quarter hour is already spoken for', async () => {
    // Out of action 19:00–19:05, so the 19:00 slot is gone and nothing can
    // start before 19:15.
    await blockCourt({ courtId: 'c1', reason: 'Net', from: at('19:00'), until: at('19:05') })

    const free = await freeCourtsBetween(at('19:10'), at('21:00'), 'venue-test')
    const one = free.find((c) => c.id === 'c1')!
    expect(one.takenBy).not.toBe(null)

    // ...and the day view agrees: the gap starts at 19:15, not 19:05.
    const day = await courtDay(DAY, 'venue-test')
    const gapsFor = day.find((d) => d.court.id === 'c1')!.free
    expect(gapsFor.some((g) => g.from.toISOString() === at('19:15').toISOString())).toBe(true)
  })
})

describe('a finished holder cannot be given courts by a save already in flight', () => {
  it('refuses to put courts back on a tournament that has finished', async () => {
    await makeTournament('t1', 'Morning')
    await assignCourts('t1', ['c1'], null)
    expect((await finishEvent('t1')).ok).toBe(true)
    const after = await assignCourts('t1', ['c2'], null)
    expect(after.ok).toBe(false)
    expect(after.ok === false && after.error).toContain('finished')
  })

  it('refuses to put courts back on a game that has ended', async () => {
    const game = await makeGame('Evening', '19:00', '21:00', ['c1'])
    expect(game.ok).toBe(true)
    const id = game.ok ? game.session.id : ''
    await publishSession(id, actor)
    await endSession(id, actor, at('20:00'))
    const after = await setSessionCourts(id, ['c2'], actor)
    expect(after.ok).toBe(false)
    expect((await tdb.handle.select().from(courtHolds).where(eq(courtHolds.courtId, 'c2'))).length).toBe(0)
  })

  it('keeps the court count honest when a game is called off', async () => {
    const game = await makeGame('Called off', '19:00', '21:00', ['c1', 'c2'])
    expect(game.ok && game.session.courtCount).toBe(2)
    const id = game.ok ? game.session.id : ''
    await publishSession(id, actor)
    await cancelSession(id, 'Rain', actor)
    const [row] = await tdb.handle.select().from(gameSessions).where(eq(gameSessions.id, id))
    expect(row.courtCount).toBe(0)
  })
})

describe('the hours a tournament asked for', () => {
  it('are remembered as asked, not read back off a hold that was clamped', async () => {
    const today = venueDayKey(new Date())
    await makeTournament('t1', 'Two days', { start: today, end: today })
    // Midnight to midnight, stated explicitly, so the window always contains
    // "now" whenever this test runs.
    expect((await assignCourts('t1', ['c1'], { fromMin: 0, untilMin: 24 * 60 })).ok).toBe(true)
    // The hold itself was clamped to now, because midnight has gone.
    const [hold] = await tdb.handle.select().from(courtHolds).where(eq(courtHolds.tournamentId, 't1'))
    expect(hold.heldFrom.getTime()).toBeGreaterThan(dayStart(today).getTime())
    // The hours are still the hours. Reading them back off the hold said the
    // tournament started at eleven, and then moved every other day to match.
    expect(await tournamentHours('t1')).toEqual({ fromMin: 0, untilMin: 24 * 60 })
  })
})
