import { cache } from 'react'
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { gameSessions, sessionParticipants } from '@/db/schema'
import { publicName } from '@/lib/display'
import { gatePhase, type GatePhase } from '@/lib/daily-clock'

/**
 * Public reads for daily games.
 *
 * Built by explicit mappers, never from a raw row. The game page is readable by
 * anyone with the link and that link gets forwarded into WhatsApp groups, so it
 * carries **first name and last initial and nothing else** — enough for "is
 * Suresh playing?", not a directory of the venue's members.
 *
 * Phone numbers, balances, what anyone owes, payment status and no-show history
 * are absent from the SELECT, not filtered afterwards: filtering in the
 * frontend is a leak, not a control (SPEC-v4 §8).
 *
 * Cookie-free, like `public.ts`, so the version route the page polls keeps its
 * CDN cache.
 */

/** What the public list shows for one game. */
export type PublicSession = {
  slug: string
  title: string
  kind: 'open_play' | 'booked'
  status: 'open' | 'live' | 'ended' | 'locked' | 'draft' | 'cancelled'
  startsAt: Date
  endsAt: Date
  pricePaise: number
  capacity: number
  courtCount: number
  taken: number
  waiting: number
  full: boolean
}

/** One player on the public list. No id, because an id is a handle. */
export type PublicSpot = { name: string; waiting: boolean; here: boolean }

export type PublicSessionDetail = PublicSession & {
  notes: string | null
  spots: PublicSpot[]
  waitingList: PublicSpot[]
  /** How many chose to keep their name off the list. A number, never a name. */
  hidden: number
  gate: GatePhase
  confirmDeadlineAt: Date | null
}

const OCCUPYING = ['joined', 'confirmed', 'checked_in', 'played', 'absent'] as const

/**
 * The list and its version number must be computed from the SAME instant, or a
 * game crossing its auto-end between the render and the poll looks like a
 * change and every phone hard-refreshes. Truncating to the minute is enough:
 * the page and the route agree for the whole minute either side of it.
 */
export function listCutoff(now: Date = new Date()): Date {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000)
}

type Counts = { taken: number; waiting: number }

/** Counts for a set of sessions, in one round trip. */
async function countsFor(sessionIds: string[]): Promise<Map<string, Counts>> {
  if (sessionIds.length === 0) return new Map<string, Counts>()
  const rows = await db
    .select({
      sessionId: sessionParticipants.sessionId,
      taken: sql<number>`count(*) filter (where ${sessionParticipants.state} <> 'waitlisted' and ${sessionParticipants.state} <> 'withdrawn')::int`,
      waiting: sql<number>`count(*) filter (where ${sessionParticipants.state} = 'waitlisted')::int`,
    })
    .from(sessionParticipants)
    .where(inArray(sessionParticipants.sessionId, sessionIds))
    .groupBy(sessionParticipants.sessionId)
  return new Map<string, Counts>(
    rows.map((r) => [r.sessionId, { taken: Number(r.taken), waiting: Number(r.waiting) }] as const),
  )
}

/**
 * The public games list: what is open or being played, soonest first.
 *
 * Memoised per request because Next calls the page's data twice — once for
 * `generateMetadata` and once for the render.
 */
export const publicSessions = cache(async (now: Date = new Date()): Promise<PublicSession[]> => {
  const rows = await db
    .select({
      id: gameSessions.id,
      slug: gameSessions.slug,
      title: gameSessions.title,
      kind: gameSessions.kind,
      status: gameSessions.status,
      startsAt: gameSessions.startsAt,
      endsAt: gameSessions.endsAt,
      pricePaise: gameSessions.pricePaise,
      capacity: gameSessions.capacity,
      courtCount: gameSessions.courtCount,
    })
    .from(gameSessions)
    .where(
      and(
        isNull(gameSessions.deletedAt),
        // Cancelled games stay on the list until they would have finished.
        // Somebody who saw one an hour ago and comes back to an empty list has
        // no way to tell whether it was called off or they imagined it.
        inArray(gameSessions.status, ['open', 'live', 'cancelled']),
        gte(gameSessions.autoEndAt, listCutoff(now)),
      ),
    )
    .orderBy(asc(gameSessions.startsAt))
    .limit(40)

  const counts = await countsFor(rows.map((r) => r.id))
  return rows.map((r) => {
    const c = counts.get(r.id) ?? { taken: 0, waiting: 0 }
    return {
      slug: r.slug,
      title: r.title,
      kind: r.kind,
      status: r.status,
      startsAt: r.startsAt,
      endsAt: r.endsAt,
      pricePaise: r.pricePaise,
      capacity: r.capacity,
      courtCount: r.courtCount,
      taken: c.taken,
      waiting: c.waiting,
      full: c.taken >= r.capacity,
    }
  })
})

