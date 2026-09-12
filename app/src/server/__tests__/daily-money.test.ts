import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { eq, sql } from 'drizzle-orm'
import { db, transact } from '@/db'
import {
  chargeApplications,
  charges,
  collectionAttemptCharges,
  collectionAttempts,
  payments,
  sessionParticipants,
  webhookEvents,
} from '@/db/schema'
import { newId } from '@/lib/ids'
import { seedVenue, startTestDb, truncate, type TestDb } from '@/test/db'
import {
  balanceFor,
  collectAtDesk,
  constraintOf,
  correctCharge,
  dayTally,
  debtorsFor,
  effectivePrice,
  grantCredit,
  ledgerFor,
  moneyDrift,
  openAttempt,
  openChargesFor,
  provisionalFor,
  recordPayment,
  refundPayment,
  releaseAttempt,
  raiseSessionCharges,
  sessionMoney,
  settleAttempt,
  waiveCharge,
  writeOffCharge,
} from '../money'
import {
  createSession,
  endSession,
  joinSession,
  publishSession,
  roster,
  setParticipantPrice,
  setPresent,
} from '../sessions'
import { runTick } from '../daily-reconcile'

/**
 * The money, against a real Postgres.
 *
 * Half of this stage's guarantees are constraints rather than code, so half of
 * these tests do the forbidden thing on purpose and expect the database to be
 * the one that says no. A test that only calls the domain functions would pass
 * just as happily with every CHECK dropped, which is the failure this file
 * exists to catch.
 */

let tdb: TestDb
let actor: { id: string; username: string }
const VENUE = 'venue-test'
const ME = { userId: null, label: 'test' }

const STARTS = new Date('2026-09-15T13:30:00Z') // Tuesday 19:00 IST
const ENDS = new Date('2026-09-15T15:30:00Z') // 21:00 IST
const MADE = new Date('2026-09-10T00:00:00Z')
const BEFORE_GATE = new Date('2026-09-15T09:00:00Z')
const AFTER_LOCK = new Date('2026-09-15T16:20:00Z')

beforeAll(async () => {
  tdb = await startTestDb()
  actor = await seedVenue(tdb.handle)
})
afterAll(async () => {
  await tdb.client.close()
})
beforeEach(async () => {
  await truncate(tdb.handle)
})

async function makeGame(over: Partial<Parameters<typeof createSession>[0]> = {}) {
  const res = await createSession(
    { title: 'Tuesday social', startsAt: STARTS, endsAt: ENDS, pricePaise: 30000, capacity: 8, courtCount: 2, ...over },
    actor,
    MADE,
  )
  if (!res.ok) throw new Error(res.error)
  await publishSession(res.session.id, actor)
  return res.session
}

const join = (sessionId: string, name: string, phone: string, over: Record<string, unknown> = {}) =>
  joinSession(
    { sessionId, name, phone, source: 'self', deviceId: `dev-${name.toLowerCase().replace(/\W/g, '')}`, ...over },
    BEFORE_GATE,
  )

/** A whole night: everybody named turns up, plays, and the gate closes it. */
async function playNight(names: Array<[string, string]>, over: Partial<Parameters<typeof createSession>[0]> = {}) {
  const s = await makeGame(over)
  for (const [name, phone] of names) {
    const r = await join(s.id, name, phone)
    if (!r.ok) throw new Error(r.error)
  }
  for (const e of await roster(s.id)) await setPresent(e.id, true, ENDS)
  await endSession(s.id, actor, ENDS)
  await runTick(AFTER_LOCK)
  return s
}

/** Who owes what, by the name on the night — the shape most assertions want. */
async function owed(sessionId: string) {
  const money = await sessionMoney(sessionId)
  const out: Record<string, number> = {}
  for (const e of await roster(sessionId)) {
    const c = money.get(e.id)
    if (c) out[e.name] = c.duePaise
  }
  return out
}

async function thrownBy(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
  } catch (e) {
    return constraintOf(e)
  }
  return null
}

describe('the price one person pays', () => {
  it('is the game price when nobody has changed it', () => {
    expect(effectivePrice({ pricePaise: 30000 }, { priceOverridePaise: null, priceNote: null })).toEqual({
      paise: 30000,
      source: 'session',
      note: null,
    })
  })

  it('is the override when there is one, and remembers why', () => {
    expect(effectivePrice({ pricePaise: 30000 }, { priceOverridePaise: 0, priceNote: 'Coach' })).toEqual({
      paise: 0,
      source: 'override',
      note: 'Coach',
    })
  })

  it('shows the same number before the night as the charge written after it', async () => {
    const s = await makeGame({ pricePaise: 25000 })
    for (const [n, p] of [
      ['Ravi', '98400 11111'],
      ['Priya', '98400 11112'],
    ] as const) {
      const r = await join(s.id, n, p)
      if (!r.ok) throw new Error(r.error)
    }
    const list = await roster(s.id)
    for (const e of list) await setPresent(e.id, true, ENDS)

    const before = provisionalFor(
      { pricePaise: 25000 },
      (await roster(s.id)).map((e) => ({
        id: e.id,
        displayName: e.name,
        payerPlayerId: e.payerPlayerId,
        state: e.state,
        priceOverridePaise: e.priceOverridePaise,
        priceNote: e.priceNote,
      })),
    )
    expect(before.totalPaise).toBe(50000)

    await endSession(s.id, actor, ENDS)
    await runTick(AFTER_LOCK)
    const after = await sessionMoney(s.id)
    expect([...after.values()].reduce((n, c) => n + c.amountPaise, 0)).toBe(before.totalPaise)
  })
})

