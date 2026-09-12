import { describe, expect, it } from 'vitest'
import {
  boundariesFor,
  DEFAULT_SESSION_POLICY,
  gatePhase,
  lockAtFor,
  planSession,
  type PlannableParticipant,
  type PlannableSession,
} from '../daily-clock'

/**
 * The whole timing surface, against a fixture clock.
 *
 * `planSession` never reads a clock, so every case below is a literal in and a
 * literal out — which is the only reason a confirmation gate that fires three
 * hours before a game is testable at all.
 */

const at = (iso: string) => new Date(iso)
// A Tuesday, 7–9pm at the venue. +05:30 throughout; India has one offset.
const STARTS = at('2026-09-15T13:30:00Z') // 19:00 IST
const ENDS = at('2026-09-15T15:30:00Z') // 21:00 IST

function session(over: Partial<PlannableSession> = {}): PlannableSession {
  const b = boundariesFor(STARTS, ENDS, DEFAULT_SESSION_POLICY, at('2026-09-01T00:00:00Z'))
  return {
    status: 'open',
    startsAt: STARTS,
    endsAt: ENDS,
    confirmationGate: true,
    confirmDeadlineAt: b.confirmDeadlineAt,
    autoEndAt: b.autoEndAt,
    lockAt: null,
    ...over,
  }
}

const people = (...states: PlannableParticipant['state'][]): PlannableParticipant[] =>
  states.map((state, i) => ({ id: `p${i + 1}`, state }))

describe('boundariesFor', () => {
  it('puts the gate three hours and one hour before the start', () => {
    const b = boundariesFor(STARTS, ENDS, DEFAULT_SESSION_POLICY, at('2026-09-01T00:00:00Z'))
    expect(b.confirmOpensAt.toISOString()).toBe('2026-09-15T10:30:00.000Z') // 16:00 IST
    expect(b.confirmDeadlineAt.toISOString()).toBe('2026-09-15T12:30:00.000Z') // 18:00 IST
    expect(b.autoEndAt.toISOString()).toBe('2026-09-15T16:00:00.000Z') // 21:30 IST
  })

  it('clamps a game put up at short notice instead of dating the gate before it existed', () => {
    // Created twenty minutes before it starts: both boundaries collapse to now,
    // which makes the gate a no-op rather than an impossibility.
    const created = at('2026-09-15T13:10:00Z')
    const b = boundariesFor(STARTS, ENDS, DEFAULT_SESSION_POLICY, created)
    expect(b.confirmOpensAt.getTime()).toBe(created.getTime())
    expect(b.confirmDeadlineAt.getTime()).toBe(created.getTime())
    expect(b.confirmOpensAt <= b.confirmDeadlineAt).toBe(true)
  })

  it('never lets the deadline land before confirmations open', () => {
    const odd = { ...DEFAULT_SESSION_POLICY, confirmOpensBeforeMin: 30, confirmDeadlineBeforeMin: 120 }
    const b = boundariesFor(STARTS, ENDS, odd, at('2026-09-01T00:00:00Z'))
    expect(b.confirmDeadlineAt.getTime()).toBeGreaterThanOrEqual(b.confirmOpensAt.getTime())
  })

  it('locks forty-five minutes after the session ended', () => {
    expect(lockAtFor(ENDS).toISOString()).toBe('2026-09-15T16:15:00.000Z')
  })
})

describe('planSession — nothing to do', () => {
  it('is empty well before anything is due', () => {
    expect(planSession(session(), people('joined', 'joined'), at('2026-09-15T08:00:00Z'))).toEqual([])
  })

  it('does nothing at all for a draft, a locked night or a cancelled one', () => {
    for (const status of ['draft', 'locked', 'cancelled'] as const) {
      const s = session({ status, lockAt: at('2026-09-01T00:00:00Z') })
      expect(planSession(s, people('joined'), at('2026-09-20T00:00:00Z'))).toEqual([])
    }
  })
})