/**
 * One game. Returns null for a draft — an unpublished game is not public —
 * and for anything soft-deleted.
 */
export const publicSession = cache(
  async (slug: string, now: Date = new Date()): Promise<PublicSessionDetail | null> => {
    const [s] = await db
      .select()
      .from(gameSessions)
      .where(and(eq(gameSessions.slug, slug), isNull(gameSessions.deletedAt)))
      .limit(1)
    if (!s || s.status === 'draft') return null

    // Names only. The participation row carries a device id, an IP hash and a
    // capability token, and this is the one place none of them may come through.
    const rows = await db
      .select({
        name: sessionParticipants.displayName,
        state: sessionParticipants.state,
        hidden: sessionParticipants.hideFromPublic,
        seq: sessionParticipants.seq,
      })
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, s.id),
          inArray(sessionParticipants.state, [...OCCUPYING, 'waitlisted']),
        ),
      )
      .orderBy(asc(sessionParticipants.seq))

    const spots: PublicSpot[] = []
    const waitingList: PublicSpot[] = []
    let hidden = 0
    let taken = 0
    let waiting = 0

    for (const r of rows) {
      const onWaitlist = r.state === 'waitlisted'
      if (onWaitlist) waiting++
      else taken++
      if (r.hidden) {
        hidden++
        continue
      }
      const spot: PublicSpot = {
        name: publicName(r.name),
        waiting: onWaitlist,
        here: r.state === 'checked_in' || r.state === 'played',
      }
      ;(onWaitlist ? waitingList : spots).push(spot)
    }

    return {
      slug: s.slug,
      title: s.title,
      kind: s.kind,
      status: s.status,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      pricePaise: s.pricePaise,
      capacity: s.capacity,
      courtCount: s.courtCount,
      notes: s.notes,
      taken,
      waiting,
      full: taken >= s.capacity,
      spots,
      waitingList,
      hidden,
      gate: gatePhase(s, now),
      confirmDeadlineAt: s.confirmDeadlineAt,
    }
  },
)

/** What the poll endpoint answers for one game. Null when it is not public. */
export async function publicSessionVersion(slug: string): Promise<number | null> {
  const [row] = await db
    .select({ v: gameSessions.streamVersion, status: gameSessions.status })
    .from(gameSessions)
    .where(and(eq(gameSessions.slug, slug), isNull(gameSessions.deletedAt)))
    .limit(1)
  if (!row || row.status === 'draft') return null
  return Number(row.v)
}

/**
 * One number for the whole list: how many games are on it, plus the sum of
 * their counters. A game appearing or dropping off moves the count; anything
 * changing inside one moves the sum.
 *
 * The page renders with this and the poll route answers with this — one
 * function, called twice. A second definition is how every phone in the venue
 * ends up hard-refreshing every five seconds.
 */
export async function publicSessionsVersion(now: Date = new Date()): Promise<string> {
  const [row] = await db
    .select({
      n: sql<number>`count(*)::int`,
      v: sql<number>`coalesce(sum(${gameSessions.streamVersion}), 0)::int`,
    })
    .from(gameSessions)
    .where(
      and(
        isNull(gameSessions.deletedAt),
        inArray(gameSessions.status, ['open', 'live', 'cancelled']),
        gte(gameSessions.autoEndAt, listCutoff(now)),
      ),
    )
  return `${Number(row?.n ?? 0)}:${Number(row?.v ?? 0)}`
}
