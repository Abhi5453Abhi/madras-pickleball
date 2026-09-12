import 'server-only'
import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, ne, or, sql } from 'drizzle-orm'
import { db, transact, type Tx } from '@/db'
import { courtHolds, courtHoldSlots, courts, gameSessions, tournaments } from '@/db/schema'
import { newId } from '@/lib/ids'
import { minutesOfDay, venueClock, venueDayKey } from '@/lib/time'

/**
 * Court occupancy.
 *
 * One table says who has which court between which two instants, and both
 * tournaments and daily sessions write to it. Everything that used to ask "does
 * this tournament hold this court" now asks "does this holder hold this court
 * *at this moment*", which is the question that was always being asked and
 * never quite answered.
 *
 * The no-two-holders guarantee is a unique index on `court_hold_slots`,
 * maintained by a trigger (migration 0007). Nothing in this file is allowed to
 * be the guarantee: the pre-checks here exist to produce a sentence naming who
 * has the court, and the index exists to be right when two people press Save in
 * the same second. When the index wins, the transaction aborts and the caller
 * sees `CourtTaken`.
 */

export const SLOT_MINUTES = 15
const SLOT_MS = SLOT_MINUTES * 60_000

/** The quarter hour a moment falls in. Mirrors `date_bin` in the trigger. */
export function slotFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / SLOT_MS) * SLOT_MS)
}

/** The last quarter hour a `[from, until)` hold occupies. */
export function lastSlot(until: Date): Date {
  return slotFloor(new Date(until.getTime() - 1))
}

export type HoldKind = 'tournament' | 'session' | 'block'

/** Which holder a hold belongs to — exactly one, or a block, which is none. */
export type Holder =
  | { kind: 'tournament'; tournamentId: string }
  | { kind: 'session'; sessionId: string }

export type HoldRow = {
  id: string
  courtId: string
  courtName: string
  colorKey: string
  sortOrder: number
  kind: HoldKind
  tournamentId: string | null
  sessionId: string | null
  reason: string | null
  heldFrom: Date
  heldUntil: Date
  /** What to call the holder on a screen: a tournament, a game, or the reason. */
  holderName: string
  holderSlug: string | null
}

/**
 * Thrown when the slot index refuses a hold — somebody took the court between
 * the check and the write. Carries no detail on purpose: by the time this is
 * caught the transaction is aborted and the only honest thing to do is to look
 * again.
 */
export class CourtTaken extends Error {
  constructor() {
    super('court taken')
    this.name = 'CourtTaken'
  }
}

/**
 * Postgres 23505 on the slot index, whichever driver raised it and however
 * deeply it is wrapped.
 *
 * Drizzle wraps driver errors in a `DrizzleQueryError` whose message is the
 * failing SQL — which, for an insert into `court_holds`, does not mention
 * `court_hold_slots` at all — and puts the real error on `cause`. postgres.js
 * calls the field `constraint_name`; PGlite calls it `constraint`. Both the
 * code AND the constraint have to match: a 23503 on the court FK, or a 42P01 on
 * an unmigrated database, must not be reported to an organiser as "somebody
 * took that court".
 */
export function isCourtClash(e: unknown): boolean {
  let err = e as { code?: string; message?: string; constraint_name?: string; constraint?: string; cause?: unknown } | null
  for (let depth = 0; err && depth < 6; depth++) {
    const constraint = err.constraint_name ?? err.constraint ?? ''
    if (err.code === '23505' && (constraint.includes('court_hold_slots') || String(err.message ?? '').includes('court_hold_slots'))) {
      return true
    }
    err = err.cause as typeof err
  }
  return false
}

// ───────────────────────────── windows ─────────────────────────────