describe('the night closes and the money becomes a fact', () => {
  it('bills everybody who played', async () => {
    const s = await playNight([
      ['Ravi', '98400 11111'],
      ['Priya', '98400 11112'],
    ])
    expect(await owed(s.id)).toEqual({ Ravi: 30000, Priya: 30000 })
  })

  it('does not bill somebody who never turned up', async () => {
    const s = await makeGame()
    const a = await join(s.id, 'Ravi', '98400 11111')
    const b = await join(s.id, 'Priya', '98400 11112')
    if (!a.ok || !b.ok) throw new Error('join failed')
    const list = await roster(s.id)
    await setPresent(list[0].id, true, ENDS) // only one of them is ticked off
    await endSession(s.id, actor, ENDS)
    await runTick(AFTER_LOCK)

    const money = await sessionMoney(s.id)
    const after = await roster(s.id)
    expect(after.find((e) => e.name === 'Ravi')?.state).toBe('played')
    expect(after.find((e) => e.name === 'Priya')?.state).toBe('absent')
    expect(money.size).toBe(1)
    expect([...money.values()][0].payerPlayerId).toBe(after.find((e) => e.name === 'Ravi')?.playerId)
  })

  it('does not bill a night twice, even asked to twice inside one transaction', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    // A second tick would never reach a `locked` session, so asking it to would
    // prove nothing. This asks the charge-raiser itself, twice, the way a
    // retried transaction or a second worker would.
    const again = await transact(async (tx) =>
      raiseSessionCharges(tx, { ...s, venueId: VENUE }, AFTER_LOCK, { userId: null, label: 'the gate' }),
    )
    expect(again.raised).toBe(0)
    const all = await db.select({ id: charges.id }).from(charges).where(eq(charges.sessionId, s.id))
    expect(all.length).toBe(1)

    // And the gate running again changes nothing either.
    await runTick(new Date(AFTER_LOCK.getTime() + 10 * 60_000))
    expect((await db.select({ id: charges.id }).from(charges).where(eq(charges.sessionId, s.id))).length).toBe(1)
  })

  it('sends a guest’s charge to the person who brought them', async () => {
    const s = await makeGame()
    const host = await join(s.id, 'Ravi', '98400 11111')
    if (!host.ok) throw new Error(host.error)
    const hostPlayerId = (host as { playerId: string }).playerId
    const guest = await joinSession(
      { sessionId: s.id, name: 'Mani', source: 'host', guestOfPlayerId: hostPlayerId },
      BEFORE_GATE,
    )
    if (!guest.ok) throw new Error(guest.error)

    for (const e of await roster(s.id)) await setPresent(e.id, true, ENDS)
    await endSession(s.id, actor, ENDS)
    await runTick(AFTER_LOCK)

    const list = await roster(s.id)
    const money = await sessionMoney(s.id)
    const guestRow = list.find((e) => e.name === 'Mani')!
    expect(money.get(guestRow.id)?.payerPlayerId).toBe(hostPlayerId)
    // And the inviter owes for both spots, while the guest owes nothing.
    const bill = await balanceFor(hostPlayerId, VENUE)
    expect(bill.owedPaise).toBe(60000)
    expect((await balanceFor(guestRow.playerId, VENUE)).owedPaise).toBe(0)
  })

  it('still writes a charge for somebody who played free, so the night can say so', async () => {
    const s = await makeGame()
    const r = await join(s.id, 'Coach', '98400 11113')
    if (!r.ok) throw new Error(r.error)
    const [entry] = await roster(s.id)
    await db
      .update(sessionParticipants)
      .set({ priceOverridePaise: 0, priceNote: 'Coach' })
      .where(eq(sessionParticipants.id, entry.id))
    await setPresent(entry.id, true, ENDS)
    await endSession(s.id, actor, ENDS)
    await runTick(AFTER_LOCK)

    const money = await sessionMoney(s.id)
    const c = money.get(entry.id)!
    expect(c.amountPaise).toBe(0)
    expect(c.priceSource).toBe('override')
    expect(c.priceNote).toBe('Coach')
    // Nothing is owed, and there is still a row that says they were there.
    expect(await balanceFor(entry.playerId, VENUE)).toMatchObject({ owedPaise: 0, openCharges: 0 })
  })

  it('charges nobody at all when the host ticked nobody off', async () => {
    const s = await makeGame()
    const r = await join(s.id, 'Ravi', '98400 11111')
    if (!r.ok) throw new Error(r.error)
    await endSession(s.id, actor, ENDS)
    await runTick(AFTER_LOCK)
    expect((await db.select({ id: charges.id }).from(charges)).length).toBe(0)
  })
})

