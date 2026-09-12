import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { gameSessions, sessionParticipants, sessionScheduledActions } from '@/db/schema'
import { boundariesFor } from '@/lib/daily-clock'
import { seedVenue, startTestDb, truncate, type TestDb } from '@/test/db'
import {
  cancelSession,
  confirmSpot,
  countRoster,
  createSession,
  endSession,
  joinSession,
  leaveSession,
  publishSession,
  resolveSpot,
  roster,
  rotateSpotToken,
  seatFromWaitlist,
  setCapacity,
  setPayer,
  setPresent,
} from '../sessions'
import { runTick } from '../daily-reconcile'
import { publicSession } from '../daily-public'

/**
 * The daily-games domain, against a real Postgres.
 *
 * The rules this feature rests on are database rules — a partial unique index
 * on the seat, another on one live participation per person — so testing them
 * against a fake would test the code and not the rule.
 */

let tdb: TestDb
let actor: { id: string; username: string }

// A Tuesday, 7–9pm at the venue (+05:30).
const STARTS = new Date('2026-09-15T13:30:00Z')
const ENDS = new Date('2026-09-15T15:30:00Z')
const MADE = new Date('2026-09-10T00:00:00Z')
const BOUNDS = boundariesFor(STARTS, ENDS, undefined, MADE)
const BEFORE_GATE = new Date('2026-09-15T09:00:00Z')

beforeAll(async () => {
  tdb = await startTestDb()
  // The venue and the organiser outlive every test: `truncate` does not clear
  // them, so re-inserting each time is a duplicate key, not a fresh fixture.
  actor = await seedVenue(tdb.handle)
})

afterAll(async () => {
  await tdb.client.close()
})

beforeEach(async () => {
  await truncate(tdb.handle)
})

async function makeGame(over: Partial<Parameters<typeof createSession>[0]> = {}, publish = true) {
  const res = await createSession(
    {
      title: 'Tuesday social',
      startsAt: STARTS,
      endsAt: ENDS,
      pricePaise: 30000,
      capacity: 2,
      courtCount: 2,
      ...over,
    },
    actor,
    MADE,
  )
  if (!res.ok) throw new Error(res.error)
  if (publish) await publishSession(res.session.id, actor)
  return res.session
}

const join = (sessionId: string, name: string, phone: string, over: Record<string, unknown> = {}) =>
  joinSession(
    { sessionId, name, phone, source: 'self', deviceId: `dev-${name.toLowerCase().replace(/\W/g, '')}`, ...over },
    BEFORE_GATE,
  )

describe('creating a game', () => {
  it('stores money as integer paise and pins the currency', async () => {
    const s = await makeGame({ pricePaise: 30050 })
    expect(s.pricePaise).toBe(30050)
    expect(s.currency).toBe('INR')
  })

  it('resolves the gate boundaries onto the row, so the schedule is explainable later', async () => {
    const s = await makeGame()
    expect(s.confirmOpensAt?.toISOString()).toBe(BOUNDS.confirmOpensAt.toISOString())
    expect(s.confirmDeadlineAt?.toISOString()).toBe(BOUNDS.confirmDeadlineAt.toISOString())
    expect(s.autoEndAt?.toISOString()).toBe(BOUNDS.autoEndAt.toISOString())
  })

  it('refuses a game that finishes before it starts, and one priced in nonsense', async () => {
    const back = await createSession(
      { title: 'Backwards', startsAt: ENDS, endsAt: STARTS, pricePaise: 0, capacity: 4, courtCount: 1 },
      actor,
      MADE,
    )
    expect(back.ok).toBe(false)
    const negative = await createSession(
      { title: 'Negative', startsAt: STARTS, endsAt: ENDS, pricePaise: -1, capacity: 4, courtCount: 1 },
      actor,
      MADE,
    )
    expect(negative.ok).toBe(false)
  })

  it('is not public until it is published', async () => {
    const s = await makeGame({}, false)
    expect(await publicSession(s.slug)).toBe(null)
    await publishSession(s.id, actor)
    expect(await publicSession(s.slug)).not.toBe(null)
  })
})

