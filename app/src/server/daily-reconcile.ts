import 'server-only'
import { and, asc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm'
import { db, transact } from '@/db'
import { gameSessions, schedulerRuns, sessionParticipants, sessionScheduledActions } from '@/db/schema'
import { newId } from '@/lib/ids'
import { planSession, type PlannedAction } from '@/lib/daily-clock'
import {
  lockSessionAttendance,
  markAutoEnded,
  markLive,
  releaseUnconfirmed,
  type SessionRow,
} from './sessions'

/**
 * The reconciler.
 *
 * It asks what state each session *should* be in and moves it there. It is not
 * a queue drainer: three missed weeks produce one catch-up, not three replayed
 * cycles, because the answer is computed from the schedule rather than from a
 * backlog of events.
 *
 * There are exactly three things in this app that change state — a scheduler
 * tick, a signed webhook (stage 4), and an explicit command. **There is no page
 * render in that list.** A GET that gives someone's spot away has all the same
 * problems as a GET that moves money: link unfurling in a WhatsApp group fires
 * it, a navigation halfway through leaves it half applied, and in the access
 * log it is indistinguishable from a read.
 *
 * Replay safety does not come from the planner being pure — purity makes two
 * overlapping ticks compute *precisely* the same actions. It comes from three
 * things together:
 *
 *   - the boundary key (`session_scheduled_actions`, unique on session + kind +
 *     boundary) claimed in the same transaction as the effect;
 *   - every effect re-asserting its own pre-state in the WHERE clause, so a
 *     replay is a zero-row update;
 *   - the `for update` on the session row, which orders two ticks that reach
 *     the same session at once.
 */

export const TICK_NAME = 'daily-tick'
/** Passes per session per tick: open → live → ended → locked needs three. */
const MAX_PASSES = 4
/** A run still unfinished and younger than this means another tick is live. */
const OVERLAP_WINDOW_MS = 5 * 60_000

export type TickResult = {
  skipped: boolean
  seen: number
  applied: number
  sessions: { id: string; slug: string; actions: string[] }[]
  error?: string
}

/**
 * Which sessions could possibly have something owing.
 *
 * Anything not yet locked or cancelled whose earliest boundary has passed. The
 * query is deliberately wide — the planner is the authority, and a session that
 * yields an empty plan costs one read.
 */
async function candidates(now: Date): Promise<SessionRow[]> {
  return db
    .select()
    .from(gameSessions)
    .where(
      and(
        isNull(gameSessions.deletedAt),
        inArray(gameSessions.status, ['open', 'live', 'ended']),
        or(
          lte(gameSessions.confirmDeadlineAt, now),
          lte(gameSessions.startsAt, now),
          lte(gameSessions.autoEndAt, now),
          lte(gameSessions.lockAt, now),
        ),
      ),
    )
    .orderBy(asc(gameSessions.startsAt))
    .limit(200)
}

async function applyOne(
  session: SessionRow,
  action: PlannedAction,
  now: Date,
  tx: Parameters<Parameters<typeof transact>[0]>[0],
) {
  switch (action.kind) {
    case 'release_unconfirmed': {
      const out = await releaseUnconfirmed(tx, session, now)
      return { released: out.released.map((r) => r.name), promoted: out.promoted.map((p) => p.name) }
    }
    case 'go_live':
      return { moved: await markLive(tx, session.id, action.boundaryAt) }
    case 'auto_end':
      return { moved: await markAutoEnded(tx, session.id, action.boundaryAt) }
    case 'lock': {
      const out = await lockSessionAttendance(session.id, tx, now)
      return out
    }
  }
}

/** One session, up to `MAX_PASSES` state changes, each in its own transaction. */
async function reconcileSession(session: SessionRow, now: Date) {
  const done: string[] = []
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const changed = await transact(async (tx) => {
      const [fresh] = await tx
        .select()
        .from(gameSessions)
        .where(eq(gameSessions.id, session.id))
        .limit(1)
        .for('update')
      if (!fresh) return []

      const parts = await tx
        .select({ id: sessionParticipants.id, state: sessionParticipants.state })
        .from(sessionParticipants)
        .where(eq(sessionParticipants.sessionId, fresh.id))

      const plan = planSession(fresh, parts, now)
      const applied: string[] = []

      for (const action of plan) {
        // Claim the boundary first. An empty return means another tick — or an
        // earlier pass of this one — already owns it, and we must not act.
        const claimed = await tx
          .insert(sessionScheduledActions)
          .values({
            id: newId('sa'),
            sessionId: fresh.id,
            kind: action.kind,
            boundaryAt: action.boundaryAt,
            firedAt: now,
            // Provisional: rewritten below once the effect has actually run,
            // so the row says what happened rather than what was intended.
            outcome: action.stale ? 'skipped_stale' : 'pending',
          })
          .onConflictDoNothing()
          .returning({ id: sessionScheduledActions.id })
        if (!claimed.length) continue

        if (action.stale) {
          // The moment to act has gone. The boundary is recorded as missed and
          // nothing changes: losing a spot to our own outage is the one outcome
          // worth refusing. The host's screen shows the gate did not run.
          applied.push(`${action.kind}:missed`)
          continue
        }

        const detail = await applyOne(fresh, action, now, tx)
        // `moved: false` / `locked: false` means the pre-state guard refused it
        // — the state had already moved on, which is a no-op, not a change.
        const changed =
          detail && typeof detail === 'object' && 'moved' in detail
            ? Boolean((detail as { moved: boolean }).moved)
            : detail && typeof detail === 'object' && 'locked' in detail
              ? Boolean((detail as { locked: boolean }).locked)
              : true
        await tx
          .update(sessionScheduledActions)
          .set({ detail: (detail ?? null) as never, outcome: changed ? 'applied' : 'noop' })
          .where(eq(sessionScheduledActions.id, claimed[0].id))
        applied.push(action.kind)
      }
      return applied
    })

    if (!changed.length) break
    done.push(...changed)
  }
  return done
}

