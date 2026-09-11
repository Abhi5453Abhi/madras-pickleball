/**
 * The timing surface of a daily game, as a pure function.
 *
 * Nothing here reads a clock. `now` is an argument, the policy is an argument,
 * and the session's own resolved boundaries are read off the row rather than
 * recomputed — so a transition that happened in March is still explainable in
 * September, and every case below is table-testable against a fixture clock.
 * Same house style as `lib/estimate.ts` (`startAt` passed in) and `lib/draw.ts`
 * (seeded, never random).
 *
 * Purity is not by itself the defence against replay — it makes two overlapping
 * ticks compute PRECISELY the same actions. Every action therefore carries a
 * `boundaryAt` derived from the schedule and never from `now`, and the applier
 * writes that key with the effect in one transaction
 * (`session_scheduled_actions`, unique on session + kind + boundary).
 * See docs/ADR-daily-games.md §6.
 */

export const SESSION_POLICY_VERSION = 1

export type SessionPolicy = {
  /** Confirmations open this long before the start. Spec: three hours. */
  confirmOpensBeforeMin: number
  /** Unconfirmed spots are released this long before the start. Spec: one hour. */
  confirmDeadlineBeforeMin: number
  /** A session nobody ended ends itself this long after it was due to finish. */
  autoEndAfterMin: number
  /** Attendance freezes this long after the session ends — stage 3 locks charges here. */
  lockAfterEndMin: number
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  confirmOpensBeforeMin: 180,
  confirmDeadlineBeforeMin: 60,
  autoEndAfterMin: 30,
  lockAfterEndMin: 45,
}

const MIN = 60_000
const shift = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MIN)

export type SessionBoundaries = {
  confirmOpensAt: Date
  confirmDeadlineAt: Date
  autoEndAt: Date
}

/**
 * The boundaries written onto the session when it is created or rescheduled.
 *
 * Clamped so they can never run backwards on a session created at short notice:
 * a game starting in twenty minutes has both gate boundaries at `now`, which
 * makes the gate a no-op rather than an impossibility. `game_sessions_gate_order`
 * is the database's opinion of the same rule.
 */
export function boundariesFor(
  startsAt: Date,
  endsAt: Date,
  policy: SessionPolicy = DEFAULT_SESSION_POLICY,
  createdAt: Date = startsAt,
): SessionBoundaries {
  const floor = Math.min(createdAt.getTime(), startsAt.getTime())
  const clamp = (d: Date) => new Date(Math.max(floor, Math.min(d.getTime(), startsAt.getTime())))
  const opens = clamp(shift(startsAt, -policy.confirmOpensBeforeMin))
  const deadlineRaw = clamp(shift(startsAt, -policy.confirmDeadlineBeforeMin))
  // Opening after the deadline would make confirming impossible rather than optional.
  const deadline = new Date(Math.max(opens.getTime(), deadlineRaw.getTime()))
  return { confirmOpensAt: opens, confirmDeadlineAt: deadline, autoEndAt: shift(endsAt, policy.autoEndAfterMin) }
}

export function lockAtFor(endedAt: Date, policy: SessionPolicy = DEFAULT_SESSION_POLICY): Date {
  return shift(endedAt, policy.lockAfterEndMin)
}

// ───────────────────────────── the plan ─────────────────────────────

/** Only kinds that change state exist. "Confirmations are open" is derived, not an event. */
export type PlannedActionKind = 'release_unconfirmed' | 'go_live' | 'auto_end' | 'lock'

export type PlannedAction = {
  kind: PlannedActionKind
  /** The scheduled instant this belongs to. The idempotency key; never `now`. */
  boundaryAt: Date
  /**
   * True when the moment to act has already gone by. The applier records the
   * boundary as missed and changes nothing — the host sees "the gate did not
   * run" rather than the scheduler quietly doing the wrong thing hours late.
   */
  stale: boolean
  /** For `release_unconfirmed`: who was still unconfirmed in the snapshot. */
  participantIds?: string[]
}