describe('joining', () => {
  it('hands out seats one at a time', async () => {
    const s = await makeGame()
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const b = await join(s.id, 'Priya Sharma', '9840012346')
    expect(a.ok && a.seatNo).toBe(1)
    expect(b.ok && b.seatNo).toBe(2)
  })

  it('puts the next person on the waitlist rather than over-filling', async () => {
    const s = await makeGame()
    await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')
    const third = await join(s.id, 'Suresh Babu', '9840012347')
    expect(third.ok && third.waiting).toBe(true)
    expect(third.ok && third.seatNo).toBe(null)
  })

  it('will not let one person hold two spots in one game', async () => {
    const s = await makeGame()
    await join(s.id, 'Ravi Kumar', '9840012345')
    const again = await join(s.id, 'Ravi Kumar', '9840012345')
    expect(again.ok && again.alreadyIn).toBe(true)
    expect((await roster(s.id)).filter((r) => r.state !== 'withdrawn')).toHaveLength(1)
  })

  it('hands the spot link back only to the phone that holds it', async () => {
    const s = await makeGame()
    const first = await join(s.id, 'Ravi Kumar', '9840012345')
    expect(first.ok && first.token).toBeTruthy()

    const sameDevice = await join(s.id, 'Ravi Kumar', '9840012345')
    expect(sameDevice.ok && sameDevice.token).toBeTruthy()

    // Somebody else typing the same name and number learns that they are on the
    // list and nothing else — otherwise they could cancel their evening.
    const otherDevice = await joinSession(
      { sessionId: s.id, name: 'Ravi Kumar', phone: '9840012345', source: 'self', deviceId: 'someone-else' },
      BEFORE_GATE,
    )
    expect(otherDevice.ok && otherDevice.alreadyIn).toBe(true)
    expect(otherDevice.ok && otherDevice.token).toBe(null)
  })

  it('asks the public form for a phone number and the host for nothing', async () => {
    const s = await makeGame()
    const noPhone = await joinSession({ sessionId: s.id, name: 'Ravi Kumar', source: 'self' }, BEFORE_GATE)
    expect(noPhone.ok).toBe(false)
    const byHost = await joinSession({ sessionId: s.id, name: 'Ravi Kumar', source: 'host' }, BEFORE_GATE)
    expect(byHost.ok).toBe(true)
  })

  it('refuses a number that is not one', async () => {
    const s = await makeGame()
    const bad = await join(s.id, 'Ravi Kumar', '12345')
    expect(bad.ok).toBe(false)
  })

  it('counts somebody joining inside the confirmation window as confirmed', async () => {
    // Joining IS confirming. Otherwise the gate withdraws somebody ninety
    // minutes after they signed up, for not confirming what they just did.
    const s = await makeGame()
    const late = await joinSession(
      { sessionId: s.id, name: 'Late Arrival', phone: '9840012348', source: 'self' },
      new Date('2026-09-15T11:00:00Z'),
    )
    expect(late.ok && late.state).toBe('confirmed')
  })

  it('closes the public form once the game has started, but not the host', async () => {
    const s = await makeGame()
    const after = new Date('2026-09-15T14:00:00Z')
    const player = await joinSession({ sessionId: s.id, name: 'Walk Up', phone: '9840012349', source: 'self' }, after)
    expect(player.ok).toBe(false)
    const host = await joinSession(
      { sessionId: s.id, name: 'Walk Up', phone: '9840012349', source: 'host', arriveCheckedIn: true },
      after,
    )
    expect(host.ok && host.state).toBe('checked_in')
  })

  it('opens one more spot for a walk-in rather than waitlisting somebody standing there', async () => {
    const s = await makeGame({ capacity: 1 })
    await join(s.id, 'Ravi Kumar', '9840012345')
    const walkIn = await joinSession(
      { sessionId: s.id, name: 'Suresh Babu', source: 'host', arriveCheckedIn: true },
      new Date('2026-09-15T13:45:00Z'),
    )
    expect(walkIn.ok && walkIn.state).toBe('checked_in')
    expect(walkIn.ok && walkIn.openedASpot).toBe(true)
  })
})