/**
 * One tick. Safe to call more often than anything needs to happen, and safe to
 * miss — correctness never depends on the scheduler being on time, only
 * collection *timing* does.
 */
export async function runTick(now: Date = new Date()): Promise<TickResult> {
  // A cheap, portable guard against two ticks overlapping. Not airtight, and it
  // does not need to be — the boundary keys and the row lock are what make
  // overlap harmless. This only stops the pointless work.
  const [running] = await db
    .select({ id: schedulerRuns.id })
    .from(schedulerRuns)
    .where(
      and(
        eq(schedulerRuns.name, TICK_NAME),
        isNull(schedulerRuns.finishedAt),
        gte(schedulerRuns.startedAt, new Date(now.getTime() - OVERLAP_WINDOW_MS)),
      ),
    )
    .limit(1)
  if (running) return { skipped: true, seen: 0, applied: 0, sessions: [] }

  const runId = newId('run')
  await db.insert(schedulerRuns).values({ id: runId, name: TICK_NAME, startedAt: now })

  const out: TickResult = { skipped: false, seen: 0, applied: 0, sessions: [] }
  try {
    const rows = await candidates(now)
    out.seen = rows.length
    const failures: string[] = []
    for (const session of rows) {
      try {
        const actions = await reconcileSession(session, now)
        if (actions.length) {
          out.applied += actions.length
          out.sessions.push({ id: session.id, slug: session.slug, actions })
        }
      } catch (e) {
        // One session that will not reconcile — a deadlock with a join, a
        // statement timeout, a dropped connection — must not take the rest of
        // the venue with it. The list is ordered by start time, so without this
        // the same game would be first in the queue on every tick and the gate
        // would stop running for every other game indefinitely.
        console.error('daily tick — session', session.slug, e)
        failures.push(session.slug)
      }
    }
    if (failures.length) out.error = `could not reconcile: ${failures.join(', ')}`
    await db
      .update(schedulerRuns)
      .set({
        finishedAt: new Date(),
        seen: out.seen,
        applied: out.applied,
        error: out.error?.slice(0, 500) ?? null,
      })
      .where(eq(schedulerRuns.id, runId))
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e)
    console.error('daily tick', e)
    await db
      .update(schedulerRuns)
      .set({ finishedAt: new Date(), seen: out.seen, applied: out.applied, error: out.error.slice(0, 500) })
      .where(eq(schedulerRuns.id, runId))
  }
  return out
}

export type SchedulerHealth = { lastFinishedAt: Date | null; lastError: string | null; ageMinutes: number | null }

/** For the badge that goes red when the ticker stops — the signal an
 *  opportunistic page-render trigger would have hidden. */
export async function schedulerHealth(now: Date = new Date()): Promise<SchedulerHealth> {
  // `finished_at is not null` matters: a run that is in flight — or one that was
  // killed by the function time limit and never finished — matches everything
  // else, and its null `finished_at` would make the badge read "never ran"
  // during every single tick, and permanently once ticks start being killed.
  // That badge is the whole of what replaces doing this work on a page render,
  // so it has to be right exactly when the scheduler is going wrong.
  const [row] = await db
    .select({ finishedAt: schedulerRuns.finishedAt })
    .from(schedulerRuns)
    .where(
      and(
        eq(schedulerRuns.name, TICK_NAME),
        isNotNull(schedulerRuns.finishedAt),
        isNull(schedulerRuns.error),
      ),
    )
    .orderBy(sql`${schedulerRuns.startedAt} desc`)
    .limit(1)
  const [errRow] = await db
    .select({ error: schedulerRuns.error })
    .from(schedulerRuns)
    .where(and(eq(schedulerRuns.name, TICK_NAME), isNotNull(schedulerRuns.finishedAt)))
    .orderBy(sql`${schedulerRuns.startedAt} desc`)
    .limit(1)
  const finishedAt = row?.finishedAt ?? null
  return {
    lastFinishedAt: finishedAt,
    lastError: errRow?.error ?? null,
    ageMinutes: finishedAt ? Math.max(0, Math.round((now.getTime() - finishedAt.getTime()) / 60_000)) : null,
  }
}