/** Only the fields the plan depends on — so a test needs a literal, not a row. */
export type PlannableSession = {
  status: 'draft' | 'open' | 'live' | 'ended' | 'locked' | 'cancelled'
  startsAt: Date
  endsAt: Date
  confirmationGate: boolean
  confirmDeadlineAt: Date | null
  autoEndAt: Date | null
  lockAt: Date | null
}

export type PlannableParticipant = {
  id: string
  state: 'joined' | 'confirmed' | 'waitlisted' | 'withdrawn' | 'checked_in' | 'played' | 'absent'
}

/**
 * What should have happened to this session by `now`, in the order it should be
 * applied. Empty is the overwhelmingly common answer.
 *
 * Actions compose within one tick: a session that was missed for a week yields
 * `go_live` then `auto_end` in one plan, and each applies under its own
 * pre-state guard, so the second sees the state the first produced. The applier
 * re-plans a bounded number of times so `lock` — which only becomes reachable
 * once `auto_end` has committed — also lands in the same tick.
 *
 * There is deliberately no policy argument. Every boundary this reads was
 * computed once, when the session was published, and stored on the row with
 * the policy version that produced it. Re-deriving a boundary from today's
 * policy would move a deadline under a player who had already been told when
 * it was.
 */
export function planSession(
  session: PlannableSession,
  participants: readonly PlannableParticipant[],
  now: Date,
): PlannedAction[] {
  // draft was never published; locked and cancelled are terminal.
  if (session.status === 'draft' || session.status === 'locked' || session.status === 'cancelled') return []

  const actions: PlannedAction[] = []
  const at = now.getTime()

  if (session.status === 'open') {
    const deadline = session.confirmDeadlineAt
    if (session.confirmationGate && deadline && at >= deadline.getTime()) {
      const unconfirmed = participants.filter((p) => p.state === 'joined').map((p) => p.id)
      // Only when there is somebody to release: a gate that never ran but had
      // nothing to do missed nothing, and recording that as missed would put a
      // red mark on a night that went fine.
      if (unconfirmed.length > 0) {
        // Releasing after the session has started gives a spot away at a game
        // already being played, so past that point the boundary is recorded as
        // missed and nobody is withdrawn. Losing a spot to our own outage is
        // the one outcome worth refusing outright.
        const stale = at >= session.startsAt.getTime()
        actions.push({ kind: 'release_unconfirmed', boundaryAt: deadline, stale, participantIds: unconfirmed })
      }
    }
    if (at >= session.startsAt.getTime()) {
      actions.push({ kind: 'go_live', boundaryAt: session.startsAt, stale: false })
    }
  }

  // `open` as well as `live`: a session nobody ever started still has to end,
  // or it sits open forever and no attendance is ever resolved.
  if ((session.status === 'open' || session.status === 'live') && session.autoEndAt && at >= session.autoEndAt.getTime()) {
    actions.push({ kind: 'auto_end', boundaryAt: session.autoEndAt, stale: false })
  }

  if (session.status === 'ended' && session.lockAt && at >= session.lockAt.getTime()) {
    actions.push({ kind: 'lock', boundaryAt: session.lockAt, stale: false })
  }

  return actions
}

// ──────────────────────── derived, for screens ────────────────────────

export type GatePhase = 'before' | 'open' | 'closed'

/** Whether the app should be asking this player to confirm, right now. */
export function gatePhase(
  session: Pick<PlannableSession, 'confirmationGate' | 'startsAt'> & {
    confirmOpensAt: Date | null
    confirmDeadlineAt: Date | null
  },
  now: Date,
): GatePhase {
  if (!session.confirmationGate) return 'before'
  const at = now.getTime()
  if (session.confirmDeadlineAt && at >= session.confirmDeadlineAt.getTime()) return 'closed'
  if (session.confirmOpensAt && at >= session.confirmOpensAt.getTime()) return 'open'
  return 'before'
}

/** A tick older than this means the scheduler is not running. */
export const TICK_STALE_AFTER_MIN = 30