describe('what the database refuses, whatever the code does', () => {
  async function oneCharge() {
    const s = await playNight([['Ravi', '98400 11111']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    return c
  }

  it('cannot over-settle a charge', async () => {
    const c = await oneCharge()
    const pay = await recordPayment({
      playerId: c.playerId,
      venueId: VENUE,
      amountPaise: 50000,
      method: 'cash',
      initiator: 'host',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)
    // ₹300 has settled it; forcing another ₹200 on is the thing that must fail.
    const named = await thrownBy(async () => {
      await transact(async (tx) => {
        await tx
          .insert(chargeApplications)
          .values({ id: newId('app'), chargeId: c.id, paymentId: pay.paymentId, amountPaise: 20000, actorLabel: 'x' })
        await tx
          .update(charges)
          .set({ appliedPaise: sql`${charges.appliedPaise} + 20000` })
          .where(eq(charges.id, c.id))
      })
    })
    expect(named).toBe('charges_applied_within')
  })

  it('cannot spend one payment twice', async () => {
    const c = await oneCharge()
    const pay = await recordPayment({
      playerId: c.playerId,
      venueId: VENUE,
      amountPaise: 30000,
      method: 'cash',
      initiator: 'host',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)
    const named = await thrownBy(() =>
      db
        .update(payments)
        .set({ allocatedPaise: sql`${payments.allocatedPaise} + 1` })
        .where(eq(payments.id, pay.paymentId)),
    )
    expect(named).toBe('payments_spent_within')
  })

  it('cannot let two collections hold the same charge', async () => {
    const c = await oneCharge()
    const first = await openAttempt({
      playerId: c.playerId,
      venueId: VENUE,
      kind: 'desk',
      chargeIds: [c.id],
      actor: ME,
    })
    if (!first.ok) throw new Error(first.error)

    const second = await openAttempt({
      playerId: c.playerId,
      venueId: VENUE,
      kind: 'link',
      chargeIds: [c.id],
      actor: ME,
    })
    expect(second.ok).toBe(false)
    expect(!second.ok && second.error).toMatch(/collecting that right now/i)

    // And the index itself, not just the function that respects it.
    const other = newId('att')
    await db.insert(collectionAttempts).values({
      id: other,
      venueId: VENUE,
      playerId: c.playerId,
      kind: 'desk',
      amountPaise: 30000,
    })
    const named = await thrownBy(() =>
      db
        .insert(collectionAttemptCharges)
        .values({ id: newId('res'), attemptId: other, chargeId: c.id, amountPaise: 30000 }),
    )
    expect(named).toBe('one_live_reservation_per_charge')
  })

  it('cannot bill one night twice', async () => {
    const c = await oneCharge()
    const named = await thrownBy(() =>
      db.insert(charges).values({
        id: newId('chg'),
        venueId: VENUE,
        playerId: c.playerId,
        sessionId: c.sessionId,
        participationId: c.participationId,
        origin: 'participation',
        amountPaise: 30000,
        reason: 'again',
        unitPricePaise: 30000,
      }),
    )
    expect(named).toBe('charges_participation_uq')
  })

  it('cannot process one webhook twice', async () => {
    await db
      .insert(webhookEvents)
      .values({ id: newId('wh'), provider: 'cashfree', providerEventId: 'evt_1', payload: '{}' })
    const named = await thrownBy(() =>
      db
        .insert(webhookEvents)
        .values({ id: newId('wh'), provider: 'cashfree', providerEventId: 'evt_1', payload: '{}' }),
    )
    expect(named).toBe('webhook_events_provider_uq')
  })

  it('cannot bill the same no-show fee twice either', async () => {
    const c = await oneCharge()
    const policy = {
      venueId: VENUE,
      playerId: c.playerId,
      sessionId: c.sessionId,
      participationId: c.participationId,
      origin: 'policy' as const,
      policyKind: 'no_show',
      amountPaise: 15000,
      reason: 'no show',
      unitPricePaise: 15000,
    }
    await db.insert(charges).values({ id: newId('chg'), ...policy })
    expect(await thrownBy(() => db.insert(charges).values({ id: newId('chg'), ...policy }))).toBe('charges_policy_uq')
  })

  it('cannot walk a payment backwards, whatever order the messages arrive in', async () => {
    const c = await oneCharge()
    const pay = await recordPayment({
      playerId: c.playerId,
      venueId: VENUE,
      amountPaise: 30000,
      method: 'cash',
      initiator: 'host',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)

    // The money landed. A late "it failed" message must not take it back.
    let message = ''
    try {
      await db.update(payments).set({ state: 'failed' }).where(eq(payments.id, pay.paymentId))
    } catch (e) {
      message = String((e as { message?: string }).message ?? e)
      const cause = (e as { cause?: { message?: string } }).cause
      if (cause?.message) message += ` ${cause.message}`
    }
    expect(message).toMatch(/does not go from/i)

    // Reversing it is the one move a settled payment has.
    await db.update(payments).set({ state: 'reversed' }).where(eq(payments.id, pay.paymentId))
    const [after] = await db.select({ state: payments.state }).from(payments).where(eq(payments.id, pay.paymentId))
    expect(after.state).toBe('reversed')
  })

  it('cannot delete a money row at all', async () => {
    const c = await oneCharge()
    let message = ''
    try {
      await db.delete(charges).where(eq(charges.id, c.id))
    } catch (e) {
      message = String((e as { message?: string }).message ?? e)
      // A nested driver error keeps the real sentence in `cause`.
      const cause = (e as { cause?: { message?: string } }).cause
      if (cause?.message) message += ` ${cause.message}`
    }
    expect(message).toMatch(/never deleted/i)
    expect((await db.select({ id: charges.id }).from(charges).where(eq(charges.id, c.id))).length).toBe(1)
  })
})

describe('money arriving', () => {
  it('settles the oldest charge first and leaves the rest showing', async () => {
    const first = await playNight([['Ravi', '98400 11111']], { pricePaise: 30000 })
    const list = await roster(first.id)
    const playerId = list[0].playerId

    // A second night for the same person, a week later.
    const second = await createSession(
      {
        title: 'Next Tuesday',
        startsAt: new Date('2026-09-22T13:30:00Z'),
        endsAt: new Date('2026-09-22T15:30:00Z'),
        pricePaise: 40000,
        capacity: 4,
        courtCount: 1,
      },
      actor,
      MADE,
    )
    if (!second.ok) throw new Error(second.error)
    await publishSession(second.session.id, actor)
    const r = await joinSession(
      { sessionId: second.session.id, name: 'Ravi', phone: '98400 11111', source: 'self' },
      new Date('2026-09-22T09:00:00Z'),
    )
    if (!r.ok) throw new Error(r.error)
    for (const e of await roster(second.session.id)) await setPresent(e.id, true, new Date('2026-09-22T15:30:00Z'))
    await endSession(second.session.id, actor, new Date('2026-09-22T15:30:00Z'))
    await runTick(new Date('2026-09-22T16:20:00Z'))

    expect((await balanceFor(playerId, VENUE)).owedPaise).toBe(70000)

    const pay = await recordPayment({
      playerId,
      venueId: VENUE,
      amountPaise: 35000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)
    expect(pay.allocatedPaise).toBe(35000)

    const open = await openChargesFor(playerId, VENUE)
    // The first night is settled outright; the second is part paid.
    expect(open.length).toBe(1)
    expect(open[0].duePaise).toBe(35000)
    expect((await balanceFor(playerId, VENUE)).owedPaise).toBe(35000)
  })

  it('keeps money nobody owes yet, rather than absorbing it', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const playerId = (await roster(s.id))[0].playerId
    const pay = await recordPayment({
      playerId,
      venueId: VENUE,
      amountPaise: 50000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)
    expect(pay.allocatedPaise).toBe(30000)
    expect(pay.leftOverPaise).toBe(20000)

    const bill = await balanceFor(playerId, VENUE)
    expect(bill.owedPaise).toBe(0)
    expect(bill.onAccountPaise).toBe(20000)
    // They are ₹200 up, and the app says so rather than hiding it.
    expect(bill.balancePaise).toBe(-20000)
  })

  it('does not touch a charge somebody else is collecting', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const playerId = (await roster(s.id))[0].playerId
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))

    const held = await openAttempt({ playerId, venueId: VENUE, kind: 'link', chargeIds: [c.id], actor: ME })
    if (!held.ok) throw new Error(held.error)

    const pay = await recordPayment({
      playerId,
      venueId: VENUE,
      amountPaise: 30000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)
    // The money is real and on account; it just cannot land on a reserved charge.
    expect(pay.allocatedPaise).toBe(0)
    expect((await balanceFor(playerId, VENUE)).onAccountPaise).toBe(30000)

    // Letting go is the moment the money that was waiting finds the charge.
    await releaseAttempt({ attemptId: held.attemptId, reason: 'link expired' })
    const settled = await balanceFor(playerId, VENUE)
    expect(settled.owedPaise).toBe(0)
    expect(settled.onAccountPaise).toBe(0)
    expect(await moneyDrift(VENUE)).toEqual([])
  })
})

describe('taking it at the desk', () => {
  it('collects, settles and lets go in one move', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const playerId = (await roster(s.id))[0].playerId
    const open = await openChargesFor(playerId, VENUE)

    const done = await collectAtDesk({
      playerId,
      venueId: VENUE,
      chargeIds: open.map((c) => c.id),
      method: 'cash',
      actor: ME,
    })
    if (!done.ok) throw new Error(done.error)
    expect(done.allocatedPaise).toBe(30000)
    expect((await balanceFor(playerId, VENUE)).owedPaise).toBe(0)

    // Nothing is left holding it, so the charge is free for anything later.
    const live = await db
      .select({ id: collectionAttemptCharges.id })
      .from(collectionAttemptCharges)
      .where(sql`${collectionAttemptCharges.releasedAt} is null`)
    expect(live.length).toBe(0)
    expect(await moneyDrift(VENUE)).toEqual([])
  })

  it('takes less than it reserved, and never more', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const playerId = (await roster(s.id))[0].playerId
    const open = await openChargesFor(playerId, VENUE)

    const held = await openAttempt({
      playerId,
      venueId: VENUE,
      kind: 'desk',
      chargeIds: open.map((c) => c.id),
      actor: ME,
    })
    if (!held.ok) throw new Error(held.error)

    const tooMuch = await settleAttempt({ attemptId: held.attemptId, method: 'cash', amountPaise: 40000, actor: ME })
    expect(tooMuch.ok).toBe(false)

    const part = await settleAttempt({ attemptId: held.attemptId, method: 'cash', amountPaise: 10000, actor: ME })
    if (!part.ok) throw new Error(part.error)
    expect((await balanceFor(playerId, VENUE)).owedPaise).toBe(20000)
  })

  it('gives the charges back when the collection fails', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const playerId = (await roster(s.id))[0].playerId
    const open = await openChargesFor(playerId, VENUE)
    const held = await openAttempt({
      playerId,
      venueId: VENUE,
      kind: 'link',
      chargeIds: open.map((c) => c.id),
      actor: ME,
    })
    if (!held.ok) throw new Error(held.error)

    const out = await releaseAttempt({ attemptId: held.attemptId, reason: 'they never paid', cooldownMinutes: 30 })
    if (!out.ok) throw new Error(out.error)
    expect(out.released).toBe(1)
    expect((await openChargesFor(playerId, VENUE))[0].heldByAttemptId).toBeNull()
  })

  it('keeps holding when nobody knows what happened', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const playerId = (await roster(s.id))[0].playerId
    const open = await openChargesFor(playerId, VENUE)
    const held = await openAttempt({
      playerId,
      venueId: VENUE,
      kind: 'mandate',
      chargeIds: open.map((c) => c.id),
      actor: ME,
    })
    if (!held.ok) throw new Error(held.error)

    await releaseAttempt({ attemptId: held.attemptId, reason: 'no answer from the bank', state: 'unknown' })
    // Frozen, deliberately: nothing else may collect it until a human finds out.
    expect((await openChargesFor(playerId, VENUE))[0].heldByAttemptId).toBe(held.attemptId)
  })
})