describe('leaving and the waitlist', () => {
  it('frees the seat and promotes the first in line, in the same breath', async () => {
    const s = await makeGame()
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')
    await join(s.id, 'Suresh Babu', '9840012347')
    await join(s.id, 'Anita Rao', '9840012348')

    const left = await leaveSession(
      (a as { participantId: string }).participantId,
      { kind: 'player', label: 'player' },
      null,
      BEFORE_GATE,
    )
    expect(left.ok && left.promoted.map((p) => p.name)).toEqual(['Suresh Babu'])

    const after = await roster(s.id)
    const suresh = after.find((r) => r.name === 'Suresh Babu')!
    expect(suresh.state).toBe('joined')
    expect(suresh.seatNo).toBe(1) // the seat that was actually freed
    expect(after.find((r) => r.name === 'Anita Rao')!.state).toBe('waitlisted')
  })

  it('gives a freed spot to exactly one person, never two', async () => {
    const s = await makeGame({ capacity: 1 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')
    await join(s.id, 'Suresh Babu', '9840012347')

    await leaveSession((a as { participantId: string }).participantId, { kind: 'player', label: 'player' }, null, BEFORE_GATE)
    const seated = (await roster(s.id)).filter((r) => r.seatNo !== null && r.state !== 'withdrawn')
    expect(seated).toHaveLength(1)
  })

  it('refuses to let the same spot go twice', async () => {
    const s = await makeGame()
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const id = (a as { participantId: string }).participantId
    expect((await leaveSession(id, { kind: 'player', label: 'player' }, null, BEFORE_GATE)).ok).toBe(true)
    expect((await leaveSession(id, { kind: 'player', label: 'player' }, null, BEFORE_GATE)).ok).toBe(false)
  })

  it('sends a rejoin to the back, and keeps the record of the first go', async () => {
    const s = await makeGame()
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    await leaveSession((a as { participantId: string }).participantId, { kind: 'player', label: 'player' }, null, BEFORE_GATE)
    const again = await join(s.id, 'Ravi Kumar', '9840012345')
    expect(again.ok && again.alreadyIn).toBe(false)

    const rows = await roster(s.id)
    expect(rows).toHaveLength(2)
    expect(rows[0].state).toBe('withdrawn')
    expect(rows[1].seq).toBeGreaterThan(rows[0].seq)
  })
})

describe('the soft cap', () => {
  it('opening more spots fills them from the waitlist at once', async () => {
    const s = await makeGame({ capacity: 2 })
    await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')
    await join(s.id, 'Suresh Babu', '9840012347')
    await join(s.id, 'Anita Rao', '9840012348')

    const res = await setCapacity(s.id, 4, actor, BEFORE_GATE)
    expect(res.ok && res.promoted.map((p) => p.name)).toEqual(['Suresh Babu', 'Anita Rao'])
    expect(countRoster(await roster(s.id)).waiting).toBe(0)
  })

  it('lowering it never turns anybody out', async () => {
    const s = await makeGame({ capacity: 4 })
    for (const [n, p] of [
      ['Ravi Kumar', '9840012345'],
      ['Priya Sharma', '9840012346'],
      ['Suresh Babu', '9840012347'],
    ] as const) {
      await join(s.id, n, p)
    }
    const res = await setCapacity(s.id, 1, actor, BEFORE_GATE)
    expect(res.ok && res.capacity).toBe(3)
    expect(res.ok && res.clamped).toBe(true)
    expect(countRoster(await roster(s.id)).taken).toBe(3)
  })
})

describe('guests', () => {
  it('the guest plays and the inviter owes', async () => {
    const s = await makeGame({ capacity: 4 })
    const host = await join(s.id, 'Ravi Kumar', '9840012345')
    const guest = await joinSession(
      {
        sessionId: s.id,
        name: 'Visiting Friend',
        source: 'host',
        guestOfPlayerId: (host as { playerId: string }).playerId,
      },
      BEFORE_GATE,
    )
    expect(guest.ok).toBe(true)

    const rows = await roster(s.id)
    const g = rows.find((r) => r.name === 'Visiting Friend')!
    expect(g.isGuest).toBe(true)
    expect(g.payerPlayerId).toBe((host as { playerId: string }).playerId)
    // The invariant `s1k` is really asking for: a guest's game is the guest's,
    // and never lands in the inviter's attendance history.
    expect(g.playerId).not.toBe(g.payerPlayerId)
    expect(rows.filter((r) => r.playerId === (host as { playerId: string }).playerId)).toHaveLength(1)
  })

  it('refuses a guest of somebody who is not on the list', async () => {
    const s = await makeGame({ capacity: 4 })
    const res = await joinSession(
      { sessionId: s.id, name: 'Visiting Friend', source: 'host', guestOfPlayerId: 'nobody' },
      BEFORE_GATE,
    )
    expect(res.ok).toBe(false)
  })

  it('moves the bill without moving the game', async () => {
    const s = await makeGame({ capacity: 4 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const b = await join(s.id, 'Priya Sharma', '9840012346')
    const moved = await setPayer(
      (b as { participantId: string }).participantId,
      (a as { playerId: string }).playerId,
      actor,
    )
    expect(moved.ok).toBe(true)
    const row = (await roster(s.id)).find((r) => r.name === 'Priya Sharma')!
    expect(row.payerPlayerId).toBe((a as { playerId: string }).playerId)
    expect(row.playerId).toBe((b as { playerId: string }).playerId)
  })
})

describe('the reconciler', () => {
  it('releases unconfirmed spots at the deadline and promotes the waitlist', async () => {
    const s = await makeGame({ capacity: 2 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')
    await join(s.id, 'Suresh Babu', '9840012347')

    // One of them confirms; the other does not.
    await confirmSpot((a as { participantId: string }).participantId)

    const out = await runTick(new Date('2026-09-15T12:35:00Z'))
    expect(out.applied).toBeGreaterThan(0)

    const rows = await roster(s.id)
    expect(rows.find((r) => r.name === 'Ravi Kumar')!.state).toBe('confirmed')
    expect(rows.find((r) => r.name === 'Priya Sharma')!.state).toBe('withdrawn')
    // The freed seat went to the person waiting, already confirmed because the
    // window has closed and there is no time left to ask them.
    expect(rows.find((r) => r.name === 'Suresh Babu')!.state).toBe('confirmed')
  })

  it('claims each boundary once, so a retried tick changes nothing', async () => {
    // `go_live` is the right action to test this with: unlike the gate, its
    // plan does not depend on participant state, so winding the session back
    // makes the planner emit it AGAIN and the second run really does reach the
    // claim. A test that leaves an empty plan behind proves only that an empty
    // plan does nothing.
    const s = await makeGame({ capacity: 4, confirmationGate: false })
    await join(s.id, 'Ravi Kumar', '9840012345')

    const at = new Date('2026-09-15T13:35:00Z')
    const first = await runTick(at)
    expect(first.applied).toBe(1)

    const rows1 = await tdb.handle
      .select()
      .from(sessionScheduledActions)
      .where(eq(sessionScheduledActions.sessionId, s.id))
    expect(rows1).toHaveLength(1)
    expect(rows1[0].kind).toBe('go_live')

    // Wind it back and run the identical tick — exactly what a retried cron
    // does. The planner emits `go_live` again; the unique key refuses it.
    await tdb.handle.update(gameSessions).set({ status: 'open' }).where(eq(gameSessions.id, s.id))
    const again = await runTick(at)

    const rows2 = await tdb.handle
      .select()
      .from(sessionScheduledActions)
      .where(eq(sessionScheduledActions.sessionId, s.id))
    expect(rows2).toHaveLength(1)
    expect(again.applied).toBe(0)

    const [after] = await tdb.handle.select().from(gameSessions).where(eq(gameSessions.id, s.id))
    expect(after.status).toBe('open') // refused, not re-applied
  })

  it('will not give a spot away once the game has started — it records the miss instead', async () => {
    const s = await makeGame({ capacity: 2 })
    await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')
    await join(s.id, 'Suresh Babu', '9840012347')

    // Nothing ran until the game was already being played.
    await runTick(new Date('2026-09-15T14:00:00Z'))

    const rows = await roster(s.id)
    expect(rows.find((r) => r.name === 'Ravi Kumar')!.state).not.toBe('withdrawn')
    expect(rows.find((r) => r.name === 'Suresh Babu')!.state).toBe('waitlisted')

    const [missed] = await tdb.handle
      .select()
      .from(sessionScheduledActions)
      .where(
        and(
          eq(sessionScheduledActions.sessionId, s.id),
          eq(sessionScheduledActions.kind, 'release_unconfirmed'),
        ),
      )
    expect(missed.outcome).toBe('skipped_stale')
  })

  it('takes a game missed for a week all the way to closed, in one tick', async () => {
    const s = await makeGame({ capacity: 4 })
    await join(s.id, 'Ravi Kumar', '9840012345')

    await runTick(new Date('2026-09-22T00:00:00Z'))

    const [after] = await tdb.handle.select().from(gameSessions).where(eq(gameSessions.id, s.id))
    expect(after.status).toBe('locked')
    // Nobody was ticked off, so nobody played and nobody is charged. Failing to
    // charge is recoverable; charging sixteen people who were not there is not.
    expect((await roster(s.id)).find((r) => r.name === 'Ravi Kumar')!.state).toBe('absent')
  })

  it('turns who was ticked off into who played, and the rest into who was away', async () => {
    const s = await makeGame({ capacity: 4 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')
    await join(s.id, 'Suresh Babu', '9840012347')

    await setPresent((a as { participantId: string }).participantId, true, new Date('2026-09-15T13:35:00Z'))
    await endSession(s.id, actor, new Date('2026-09-15T15:30:00Z'))
    await runTick(new Date('2026-09-15T16:20:00Z'))

    const rows = await roster(s.id)
    expect(rows.find((r) => r.name === 'Ravi Kumar')!.state).toBe('played')
    expect(rows.find((r) => r.name === 'Priya Sharma')!.state).toBe('absent')
    expect(rows.find((r) => r.name === 'Suresh Babu')!.state).toBe('absent')
    const [after] = await tdb.handle.select().from(gameSessions).where(eq(gameSessions.id, s.id))
    expect(after.status).toBe('locked')
  })

  it('withdraws anybody still waiting when the night closes — they never got a spot', async () => {
    const s = await makeGame({ capacity: 1 })
    await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')
    await endSession(s.id, actor, new Date('2026-09-15T15:30:00Z'))
    await runTick(new Date('2026-09-15T16:20:00Z'))
    expect((await roster(s.id)).find((r) => r.name === 'Priya Sharma')!.state).toBe('withdrawn')
  })

  it('leaves attendance alone once the night is closed', async () => {
    const s = await makeGame({ capacity: 2 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    await endSession(s.id, actor, new Date('2026-09-15T15:30:00Z'))
    await runTick(new Date('2026-09-15T16:20:00Z'))
    const late = await setPresent((a as { participantId: string }).participantId, true)
    expect(late.ok).toBe(false)
  })
})

describe('what the public page can see', () => {
  it('shows a first name and an initial, and no phone number anywhere', async () => {
    const s = await makeGame({ capacity: 4 })
    await join(s.id, 'Ravi Kumar', '9840012345')
    const view = await publicSession(s.slug, BEFORE_GATE)
    expect(view!.spots.map((p) => p.name)).toEqual(['Ravi K.'])
    expect(JSON.stringify(view)).not.toContain('9840012345')
    expect(JSON.stringify(view)).not.toContain('+919840012345')
    expect(JSON.stringify(view)).not.toContain('Kumar')
  })

  it('counts somebody who opted out without naming them', async () => {
    const s = await makeGame({ capacity: 4 })
    await join(s.id, 'Ravi Kumar', '9840012345', { hideFromPublic: true })
    const view = await publicSession(s.slug, BEFORE_GATE)
    expect(view!.hidden).toBe(1)
    expect(view!.spots).toHaveLength(0)
    // They still hold a spot — hidden is not the same as not playing.
    expect(view!.taken).toBe(1)
    expect(JSON.stringify(view)).not.toContain('Ravi')
  })

  it('never carries a device id, an IP hash or a spot token', async () => {
    const s = await makeGame({ capacity: 4 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const token = (a as { token: string }).token
    const view = JSON.stringify(await publicSession(s.slug, BEFORE_GATE))
    expect(view).not.toContain(token)
    expect(view).not.toContain('dev-ravikumar')
  })
})

describe('the seat index, not the code, is what enforces capacity', () => {
  it('refuses a second claim on a seat even when the application asks for one', async () => {
    const s = await makeGame({ capacity: 2 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const b = await join(s.id, 'Priya Sharma', '9840012346')
    expect(a.ok && b.ok).toBe(true)

    // Go around the domain entirely — this is the bug a future refactor could
    // introduce, and the database has to be the thing that stops it.
    await expect(
      tdb.handle
        .update(sessionParticipants)
        .set({ seatNo: 1 })
        .where(eq(sessionParticipants.id, (b as { participantId: string }).participantId)),
    ).rejects.toThrow()
  })
})

describe('one number is one spot', () => {
  it('will not let the same phone take a second seat under a different name', async () => {
    // `resolvePlayer` deliberately refuses to move a number onto a different
    // name, so without this check each alias became a fresh player and a fresh
    // seat — sixteen names, one phone, a full game.
    const s = await makeGame({ capacity: 4 })
    const first = await join(s.id, 'Ravi Kumar', '9840012345')
    const alias = await joinSession(
      { sessionId: s.id, name: 'Totally Different', phone: '98400 12345', source: 'self', deviceId: 'dev-alias' },
      BEFORE_GATE,
    )
    expect(alias.ok && alias.alreadyIn).toBe(true)
    expect(countRoster(await roster(s.id)).taken).toBe(1)
    // …and the answer gives nothing away: no token to a device that is not theirs.
    expect(alias.ok && alias.token).toBe(null)
    expect(first.ok && first.token).toBeTruthy()
  })

  it('answers the same way whether the name matched or not, so it is no oracle', async () => {
    const s = await makeGame({ capacity: 4 })
    await join(s.id, 'Ravi Kumar', '9840012345')
    const right = await joinSession(
      { sessionId: s.id, name: 'Ravi Kumar', phone: '9840012345', source: 'self', deviceId: 'dev-x' },
      BEFORE_GATE,
    )
    const wrong = await joinSession(
      { sessionId: s.id, name: 'Somebody Else', phone: '9840012345', source: 'self', deviceId: 'dev-y' },
      BEFORE_GATE,
    )
    expect(right.ok && right.alreadyIn).toBe(true)
    expect(wrong.ok && wrong.alreadyIn).toBe(true)
    expect(right.ok && right.token).toBe(wrong.ok ? wrong.token : 'different')
  })

  it('makes the host name a second Priya rather than silently creating one', async () => {
    const s = await makeGame({ capacity: 4 })
    await joinSession({ sessionId: s.id, name: 'Priya', source: 'host' }, BEFORE_GATE)
    const second = await joinSession({ sessionId: s.id, name: 'Priya', source: 'host' }, BEFORE_GATE)
    expect(second.ok).toBe(false)
    expect(countRoster(await roster(s.id)).taken).toBe(1)
  })
})

describe('the gate can be switched off', () => {
  it('leaves everybody alone when the host never asked them to confirm', async () => {
    const s = await makeGame({ capacity: 4, confirmationGate: false })
    await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')

    await runTick(new Date('2026-09-15T12:45:00Z'))

    const rows = await roster(s.id)
    expect(rows.every((r) => r.state === 'joined')).toBe(true)
  })
})

describe('what cannot happen', () => {
  it('a player cannot give up a spot once the game has started', async () => {
    const s = await makeGame({ capacity: 4 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const res = await leaveSession(
      (a as { participantId: string }).participantId,
      { kind: 'player', label: 'player' },
      null,
      new Date('2026-09-15T14:00:00Z'),
    )
    expect(res.ok).toBe(false)
  })

  it('the host still can, but nobody is moved up into a game already being played', async () => {
    const s = await makeGame({ capacity: 1 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    await join(s.id, 'Priya Sharma', '9840012346')
    const res = await leaveSession(
      (a as { participantId: string }).participantId,
      { kind: 'host', label: 'organiser' },
      null,
      new Date('2026-09-15T14:00:00Z'),
    )
    expect(res.ok && res.promoted).toEqual([])
    expect((await roster(s.id)).find((r) => r.name === 'Priya Sharma')!.state).toBe('waitlisted')
  })

  it('nobody is told "see you there" for a game that was called off', async () => {
    const s = await makeGame({ capacity: 4 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    await cancelSession(s.id, 'rain', actor)
    const res = await confirmSpot((a as { participantId: string }).participantId)
    expect(res.ok).toBe(false)
  })

  it('a price that would not fit the column is a sentence, not a 500', async () => {
    const huge = await createSession(
      { title: 'Gold', startsAt: STARTS, endsAt: ENDS, pricePaise: 99_999_999_999, capacity: 4, courtCount: 1 },
      actor,
      MADE,
    )
    expect(huge.ok).toBe(false)
  })
})

describe('the host filling a vacancy by hand', () => {
  it('puts somebody in off the waitlist mid-evening', async () => {
    const s = await makeGame({ capacity: 1 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const b = await join(s.id, 'Priya Sharma', '9840012346')
    expect(b.ok && b.waiting).toBe(true)

    // Ravi never turned up; the host takes him off at ten past seven.
    await leaveSession(
      (a as { participantId: string }).participantId,
      { kind: 'host', label: 'organiser' },
      'no-show',
      new Date('2026-09-15T13:40:00Z'),
    )
    const res = await seatFromWaitlist((b as { participantId: string }).participantId, new Date('2026-09-15T13:41:00Z'))
    expect(res.ok).toBe(true)
    const row = (await roster(s.id)).find((r) => r.name === 'Priya Sharma')!
    expect(row.state).toBe('checked_in')
    expect(row.seatNo).toBe(1)
  })
})

describe('the spot link', () => {
  it('resolves to its own participation and nobody else’s', async () => {
    const s = await makeGame({ capacity: 4 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const b = await join(s.id, 'Priya Sharma', '9840012346')
    const token = (a as { token: string }).token

    const found = await resolveSpot(token)
    expect(found?.participant.id).toBe((a as { participantId: string }).participantId)
    expect(found?.participant.id).not.toBe((b as { participantId: string }).participantId)

    expect(await resolveSpot('not-a-token')).toBe(null)
    expect(await resolveSpot('')).toBe(null)
  })

  it('is drawn, not derived — two spots never share one', async () => {
    const s = await makeGame({ capacity: 4 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const b = await join(s.id, 'Priya Sharma', '9840012346')
    expect((a as { token: string }).token).not.toBe((b as { token: string }).token)
    expect((a as { token: string }).token.length).toBeGreaterThan(20)
  })
})

describe('seats are compacted before the cap moves', () => {
  it('lowering the cap after withdrawals cannot leave people above it', async () => {
    // Seats are recycled, so a handful of withdrawals leaves the numbers in use
    // scattered — {6, 8} for two people out of eight. Lowering the cap to three
    // without compacting first leaves both of them ABOVE it and invisible to
    // `freeSeats`, which only scans 1..capacity, so the promotion in the same
    // call fills 1..3 on top of them.
    const s = await makeGame({ capacity: 8 })
    const joined = []
    for (let i = 1; i <= 8; i++) {
      joined.push(await join(s.id, `Player ${'ABCDEFGH'[i - 1]}`, `98400123${40 + i}`))
    }
    // Everybody but the sixth and the eighth drops out.
    for (const [i, p] of joined.entries()) {
      if (i === 5 || i === 7) continue
      await leaveSession((p as { participantId: string }).participantId, { kind: 'host', label: 'organiser' }, null, BEFORE_GATE)
    }
    // …and three people are waiting.
    for (let i = 1; i <= 3; i++) await join(s.id, `Waiter ${'XYZ'[i - 1]}`, `98400124${40 + i}`)

    const res = await setCapacity(s.id, 3, actor, BEFORE_GATE)
    expect(res.ok).toBe(true)

    const held = (await roster(s.id)).filter((r) => r.seatNo !== null && r.state !== 'withdrawn')
    expect(held.length).toBeLessThanOrEqual(res.ok ? res.capacity : 0)
    // …and every seat number is inside the cap, not stranded above it.
    for (const h of held) expect(h.seatNo!).toBeLessThanOrEqual(res.ok ? res.capacity : 0)
  })

  it('renumbers onto 1..n even when the new order swaps two people', async () => {
    // A single renumbering UPDATE raises a duplicate-key error the moment the
    // new numbering swaps two rows; the compaction goes via an offset for
    // exactly that reason.
    const s = await makeGame({ capacity: 4 })
    const a = await join(s.id, 'Player A', '9840012351')
    await join(s.id, 'Player B', '9840012352')
    await leaveSession((a as { participantId: string }).participantId, { kind: 'host', label: 'organiser' }, null, BEFORE_GATE)
    await join(s.id, 'Player C', '9840012353') // takes the freed seat 1, behind B in arrival order

    const res = await setCapacity(s.id, 2, actor, BEFORE_GATE)
    expect(res.ok).toBe(true)
    const held = (await roster(s.id))
      .filter((r) => r.seatNo !== null && r.state !== 'withdrawn')
      .sort((x, y) => x.seq - y.seq)
    expect(held.map((h) => h.seatNo)).toEqual([1, 2])
  })
})

describe('a link that leaked', () => {
  it('can be replaced, and the old one stops working', async () => {
    const s = await makeGame({ capacity: 4 })
    const a = await join(s.id, 'Ravi Kumar', '9840012345')
    const old = (a as { token: string }).token
    expect(await resolveSpot(old)).not.toBe(null)

    const res = await rotateSpotToken((a as { participantId: string }).participantId)
    expect(res.ok).toBe(true)
    expect(await resolveSpot(old)).toBe(null)
    expect((await resolveSpot(res.ok ? res.token : ''))?.participant.id).toBe(
      (a as { participantId: string }).participantId,
    )
  })
})