describe('planSession — the confirmation gate', () => {
  it('releases the unconfirmed at the deadline, and names only them', () => {
    const plan = planSession(
      session(),
      people('joined', 'confirmed', 'joined', 'waitlisted', 'withdrawn'),
      at('2026-09-15T12:30:00Z'),
    )
    expect(plan).toHaveLength(1)
    expect(plan[0].kind).toBe('release_unconfirmed')
    expect(plan[0].stale).toBe(false)
    expect(plan[0].participantIds).toEqual(['p1', 'p3'])
    // The key is the boundary, never `now` — that is what makes a replay a no-op.
    expect(plan[0].boundaryAt.toISOString()).toBe('2026-09-15T12:30:00.000Z')
  })

  it('does not release a minute before the deadline', () => {
    expect(planSession(session(), people('joined'), at('2026-09-15T12:29:00Z'))).toEqual([])
  })

  it('says nothing when everybody has confirmed', () => {
    expect(planSession(session(), people('confirmed', 'confirmed'), at('2026-09-15T12:30:00Z'))).toEqual([])
  })

  it('leaves the gate alone when the host switched it off', () => {
    const plan = planSession(
      session({ confirmationGate: false }),
      people('joined', 'joined'),
      at('2026-09-15T12:45:00Z'),
    )
    expect(plan.map((a) => a.kind)).not.toContain('release_unconfirmed')
  })

  it('marks the boundary missed rather than giving a spot away mid-game', () => {
    // The tick did not run until the session had already started. Withdrawing
    // somebody now and handing their spot to the waitlist is a wasted evening.
    const plan = planSession(session(), people('joined'), at('2026-09-15T14:00:00Z'))
    const release = plan.find((a) => a.kind === 'release_unconfirmed')
    expect(release).toBeDefined()
    expect(release!.stale).toBe(true)
  })
})

describe('planSession — running and finishing', () => {
  it('goes live at the start time', () => {
    const plan = planSession(session(), people('confirmed'), at('2026-09-15T13:30:00Z'))
    expect(plan.map((a) => a.kind)).toEqual(['go_live'])
    expect(plan[0].boundaryAt.getTime()).toBe(STARTS.getTime())
  })

  it('ends a live session half an hour after it was due to finish', () => {
    const plan = planSession(session({ status: 'live' }), people('checked_in'), at('2026-09-15T16:00:00Z'))
    expect(plan.map((a) => a.kind)).toEqual(['auto_end'])
  })

  it('ends a session nobody ever started, so the night is not left open forever', () => {
    const plan = planSession(session(), people('confirmed'), at('2026-09-15T16:05:00Z'))
    expect(plan.map((a) => a.kind)).toContain('auto_end')
  })

  it('locks once the lock boundary passes', () => {
    const s = session({ status: 'ended', lockAt: at('2026-09-15T16:15:00Z') })
    expect(planSession(s, people('checked_in'), at('2026-09-15T16:15:00Z')).map((a) => a.kind)).toEqual(['lock'])
  })

  it('does not lock early', () => {
    const s = session({ status: 'ended', lockAt: at('2026-09-15T16:15:00Z') })
    expect(planSession(s, people('checked_in'), at('2026-09-15T16:14:59Z'))).toEqual([])
  })
})

describe('planSession — catching up', () => {
  it('a game missed for a week yields one catch-up, in order, not a week of cycles', () => {
    const plan = planSession(session(), people('joined', 'confirmed'), at('2026-09-22T00:00:00Z'))
    expect(plan.map((a) => a.kind)).toEqual(['release_unconfirmed', 'go_live', 'auto_end'])
    // …and the one that would have hurt is the one that is refused.
    expect(plan[0].stale).toBe(true)
    expect(plan[1].stale).toBe(false)
    expect(plan[2].stale).toBe(false)
  })

  it('computes the same plan twice from the same clock — which is why the applier owns the key', () => {
    const a = planSession(session(), people('joined'), at('2026-09-15T12:40:00Z'))
    const b = planSession(session(), people('joined'), at('2026-09-15T12:40:00Z'))
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('gatePhase', () => {
  const b = boundariesFor(STARTS, ENDS, DEFAULT_SESSION_POLICY, at('2026-09-01T00:00:00Z'))
  const s = {
    confirmationGate: true,
    startsAt: STARTS,
    confirmOpensAt: b.confirmOpensAt,
    confirmDeadlineAt: b.confirmDeadlineAt,
  }

  it('is before, open, then closed', () => {
    expect(gatePhase(s, at('2026-09-15T10:29:00Z'))).toBe('before')
    expect(gatePhase(s, at('2026-09-15T10:30:00Z'))).toBe('open')
    expect(gatePhase(s, at('2026-09-15T12:29:00Z'))).toBe('open')
    expect(gatePhase(s, at('2026-09-15T12:30:00Z'))).toBe('closed')
  })

  it('is always "before" when the host switched the gate off, so nobody is asked to confirm', () => {
    expect(gatePhase({ ...s, confirmationGate: false }, at('2026-09-15T12:31:00Z'))).toBe('before')
  })
})