describe('what a collection will not do', () => {
  it('refuses to settle a gateway payment from the desk', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    const held = await openAttempt({
      playerId: c.playerId,
      venueId: VENUE,
      kind: 'link',
      chargeIds: [c.id],
      actor: ME,
    })
    if (!held.ok) throw new Error(held.error)

    // A gateway payment is not money until the gateway says so. Settling it
    // here would release every reservation while applying nothing.
    const out = await settleAttempt({ attemptId: held.attemptId, method: 'gateway', actor: ME })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.error).toMatch(/gateway confirms/i)

    // And the hold is still on, which is the point of refusing.
    expect((await openChargesFor(c.playerId, VENUE))[0].heldByAttemptId).toBe(held.attemptId)
  })

  it('will not re-try a link straight after one failed, but a host at the desk always may', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    const first = await openAttempt({
      playerId: c.playerId,
      venueId: VENUE,
      kind: 'link',
      chargeIds: [c.id],
      actor: ME,
    })
    if (!first.ok) throw new Error(first.error)
    await releaseAttempt({ attemptId: first.attemptId, reason: 'card declined', cooldownMinutes: 30 })

    const again = await openAttempt({
      playerId: c.playerId,
      venueId: VENUE,
      kind: 'link',
      chargeIds: [c.id],
      actor: ME,
    })
    expect(again.ok).toBe(false)
    expect(!again.ok && again.error).toMatch(/few minutes/i)

    // The cooldown is about not repeating a failing route on a timer. Somebody
    // standing in front of the player with cash is not that.
    const desk = await openAttempt({
      playerId: c.playerId,
      venueId: VENUE,
      kind: 'desk',
      chargeIds: [c.id],
      actor: ME,
    })
    expect(desk.ok).toBe(true)
  })
})