/** The instant a venue day starts, from its key rather than from "now". */
export function dayStart(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00+05:30`)
}

/** Midnight at the end of that venue day — the exclusive end of a whole-day hold. */
export function dayEnd(dayKey: string): Date {
  return new Date(dayStart(dayKey).getTime() + 24 * 60 * 60_000)
}

/** Every venue day from `first` to `last` inclusive, capped so a typo cannot loop. */
export function dayKeysBetween(first: string, last: string, max = 31): string[] {
  const keys: string[] = []
  let at = dayStart(first)
  const end = dayStart(last)
  while (at.getTime() <= end.getTime() && keys.length < max) {
    keys.push(venueDayKey(at))
    at = new Date(at.getTime() + 24 * 60 * 60_000)
  }
  return keys
}

export type Window = { from: Date; until: Date }

/**
 * The windows a tournament's holds cover: one per day it runs, each the same
 * time of day.
 *
 * A tournament that holds 9am–3pm leaves the evening for a social, which is the
 * whole point of stage 2. A tournament with no stated hours holds the day, which
 * is what it did before there were hours at all.
 */
export function tournamentWindows(
  startDate: Date,
  endDate: Date,
  hours?: { fromMin: number; untilMin: number } | null,
): Window[] {
  const keys = dayKeysBetween(venueDayKey(startDate), venueDayKey(endDate))
  return keys.map((key) => {
    const base = dayStart(key)
    if (!hours) return { from: base, until: dayEnd(key) }
    return {
      from: new Date(base.getTime() + hours.fromMin * 60_000),
      until: new Date(base.getTime() + hours.untilMin * 60_000),
    }
  })
}

export { minutesOfDay }

// ───────────────────────────── reading ─────────────────────────────

const holdSelect = {
  id: courtHolds.id,
  courtId: courtHolds.courtId,
  courtName: courts.name,
  colorKey: courts.colorKey,
  sortOrder: courts.sortOrder,
  kind: courtHolds.kind,
  tournamentId: courtHolds.tournamentId,
  sessionId: courtHolds.sessionId,
  reason: courtHolds.reason,
  heldFrom: courtHolds.heldFrom,
  heldUntil: courtHolds.heldUntil,
  tournamentName: tournaments.name,
  tournamentSlug: tournaments.slug,
  sessionTitle: gameSessions.title,
  sessionSlug: gameSessions.slug,
}

type RawHold = {
  id: string
  courtId: string
  courtName: string
  colorKey: string
  sortOrder: number
  kind: HoldKind
  tournamentId: string | null
  sessionId: string | null
  reason: string | null
  heldFrom: Date
  heldUntil: Date
  tournamentName: string | null
  tournamentSlug: string | null
  sessionTitle: string | null
  sessionSlug: string | null
}

function toHold(r: RawHold): HoldRow {
  return {
    id: r.id,
    courtId: r.courtId,
    courtName: r.courtName,
    colorKey: r.colorKey,
    sortOrder: r.sortOrder,
    kind: r.kind,
    tournamentId: r.tournamentId,
    sessionId: r.sessionId,
    reason: r.reason,
    heldFrom: r.heldFrom,
    heldUntil: r.heldUntil,
    holderName: r.tournamentName ?? r.sessionTitle ?? r.reason ?? 'Out of action',
    holderSlug: r.tournamentSlug ?? r.sessionSlug ?? null,
  }
}

const holdsFrom = (q: ReturnType<typeof db.select>) =>
  q
    .from(courtHolds)
    .innerJoin(courts, eq(courts.id, courtHolds.courtId))
    .leftJoin(tournaments, eq(tournaments.id, courtHolds.tournamentId))
    .leftJoin(gameSessions, eq(gameSessions.id, courtHolds.sessionId))

/**
 * Every hold that overlaps `[from, until)`, in court order then time order.
 *
 * Overlap is `held_from < until and held_until > from` — abutting is not
 * overlapping, so a 9–3 tournament and a 3–5 social both appear for a query
 * spanning the afternoon and neither is in the other's way.
 */
export async function holdsBetween(from: Date, until: Date, courtIds?: string[]): Promise<HoldRow[]> {
  // Widened to the quarter-hour grid, because that is what the index enforces.
  // Asked in real time, a hold ending at 19:05 was missing from a query about
  // 19:10 onwards, so the picker said a court was free that the save then
  // refused — the screen and the interlock have to mean the same thing by "free".
  const gridFrom = slotFloor(from)
  const gridUntil = new Date(lastSlot(until).getTime() + SLOT_MS)
  const rows = (await holdsFrom(db.select(holdSelect))
    .where(
      and(
        lt(courtHolds.heldFrom, gridUntil),
        gt(courtHolds.heldUntil, gridFrom),
        courtIds && courtIds.length ? inArray(courtHolds.courtId, courtIds) : undefined,
      ),
    )
    .orderBy(asc(courts.sortOrder), asc(courtHolds.heldFrom))) as RawHold[]
  return rows.map(toHold)
}

/** A holder's own holds, earliest first. */
export async function holdsFor(holder: Holder): Promise<HoldRow[]> {
  const rows = (await holdsFrom(db.select(holdSelect))
    .where(
      holder.kind === 'tournament'
        ? eq(courtHolds.tournamentId, holder.tournamentId)
        : eq(courtHolds.sessionId, holder.sessionId),
    )
    .orderBy(asc(courtHolds.heldFrom), asc(courts.sortOrder))) as RawHold[]
  return rows.map(toHold)
}

/**
 * The courts a holder has, once each, in venue order — the replacement for
 * `myCourts`, which could not have said "once each" because a hold per day
 * did not exist.
 */
export async function courtsHeldBy(holder: Holder) {
  const held = await holdsFor(holder)
  const seen = new Map<string, { id: string; name: string; colorKey: string; sortOrder: number }>()
  for (const h of held) {
    if (!seen.has(h.courtId)) {
      seen.set(h.courtId, { id: h.courtId, name: h.courtName, colorKey: h.colorKey, sortOrder: h.sortOrder })
    }
  }
  return [...seen.values()].sort((a, b) => a.sortOrder - b.sortOrder)
}

/**
 * The day of a holder's holds that a board should be showing.
 *
 * Today if it has any, otherwise the next day it runs, otherwise the last day
 * it ran — so the board of a tournament that starts on Sunday shows Sunday's
 * courts on Saturday, and an organiser looking back at last week still sees
 * which courts it was on.
 */
export function boardDay(held: readonly HoldRow[], now: Date): HoldRow[] {
  if (!held.length) return []
  const todayKey = venueDayKey(now)
  const today = held.filter((h) => venueDayKey(h.heldFrom) === todayKey || (h.heldFrom <= now && h.heldUntil > now))
  if (today.length) return today

  const future = held.filter((h) => h.heldFrom.getTime() > now.getTime())
  const pool = future.length ? future : held
  const pick = future.length
    ? pool.reduce((a, b) => (a.heldFrom <= b.heldFrom ? a : b))
    : pool.reduce((a, b) => (a.heldFrom >= b.heldFrom ? a : b))
  const key = venueDayKey(pick.heldFrom)
  return held.filter((h) => venueDayKey(h.heldFrom) === key)
}

/**
 * Whether a court is this holder's to use right now, and if not, one sentence
 * saying when it is. A court the holder has later today is not "out of action"
 * and saying so would be a lie; it is simply not theirs yet.
 */
export function courtStateAt(
  held: readonly HoldRow[],
  now: Date,
): { open: boolean; note: string | null } {
  const active = held.find((h) => h.heldFrom <= now && h.heldUntil > now)
  if (active) return { open: true, note: null }
  const next = held
    .filter((h) => h.heldFrom.getTime() > now.getTime())
    .sort((a, b) => a.heldFrom.getTime() - b.heldFrom.getTime())[0]
  if (next) return { open: false, note: `Yours from ${venueClock(next.heldFrom)}` }
  const last = held.length
    ? held.reduce((a, b) => (a.heldUntil >= b.heldUntil ? a : b))
    : null
  return { open: false, note: last ? `Your hours ended at ${venueClock(last.heldUntil)}` : 'Not held' }
}

/** Does this holder have this court at this moment? The gate every send-to-court needs. */
export async function holdsCourtAt(
  holder: Holder,
  courtId: string,
  at: Date,
  exec: { select: typeof db.select } = db,
  /** Inside a transaction: hold the row, so the hold cannot be released under us. */
  lock = false,
): Promise<boolean> {
  const q = exec
    .select({ id: courtHolds.id })
    .from(courtHolds)
    .where(
      and(
        eq(courtHolds.courtId, courtId),
        holder.kind === 'tournament'
          ? eq(courtHolds.tournamentId, holder.tournamentId)
          : eq(courtHolds.sessionId, holder.sessionId),
        lte(courtHolds.heldFrom, at),
        gt(courtHolds.heldUntil, at),
      ),
    )
    .limit(1)
  const [row] = await (lock ? q.for('share') : q)
  return !!row
}

/**
 * Who has these courts at one instant, exactly — not widened to the quarter-hour
 * grid the way `holdsBetween` is.
 *
 * The grid is right for "can I book this", because that is what the index will
 * enforce. It is wrong for "what is happening now", which is what a gate sign
 * and a live board say: widened, they name a holder whose hold ended ten minutes
 * ago.
 */
export async function holdsAtInstant(at: Date, courtIds?: string[]): Promise<HoldRow[]> {
  const rows = (await holdsFrom(db.select(holdSelect))
    .where(
      and(
        lte(courtHolds.heldFrom, at),
        gt(courtHolds.heldUntil, at),
        courtIds && courtIds.length ? inArray(courtHolds.courtId, courtIds) : undefined,
      ),
    )
    .orderBy(asc(courts.sortOrder), asc(courtHolds.heldFrom))) as RawHold[]
  return rows.map(toHold)
}

/** Who holds each court at a moment — one holder per court, by construction. */
export async function holdersAt(at: Date): Promise<Map<string, HoldRow>> {
  const byCourt = new Map<string, HoldRow>()
  for (const h of await holdsAtInstant(at)) if (!byCourt.has(h.courtId)) byCourt.set(h.courtId, h)
  return byCourt
}

export type Clash = { courtId: string; courtName: string; holderName: string; heldFrom: Date; heldUntil: Date }

/**
 * What stands in the way of holding these courts over these windows — read on
 * the same quarter-hour grid the index uses, so the answer here and the answer
 * the database gives cannot disagree about what counts as an overlap.
 */
export async function clashesFor(
  courtIds: string[],
  windows: ReadonlyArray<Window>,
  ignore?: Partial<Holder> & { tournamentId?: string; sessionId?: string },
  exec: { select: typeof db.select } = db,
): Promise<Clash[]> {
  if (!courtIds.length || !windows.length) return []
  const spans = windows.map((w) =>
    and(gte(courtHoldSlots.slotStart, slotFloor(w.from)), lte(courtHoldSlots.slotStart, lastSlot(w.until))),
  )
  const mine = ignore?.tournamentId
    ? or(isNull(courtHolds.tournamentId), ne(courtHolds.tournamentId, ignore.tournamentId))
    : ignore?.sessionId
      ? or(isNull(courtHolds.sessionId), ne(courtHolds.sessionId, ignore.sessionId))
      : undefined

  const rows = (await exec
    .select(holdSelect)
    .from(courtHoldSlots)
    .innerJoin(courtHolds, eq(courtHolds.id, courtHoldSlots.holdId))
    .innerJoin(courts, eq(courts.id, courtHoldSlots.courtId))
    .leftJoin(tournaments, eq(tournaments.id, courtHolds.tournamentId))
    .leftJoin(gameSessions, eq(gameSessions.id, courtHolds.sessionId))
    .where(and(inArray(courtHoldSlots.courtId, courtIds), or(...spans), mine))
    .orderBy(asc(courts.sortOrder), asc(courtHolds.heldFrom))) as RawHold[]

  const seen = new Set<string>()
  const out: Clash[] = []
  for (const r of rows) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    const h = toHold(r)
    out.push({
      courtId: h.courtId,
      courtName: h.courtName,
      holderName: h.holderName,
      heldFrom: h.heldFrom,
      heldUntil: h.heldUntil,
    })
  }
  return out
}

/**
 * What stands in the way of this holder taking these courts — asked the way
 * `setHolds` will actually write them, so the sentence on the screen and the
 * row in the table cannot disagree.
 *
 * A court the holder already has is asked about for the whole window; a court it
 * is taking up now is asked about from now, because that is all it will get.
 */
export async function clashesForHolder(
  holder: Holder | null,
  courtIds: string[],
  windows: ReadonlyArray<Window>,
  now: Date = new Date(),
): Promise<Clash[]> {
  const plan = await planHolds(db, holder, courtIds, windows, now)
  return clashesForPlan(holder, plan)
}

/**
 * Everything a save needs to know before it writes: what each court would be
 * held for, which courts cannot be given at all, and who is in the way.
 *
 * `unplaceable` is a court the holder does not already have and for which
 * nothing is left of the hours asked — the case that used to be reported as a
 * successful save of nothing.
 */
export async function planFor(
  holder: Holder | null,
  courtIds: string[],
  windows: ReadonlyArray<Window>,
  now: Date = new Date(),
): Promise<{ plan: Map<string, Window[]>; unplaceable: string[]; clashes: Clash[] }> {
  const wanted = [...new Set(courtIds.filter(Boolean))]
  const plan = await planHolds(db, holder, wanted, windows, now)
  const mine = new Set(holder ? (await courtsHeldBy(holder)).map((c) => c.id) : [])
  const unplaceable = wanted.filter((id) => !mine.has(id) && !(plan.get(id)?.length))
  const clashes = await clashesForPlan(holder, plan)
  return { plan, unplaceable, clashes }
}

/** "Court 1" / "Court 1 and Court 2" — for a sentence, not a list. */
export async function courtNames(courtIds: string[]): Promise<string> {
  if (!courtIds.length) return ''
  const rows = await db
    .select({ id: courts.id, name: courts.name, sortOrder: courts.sortOrder })
    .from(courts)
    .where(inArray(courts.id, courtIds))
    .orderBy(asc(courts.sortOrder))
  const names = rows.map((r) => r.name)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** The same question, when the plan has already been worked out. */
export async function clashesForPlan(holder: Holder | null, plan: Map<string, Window[]>): Promise<Clash[]> {
  const ignore = !holder
    ? undefined
    : holder.kind === 'tournament'
      ? { tournamentId: holder.tournamentId }
      : { sessionId: holder.sessionId }
  // Courts whose resolved windows are identical are asked about together; in
  // practice that is all of them, and it keeps this to one query.
  const groups = new Map<string, { windows: Window[]; courtIds: string[] }>()
  for (const [courtId, resolved] of plan) {
    if (!resolved.length) continue
    const key = resolved.map((w) => `${w.from.getTime()}-${w.until.getTime()}`).join('|')
    const group = groups.get(key)
    if (group) group.courtIds.push(courtId)
    else groups.set(key, { windows: resolved, courtIds: [courtId] })
  }
  const found = await Promise.all([...groups.values()].map((g) => clashesFor(g.courtIds, g.windows, ignore)))
  return found.flat()
}

// ───────────────────────────── writing ─────────────────────────────

type Extra = { reason?: string | null; createdByUserId?: string | null }

function holderColumns(holder: Holder) {
  return holder.kind === 'tournament'
    ? { kind: 'tournament' as const, tournamentId: holder.tournamentId, sessionId: null }
    : { kind: 'session' as const, sessionId: holder.sessionId, tournamentId: null }
}

function holderWhere(holder: Holder) {
  return holder.kind === 'tournament'
    ? eq(courtHolds.tournamentId, holder.tournamentId)
    : eq(courtHolds.sessionId, holder.sessionId)
}

/**
 * Where a holder can actually start on one court, given what it already has and
 * what the quarter-hour grid says is free.
 *
 * The single place this is decided. `clashesForHolder` asks the question with
 * it and `setHolds` writes the answer from it, so the sentence on the screen
 * and the row in the table cannot disagree about what is being taken — the one
 * failure that turns "Court 3 is free" into a refusal nobody caused.
 *
 * Three rules, in order:
 *  - a window that starts in the future is taken exactly as asked;
 *  - a window that starts in the past, on a court this holder is already on,
 *    keeps the start it already has — the tournament has been playing there
 *    since nine and nine is the truth;
 *  - otherwise it starts at the first quarter hour from now that nobody else
 *    owns. Not simply "now": a block that ended at 19:05 still owns the quarter
 *    hour it ended in, and starting there would be refused by the index with no
 *    way forward. Starting at 19:15 is the answer the venue wants.
 */
export function resolveWindows(
  asked: ReadonlyArray<Window>,
  had: ReadonlyArray<{ heldFrom: Date; heldUntil: Date }>,
  now: Date,
  takenSlots: ReadonlySet<number> = new Set(),
): Window[] {
  const out: Window[] = []
  for (const w of asked) {
    if (w.from.getTime() >= now.getTime()) {
      if (w.until.getTime() > w.from.getTime()) out.push(w)
      continue
    }
    // A window that is entirely over is not a window anybody is asking for.
    // If this holder was on the court then, its hold stands exactly as it is —
    // rewriting it would resurrect hours that `endHoldsAt` had truncated and
    // then refuse a court that is free right now because of yesterday
    // afternoon. If it was not, there is nothing to take.
    if (w.until.getTime() <= now.getTime()) {
      const over = had.find(
        (h) => h.heldFrom.getTime() < w.until.getTime() && h.heldUntil.getTime() > w.from.getTime(),
      )
      if (over) out.push({ from: over.heldFrom, until: over.heldUntil })
      continue
    }
    // The hold this holder already has covering the same stretch, if it has
    // begun. Matched by overlap, not by position: a two-day tournament's second
    // day must not be anchored to its first.
    const mine = had.find(
      (h) =>
        h.heldFrom.getTime() <= now.getTime() &&
        h.heldFrom.getTime() < w.until.getTime() &&
        h.heldUntil.getTime() > w.from.getTime(),
    )
    if (mine) {
      out.push({ from: mine.heldFrom, until: w.until })
      continue
    }
    let from = slotFloor(now).getTime()
    while (from < w.until.getTime() && takenSlots.has(from)) from += SLOT_MS
    if (from < w.until.getTime()) out.push({ from: new Date(from), until: w.until })
  }
  return out
}

const sameWindows = (a: ReadonlyArray<Window>, b: ReadonlyArray<{ heldFrom: Date; heldUntil: Date }>) => {
  const key = (f: Date, u: Date) => `${f.getTime()}-${u.getTime()}`
  const left = a.map((w) => key(w.from, w.until)).sort()
  const right = b.map((h) => key(h.heldFrom, h.heldUntil)).sort()
  return left.length === right.length && left.every((v, i) => v === right[i])
}

type HeldRow = { id: string; courtId: string; heldFrom: Date; heldUntil: Date }

/** Everything this holder has, by court. All of it: removals are worked out from it. */
async function heldByCourt(
  exec: { select: typeof db.select },
  holder: Holder | null,
): Promise<Map<string, HeldRow[]>> {
  if (!holder) return new Map()
  const rows = await exec
    .select({
      id: courtHolds.id,
      courtId: courtHolds.courtId,
      heldFrom: courtHolds.heldFrom,
      heldUntil: courtHolds.heldUntil,
    })
    .from(courtHolds)
    .where(holderWhere(holder))
  const out = new Map<string, HeldRow[]>()
  for (const r of rows) out.set(r.courtId, [...(out.get(r.courtId) ?? []), r])
  return out
}

/** Quarter hours somebody else already owns, per court, over a span. */
async function takenSlotsFor(
  exec: { select: typeof db.select },
  holder: Holder | null,
  courtIds: string[],
  from: Date,
  until: Date,
): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>()
  if (!courtIds.length || until.getTime() <= from.getTime()) return out
  const rows = await exec
    .select({ courtId: courtHoldSlots.courtId, slotStart: courtHoldSlots.slotStart })
    .from(courtHoldSlots)
    .innerJoin(courtHolds, eq(courtHolds.id, courtHoldSlots.holdId))
    .where(
      and(
        inArray(courtHoldSlots.courtId, courtIds),
        gte(courtHoldSlots.slotStart, slotFloor(from)),
        lte(courtHoldSlots.slotStart, lastSlot(until)),
        !holder
          ? undefined
          : holder.kind === 'tournament'
            ? or(isNull(courtHolds.tournamentId), ne(courtHolds.tournamentId, holder.tournamentId))
            : or(isNull(courtHolds.sessionId), ne(courtHolds.sessionId, holder.sessionId)),
      ),
    )
  for (const r of rows) {
    const set = out.get(r.courtId) ?? new Set<number>()
    set.add(r.slotStart.getTime())
    out.set(r.courtId, set)
  }
  return out
}

/**
 * What each of these courts would actually be held for. Empty windows for a
 * court mean there is nothing left of those hours to give it.
 */
export async function planHolds(
  exec: { select: typeof db.select },
  holder: Holder | null,
  courtIds: string[],
  windows: ReadonlyArray<Window>,
  now: Date,
): Promise<Map<string, Window[]>> {
  const wanted = [...new Set(courtIds.filter(Boolean))]
  const plan = new Map<string, Window[]>()
  if (!wanted.length || !windows.length) return plan

  // Only a window that reaches back before now needs the free-slot walk, and
  // only as far as that window runs — a fortnight-long tournament must not pull
  // a fortnight of slots to answer a question about this afternoon.
  const reachBack = windows.filter((w) => w.from.getTime() < now.getTime())
  const walkUntil = reachBack.length ? reachBack.reduce((a, w) => (a.until >= w.until ? a : w)).until : null
  const [had, taken] = await Promise.all([
    heldByCourt(exec, holder),
    walkUntil
      ? takenSlotsFor(exec, holder, wanted, slotFloor(now), walkUntil)
      : Promise.resolve(new Map<string, Set<number>>()),
  ])
  for (const courtId of wanted) {
    plan.set(courtId, resolveWindows(windows, had.get(courtId) ?? [], now, taken.get(courtId)))
  }
  return plan
}

/**
 * Make this holder's courts be exactly this list, over exactly these windows.
 *
 * What each court actually gets is `resolveWindows`, through `planHolds` — the
 * same function the check ran, so the two cannot disagree. Around it, three
 * rules about rows:
 *
 *  - a court whose resolved windows already match is not touched at all, so
 *    adding a fourth court at eleven does not rewrite the three that have been
 *    played on since nine;
 *  - a court with nothing resolvable keeps whatever it already has. Reading "no
 *    window" as "no hold" is what took every court off a game that was still
 *    being played on them;
 *  - a court taken off this holder loses only what it had not started, and is
 *    truncated where it is running — deleting that would say the game was
 *    played on no court at all.
 *
 * Returns the courts this holder ends up on. Throws `CourtTaken` if the index
 * refuses; the transaction is aborted by then, so the caller must catch it
 * outside.
 */
export async function setHolds(
  tx: Tx,
  holder: Holder,
  courtIds: string[],
  windows: ReadonlyArray<Window>,
  extra: Extra = {},
  now: Date = new Date(),
): Promise<string[]> {
  const wanted = [...new Set(courtIds.filter(Boolean))]
  const byCourt = await heldByCourt(tx, holder)
  const plan = await planHolds(tx, holder, wanted, windows, now)

  // A court taken off this holder: anything it had not started goes, and
  // anything it is on right now is truncated rather than deleted. Deleting it
  // would say the game was played on no court at all — the same care
  // `endHoldsAt` takes, for the same reason.
  const removed = [...byCourt.entries()].filter(([courtId]) => !wanted.includes(courtId))
  const drop: string[] = removed.flatMap(([, hs]) =>
    hs.filter((h) => h.heldFrom.getTime() >= now.getTime()).map((h) => h.id),
  )
  const cutShort: string[] = removed.flatMap(([, hs]) =>
    hs.filter((h) => h.heldFrom.getTime() < now.getTime() && h.heldUntil.getTime() > now.getTime()).map((h) => h.id),
  )
  const add: Array<{ courtId: string; window: Window }> = []
  const held: string[] = []

  for (const courtId of wanted) {
    const had = byCourt.get(courtId) ?? []
    const desired = plan.get(courtId) ?? []
    // Nothing left of those hours to give this court. Leaving what it already
    // has alone is the only safe answer: treating "no window" as "no hold"
    // took every court off a game that was still being played on them.
    if (!desired.length) {
      if (had.length) held.push(courtId)
      continue
    }
    held.push(courtId)
    // Already exactly right: leave the rows alone rather than churn the slots.
    if (had.length && sameWindows(desired, had)) continue
    drop.push(...had.map((h) => h.id))
    for (const w of desired) add.push({ courtId, window: w })
  }

  if (drop.length) await tx.delete(courtHolds).where(inArray(courtHolds.id, drop))
  if (cutShort.length) {
    const edge = slotFloor(now)
    await tx
      .update(courtHolds)
      .set({
        heldUntil: sql`greatest(${edge}::timestamptz, date_bin(interval '15 minutes', ${courtHolds.heldFrom}, timestamptz '2000-01-01 00:00:00+00') + interval '15 minutes')`,
        releasedAt: now,
        updatedAt: now,
      })
      .where(inArray(courtHolds.id, cutShort))
  }
  if (add.length) {
    // Sorted by court, then by start. Two hosts saving the same two courts in
    // opposite checkbox order took the slot locks in opposite order and
    // deadlocked — a 40P01, which is not a clash and has no sentence. The
    // trigger's own SELECT is ordered to match (migration 0007).
    add.sort((a, b) =>
      a.courtId === b.courtId
        ? a.window.from.getTime() - b.window.from.getTime()
        : a.courtId < b.courtId
          ? -1
          : 1,
    )
    try {
      await tx.insert(courtHolds).values(
        add.map(({ courtId, window }) => ({
          id: newId('ch'),
          courtId,
          ...holderColumns(holder),
          reason: extra.reason ?? null,
          heldFrom: window.from,
          heldUntil: window.until,
          createdByUserId: extra.createdByUserId ?? null,
        })),
      )
    } catch (e) {
      if (isCourtClash(e)) throw new CourtTaken()
      throw e
    }
  }
  return held
}

/** Let go of everything a holder has. Used when it is deleted outright. */
export async function releaseHolds(tx: Tx, holder: Holder) {
  await tx.delete(courtHolds).where(holderWhere(holder))
}

/**
 * The holder finished. Courts it still has go back to the venue at `at`:
 * anything not yet started is dropped, anything running is truncated.
 *
 * This is the fiction the old model could not tell the truth about — a finished
 * tournament's rows stayed put and the picker pretended otherwise, so the
 * evening's organiser got a constraint error instead of a court.
 */
export async function endHoldsAt(tx: Tx, holder: Holder, at: Date) {
  // Rounded DOWN to the quarter hour it ended in, so the hold it leaves behind
  // does not own the quarter hour the next holder starts in. Rounding the other
  // way cost the venue fifteen minutes of a court at the exact moment somebody
  // wanted it — the tournament finished at 19:05 and the seven-fifteen could
  // not have the court until 19:15.
  const edge = slotFloor(at)
  // Anything that had not started yet goes outright.
  await tx.delete(courtHolds).where(and(holderWhere(holder), gte(courtHolds.heldFrom, at)))
  // The rest is truncated — but never below the END of the quarter hour it
  // began in. A game that started at 19:02 and ended at 19:10 did use
  // 19:00–19:15; deleting the row would have said it was played on no court at
  // all, and truncating below its own start is not a row Postgres will keep.
  await tx
    .update(courtHolds)
    .set({
      heldUntil: sql`greatest(${edge}::timestamptz, date_bin(interval '15 minutes', ${courtHolds.heldFrom}, timestamptz '2000-01-01 00:00:00+00') + interval '15 minutes')`,
      releasedAt: at,
      updatedAt: new Date(),
    })
    .where(and(holderWhere(holder), lt(courtHolds.heldFrom, at), gt(courtHolds.heldUntil, edge)))
}

/** Out of action: coaching, maintenance, a private booking, a broken net. */
export async function blockCourt(input: {
  courtId: string
  reason: string
  from: Date
  until: Date
  createdByUserId?: string
  now?: Date
}) {
  const reason = input.reason.trim()
  if (!reason) return { ok: false as const, error: 'Say what the court is out for — “Coaching” is enough.' }
  if (input.until.getTime() <= input.from.getTime()) {
    return { ok: false as const, error: 'The end has to come after the start.' }
  }
  const now = input.now ?? new Date()
  if (input.until.getTime() <= now.getTime()) {
    return {
      ok: false as const,
      error: 'Those hours have already gone. A court can only be taken out from now on.',
    }
  }

  const clashes = await clashesFor([input.courtId], [{ from: input.from, until: input.until }])
  if (clashes.length) {
    // Not `clashSentence`: that one says "pick another court, or another time",
    // which is the right advice for a booking and useless advice for a broken
    // net. The court is the court and the time is now; what has to move is what
    // is on it.
    const c = clashes[0]
    return {
      ok: false as const,
      error: `${c.courtName} has ${c.holderName} on it until ${venueClock(c.heldUntil)}. Move or finish that first, then take the court out.`,
    }
  }

  const id = newId('ch')
  try {
    await transact(async (tx) => {
      await tx.insert(courtHolds).values({
        id,
        courtId: input.courtId,
        kind: 'block',
        reason,
        heldFrom: input.from,
        heldUntil: input.until,
        createdByUserId: input.createdByUserId ?? null,
      })
    })
    return { ok: true as const, id }
  } catch (e) {
    if (isCourtClash(e)) return { ok: false as const, error: takenNow }
    if (isWriteConflict(e)) return { ok: false as const, error: savedAtOnce }
    throw e
  }
}

/** Give a blocked court back. Only a block: a tournament lets go by finishing. */
export async function unblockCourt(holdId: string, now: Date = new Date()) {
  // Only a block that is still on. A block that ended this afternoon is the
  // record of an afternoon the court was out, and deleting it would erase that
  // — the button does not appear for one, and this is the same rule at the
  // write, where a stale screen arrives.
  const rows = await transact((tx) =>
    tx
      .delete(courtHolds)
      .where(and(eq(courtHolds.id, holdId), eq(courtHolds.kind, 'block'), gt(courtHolds.heldUntil, now)))
      .returning({ id: courtHolds.id }),
  )
  if (!rows.length) return { ok: false as const, error: 'That block has already gone.' }
  return { ok: true as const }
}

export const takenNow = 'Somebody took that court a moment before you did. Look again and pick another.'

export const savedAtOnce = 'Two people saved at once. Nothing was changed — try again.'

/**
 * A serialization failure or a deadlock: not a clash, not a bug, and not
 * something to show an organiser a stack trace for. Nothing was written, so the
 * honest answer is "try again" rather than a 500.
 */
export function isWriteConflict(e: unknown): boolean {
  let err = e as { code?: string; cause?: unknown } | null
  for (let depth = 0; err && depth < 6; depth++) {
    if (err.code === '40001' || err.code === '40P01') return true
    err = err.cause as typeof err
  }
  return false
}

/** "Court 1 belongs to Men's Doubles from 1:00 pm to 3:00 pm." */
export function clashSentence(c: Clash): string {
  return `${c.courtName} belongs to ${c.holderName} from ${venueClock(c.heldFrom)} to ${venueClock(c.heldUntil)}. Pick another court, or another time.`
}

/**
 * "3:00 pm" in venue time — the shared way this app says a time in a sentence,
 * re-exported under the name the court screens already call it.
 */
export function hoursLabelFor(d: Date): string {
  return venueClock(d)
}

// ───────────────────────────── the day ─────────────────────────────

export type CourtDayRow = {
  court: { id: string; name: string; colorKey: string }
  holds: HoldRow[]
  /** Gaps of at least one slot, in venue time, between `open` and `close`. */
  free: Window[]
}

/**
 * Every court's day: what is on it and what is left. This is the free-slot view
 * — for a booked game, when a court is free *is* the product.
 */
export async function courtDay(dayKey: string, venueId: string): Promise<CourtDayRow[]> {
  const from = dayStart(dayKey)
  const until = dayEnd(dayKey)
  const [allCourts, held] = await Promise.all([
    db
      .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
      .from(courts)
      .where(and(eq(courts.venueId, venueId), eq(courts.active, true)))
      .orderBy(asc(courts.sortOrder)),
    holdsBetween(from, until),
  ])

  return allCourts.map((court) => {
    const mine = held.filter((h) => h.courtId === court.id)
    return { court, holds: mine, free: gaps(mine, from, until) }
  })
}

/** The parts of `[from, until)` no hold covers, merged and in order. */
export function gaps(holds: ReadonlyArray<{ heldFrom: Date; heldUntil: Date }>, from: Date, until: Date): Window[] {
  // Each hold is widened to the quarter hours it actually occupies before the
  // gaps are worked out, so a gap this offers is a gap the index will give you.
  // A hold of 19:05–19:10 leaves 19:00–19:15 unusable, and saying otherwise is
  // how a screen promises a court it cannot deliver.
  const busy = holds
    .map((h) => ({
      from: Math.max(slotFloor(h.heldFrom).getTime(), from.getTime()),
      until: Math.min(lastSlot(h.heldUntil).getTime() + SLOT_MS, until.getTime()),
    }))
    .filter((b) => b.until > b.from)
    .sort((a, b) => a.from - b.from)

  const out: Window[] = []
  let at = from.getTime()
  for (const b of busy) {
    if (b.from > at) out.push({ from: new Date(at), until: new Date(b.from) })
    at = Math.max(at, b.until)
  }
  if (at < until.getTime()) out.push({ from: new Date(at), until })
  return out
}

/** Which of these courts are free for the whole of `[from, until)`. */
export async function freeCourtsBetween(from: Date, until: Date, venueId: string) {
  const [allCourts, clashes] = await Promise.all([
    db
      .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
      .from(courts)
      .where(and(eq(courts.venueId, venueId), eq(courts.active, true)))
      .orderBy(asc(courts.sortOrder)),
    holdsBetween(from, until),
  ])
  const taken = new Map<string, HoldRow>()
  for (const h of clashes) if (!taken.has(h.courtId)) taken.set(h.courtId, h)
  return allCourts.map((c) => ({ ...c, takenBy: taken.get(c.id) ?? null }))
}

/** Keep `game_sessions.court_count` honest — it is shown, never trusted. */
export async function syncSessionCourtCount(tx: Tx, sessionId: string) {
  await tx
    .update(gameSessions)
    .set({
      courtCount: sql`(select count(distinct court_id)::int from ${courtHolds} where session_id = ${sessionId})`,
      updatedAt: new Date(),
    })
    .where(eq(gameSessions.id, sessionId))
}

export { transact }