describe('the over-billed player, who has already paid', () => {
  it('takes the payment back off, posts the correction, and keeps her money on account', async () => {
    const s = await playNight([['Priya', '98400 11112']])
    const playerId = (await roster(s.id))[0].playerId
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))

    const pay = await recordPayment({
      playerId,
      venueId: VENUE,
      amountPaise: 30000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)
    expect((await balanceFor(playerId, VENUE)).owedPaise).toBe(0)

    const fixed = await correctCharge({
      chargeId: c.id,
      deltaPaise: -30000,
      reason: 'attendance corrected',
      actor: ME,
    })
    if (!fixed.ok) throw new Error(fixed.error)
    expect(fixed.freedPaise).toBe(30000)

    const [after] = await db.select().from(charges).where(eq(charges.id, c.id))
    // The charge itself never moved. Only the signed rows around it did.
    expect(after.amountPaise).toBe(30000)
    expect(after.adjustPaise).toBe(-30000)
    expect(after.appliedPaise).toBe(0)

    const bill = await balanceFor(playerId, VENUE)
    expect(bill.owedPaise).toBe(0)
    expect(bill.onAccountPaise).toBe(30000)

    // And the ledger reads as what happened, in order.
    const lines = await ledgerFor(playerId, VENUE)
    expect(lines.map((l) => l.kind)).toContain('adjustment')
    expect(lines.map((l) => l.kind)).toContain('payment')
    expect(await moneyDrift(VENUE)).toEqual([])
  })

  it('sends her money back when it was the venue’s mistake', async () => {
    const s = await playNight([['Priya', '98400 11112']])
    const playerId = (await roster(s.id))[0].playerId
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    const pay = await recordPayment({
      playerId,
      venueId: VENUE,
      amountPaise: 30000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)
    await correctCharge({ chargeId: c.id, deltaPaise: -30000, reason: 'we billed her wrongly', actor: ME })

    const back = await refundPayment({
      paymentId: pay.paymentId,
      amountPaise: 30000,
      reason: 'our mistake',
      actor: ME,
    })
    if (!back.ok) throw new Error(back.error)
    expect(await balanceFor(playerId, VENUE)).toMatchObject({ owedPaise: 0, onAccountPaise: 0, balancePaise: 0 })
    expect(await moneyDrift(VENUE)).toEqual([])
  })

  it('refuses to send back money that is paying for something', async () => {
    const s = await playNight([['Priya', '98400 11112']])
    const playerId = (await roster(s.id))[0].playerId
    const pay = await recordPayment({
      playerId,
      venueId: VENUE,
      amountPaise: 30000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)
    const back = await refundPayment({ paymentId: pay.paymentId, amountPaise: 30000, reason: 'oops', actor: ME })
    expect(back.ok).toBe(false)
    expect(!back.ok && back.error).toMatch(/more than is left/i)
  })

  it('will not let a correction take off more than the charge', async () => {
    const s = await playNight([['Priya', '98400 11112']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    const out = await correctCharge({ chargeId: c.id, deltaPaise: -40000, reason: 'too far', actor: ME })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.error).toMatch(/more than the charge/i)
  })
})

describe('waiving, writing off, and giving credit', () => {
  it('waives a charge nobody has paid anything towards', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    const out = await waiveCharge({ chargeId: c.id, reason: 'first night, on us', actor: ME })
    if (!out.ok) throw new Error(out.error)
    expect((await balanceFor(c.playerId, VENUE)).owedPaise).toBe(0)
    const [after] = await db.select().from(charges).where(eq(charges.id, c.id))
    expect(after.state).toBe('waived')
    expect(after.stateReason).toBe('first night, on us')
    // The amount is untouched — it is still what we said he owed on the night.
    expect(after.amountPaise).toBe(30000)
  })

  it('refuses to waive one that money has already gone onto', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    await recordPayment({
      playerId: c.playerId,
      venueId: VENUE,
      amountPaise: 10000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    const out = await waiveCharge({ chargeId: c.id, reason: 'never mind', actor: ME })
    expect(out.ok).toBe(false)
    expect(!out.ok && out.error).toMatch(/Correct the amount/i)
  })

  it('will not waive something somebody is collecting', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    await openAttempt({ playerId: c.playerId, venueId: VENUE, kind: 'desk', chargeIds: [c.id], actor: ME })
    const out = await waiveCharge({ chargeId: c.id, reason: 'never mind', actor: ME })
    expect(out.ok).toBe(false)
  })

  it('writes a debt off as a decision, never as a deletion', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    const out = await writeOffCharge({ chargeId: c.id, reason: 'gone quiet for a year', actor: ME })
    if (!out.ok) throw new Error(out.error)
    const [after] = await db.select().from(charges).where(eq(charges.id, c.id))
    expect(after.state).toBe('written_off')
    expect(after.amountPaise).toBe(30000)
    expect((await balanceFor(c.playerId, VENUE)).owedPaise).toBe(0)
  })

  it('settles a charge with a credit, which never appears in the takings', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    const out = await grantCredit({
      playerId: c.playerId,
      venueId: VENUE,
      amountPaise: 30000,
      reason: 'rained off',
      actor: ME,
      // Pinned, like the payments in the tally test below: a credit written at
      // the wall clock lands outside the day being asked about, and the test
      // would only pass on one date of the year.
      now: ENDS,
    })
    if (!out.ok) throw new Error(out.error)
    expect(out.usedPaise).toBe(30000)
    expect((await balanceFor(c.playerId, VENUE)).owedPaise).toBe(0)

    const day = await dayTally(VENUE, new Date('2026-09-15T00:00:00Z'), new Date('2026-09-16T00:00:00Z'))
    expect(day.takenPaise).toBe(0)
    expect(day.creditedPaise).toBe(30000)
    expect(await moneyDrift(VENUE)).toEqual([])
  })
})

describe('the day-end tally', () => {
  it('keeps cash and the rest apart, so each can match its own record', async () => {
    const s = await playNight([
      ['Ravi', '98400 11111'],
      ['Priya', '98400 11112'],
    ])
    const list = await roster(s.id)
    await recordPayment({
      playerId: list[0].playerId,
      venueId: VENUE,
      amountPaise: 30000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
      receivedAt: ENDS,
    })
    await recordPayment({
      playerId: list[1].playerId,
      venueId: VENUE,
      amountPaise: 20000,
      method: 'venue_qr',
      initiator: 'player',
      actor: ME,
      receivedAt: ENDS,
    })

    const day = await dayTally(VENUE, new Date('2026-09-15T00:00:00Z'), new Date('2026-09-16T00:00:00Z'))
    expect(day.byMethod).toEqual([
      { method: 'cash', paise: 30000, count: 1 },
      { method: 'venue_qr', paise: 20000, count: 1 },
    ])
    expect(day.takenPaise).toBe(50000)
    expect(day.chargedPaise).toBe(60000)
    expect(day.owedPaise).toBe(10000)
  })

  it('names everybody who owes, whenever they played', async () => {
    const s = await playNight([
      ['Ravi', '98400 11111'],
      ['Priya', '98400 11112'],
    ])
    const list = await roster(s.id)
    await recordPayment({
      playerId: list[0].playerId,
      venueId: VENUE,
      amountPaise: 30000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    const owing = await debtorsFor(VENUE)
    expect(owing.map((d) => d.name)).toEqual(['Priya'])
    expect(owing[0].balancePaise).toBe(30000)
  })
})

describe('money that arrived before the charge did', () => {
  it('lands on the next night rather than being asked for twice', async () => {
    const first = await playNight([['Ravi', '98400 11111']], { pricePaise: 30000 })
    const playerId = (await roster(first.id))[0].playerId

    // He hands over ₹500 for a ₹300 night.
    const pay = await recordPayment({
      playerId,
      venueId: VENUE,
      amountPaise: 50000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    if (!pay.ok) throw new Error(pay.error)
    expect((await balanceFor(playerId, VENUE)).onAccountPaise).toBe(20000)

    const second = await createSession(
      {
        title: 'Next Tuesday',
        startsAt: new Date('2026-09-22T13:30:00Z'),
        endsAt: new Date('2026-09-22T15:30:00Z'),
        pricePaise: 30000,
        capacity: 4,
        courtCount: 1,
      },
      actor,
      MADE,
    )
    if (!second.ok) throw new Error(second.error)
    await publishSession(second.session.id, actor)
    const r = await joinSession(
      { sessionId: second.session.id, name: 'Ravi', phone: '98400 11111', source: 'self' },
      new Date('2026-09-22T09:00:00Z'),
    )
    if (!r.ok) throw new Error(r.error)
    for (const e of await roster(second.session.id)) await setPresent(e.id, true, new Date('2026-09-22T15:30:00Z'))
    await endSession(second.session.id, actor, new Date('2026-09-22T15:30:00Z'))
    await runTick(new Date('2026-09-22T16:20:00Z'))

    // The ₹200 the venue was holding covers part of the new ₹300 on its own.
    const bill = await balanceFor(playerId, VENUE)
    expect(bill.onAccountPaise).toBe(0)
    expect(bill.owedPaise).toBe(10000)
    expect(bill.balancePaise).toBe(10000)
    expect(await moneyDrift(VENUE)).toEqual([])
  })
})

describe('correcting a charge that two payments settled', () => {
  it('gives back whole payment lines until it fits, and re-spends what it can', async () => {
    const s = await playNight([['Priya', '98400 11112']], { pricePaise: 30000 })
    const playerId = (await roster(s.id))[0].playerId
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))

    for (const amount of [15000, 15000]) {
      const pay = await recordPayment({
        playerId,
        venueId: VENUE,
        amountPaise: amount,
        method: 'cash',
        initiator: 'player',
        actor: ME,
      })
      if (!pay.ok) throw new Error(pay.error)
    }
    expect((await balanceFor(playerId, VENUE)).owedPaise).toBe(0)

    // She should have been billed ₹100, not ₹300.
    const fixed = await correctCharge({ chargeId: c.id, deltaPaise: -20000, reason: 'she left at half time', actor: ME })
    if (!fixed.ok) throw new Error(fixed.error)

    const [after] = await db.select().from(charges).where(eq(charges.id, c.id))
    expect(after.amountPaise).toBe(30000)
    expect(after.adjustPaise).toBe(-20000)
    expect(after.appliedPaise).toBe(10000)

    const bill = await balanceFor(playerId, VENUE)
    expect(bill.owedPaise).toBe(0)
    expect(bill.onAccountPaise).toBe(20000)
    expect(await moneyDrift(VENUE)).toEqual([])
  })

  it('refuses a correction when somebody has corrected it since', async () => {
    const s = await playNight([['Priya', '98400 11112']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    await correctCharge({ chargeId: c.id, deltaPaise: -10000, reason: 'first', actor: ME })
    const stale = await correctCharge({
      chargeId: c.id,
      deltaPaise: -10000,
      reason: 'second, from a screen that had not caught up',
      expectedNetPaise: 30000,
      actor: ME,
    })
    expect(stale.ok).toBe(false)
    expect(!stale.ok && stale.error).toMatch(/a moment ago/i)
  })

  it('will not correct a charge somebody is collecting', async () => {
    const s = await playNight([['Priya', '98400 11112']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    await openAttempt({ playerId: c.playerId, venueId: VENUE, kind: 'desk', chargeIds: [c.id], actor: ME })
    const out = await correctCharge({ chargeId: c.id, deltaPaise: -10000, reason: 'no', actor: ME })
    expect(out.ok).toBe(false)
  })
})

describe('what the drift check is for', () => {
  it('notices when a counter stops matching its rows', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const [c] = await db.select().from(charges).where(eq(charges.sessionId, s.id))
    expect(await moneyDrift(VENUE)).toEqual([])

    // Exactly the bug the counters are exposed to: a number moved without the
    // row that justifies it. `charges_applied_within` still passes, which is
    // why the constraint alone is not enough and this check exists.
    await db
      .update(charges)
      .set({ appliedPaise: 10000 })
      .where(eq(charges.id, c.id))

    const drift = await moneyDrift(VENUE)
    expect(drift.length).toBe(1)
    expect(drift[0]).toMatchObject({ table: 'charge', id: c.id, stored: 10000, fromRows: 0 })
  })
})

describe('pricing one person differently', () => {
  it('takes an amount and a note together, and bills the amount', async () => {
    const s = await makeGame()
    const r = await join(s.id, 'Coach', '98400 11113')
    if (!r.ok) throw new Error(r.error)
    const [entry] = await roster(s.id)

    const set = await setParticipantPrice(entry.id, 0, 'Coach', actor)
    if (!set.ok) throw new Error(set.error)

    await setPresent(entry.id, true, ENDS)
    await endSession(s.id, actor, ENDS)
    await runTick(AFTER_LOCK)

    const c = (await sessionMoney(s.id)).get(entry.id)!
    expect(c.amountPaise).toBe(0)
    expect(c.priceNote).toBe('Coach')
  })

  it('refuses an amount with no reason beside it', async () => {
    const s = await makeGame()
    const r = await join(s.id, 'Ravi', '98400 11111')
    if (!r.ok) throw new Error(r.error)
    const [entry] = await roster(s.id)
    const out = await setParticipantPrice(entry.id, 15000, '', actor)
    expect(out.ok).toBe(false)
  })

  it('refuses once the night is closed, and says what to do instead', async () => {
    const s = await playNight([['Ravi', '98400 11111']])
    const [entry] = await roster(s.id)
    const out = await setParticipantPrice(entry.id, 0, 'Coach', actor)
    expect(out.ok).toBe(false)
    expect(!out.ok && out.error).toMatch(/Correct the charge/i)
  })
})

describe('the counters and the rows agree', () => {
  it('after everything this file can do to them', async () => {
    const s = await playNight([
      ['Ravi', '98400 11111'],
      ['Priya', '98400 11112'],
    ])
    const list = await roster(s.id)
    const [ravi, priya] = list

    await recordPayment({
      playerId: ravi.playerId,
      venueId: VENUE,
      amountPaise: 45000,
      method: 'cash',
      initiator: 'player',
      actor: ME,
    })
    const [c] = await db.select().from(charges).where(eq(charges.playerId, priya.playerId))
    await collectAtDesk({
      playerId: priya.playerId,
      venueId: VENUE,
      chargeIds: [c.id],
      method: 'venue_qr',
      amountPaise: 10000,
      actor: ME,
    })
    await correctCharge({ chargeId: c.id, deltaPaise: -5000, reason: 'half an hour late', actor: ME })
    await grantCredit({
      playerId: priya.playerId,
      venueId: VENUE,
      amountPaise: 5000,
      reason: 'goodwill',
      actor: ME,
    })
    const [pay] = await db.select().from(payments).where(eq(payments.playerId, ravi.playerId))
    await refundPayment({ paymentId: pay.id, amountPaise: 15000, reason: 'overpaid', actor: ME })

    expect(await moneyDrift(VENUE)).toEqual([])
  })
})
