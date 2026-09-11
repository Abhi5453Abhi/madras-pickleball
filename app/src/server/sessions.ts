import 'server-only'
import { and, asc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { db, transact, type Tx } from '@/db'
import { gameSessions, players, sessionParticipants, sessionScheduledActions } from '@/db/schema'
import { recordAudit } from '@/lib/audit'
import { randomBytes } from 'node:crypto'
import { hashIp } from '@/lib/crypto'
import { newId } from '@/lib/ids'
import { looksLikeSamePerson, normalizeName, normalizePhone } from '@/lib/parse-players'
import {
  boundariesFor,
  gatePhase,
  lockAtFor,
  DEFAULT_SESSION_POLICY,
  SESSION_POLICY_VERSION,
} from '@/lib/daily-clock'
import { bumpSessionVersion } from '@/lib/stream'
import { checkSpotLookupAllowed, recordTokenAttempt } from '@/lib/rate-limit'
import { getVenue } from './tournaments'

/**
 * Daily games — the domain.
 *
 * A session is its own aggregate, not a tournament with a `kind` column;
 * docs/ADR-daily-games.md decision 1 has the argument and what it costs.
 *
 * Two rules run through everything here:
 *
 *  1. **Capacity is the database's job.** Every seated participation holds a
 *     `seat_no`, and `session_participants_seat_uq` refuses a second claim on
 *     the same seat. The `for update` on the session row below is what orders
 *     two joins; the index is what makes a forgotten lock an error instead of a
 *     seventeenth player. Neither is enough on its own.
 *  2. **Nothing here runs on a page render.** Every function in this file is
 *     reached from an explicit command or from the reconciler. A GET that gives
 *     someone's spot away is the same bug as a GET that takes their money.
 */

const OCCUPYING = ['joined', 'confirmed', 'checked_in', 'played', 'absent'] as const
/** Everything that is not `withdrawn` — one of these per player per session. */
const LIVE = [...OCCUPYING, 'waitlisted'] as const

type ParticipationState = (typeof LIVE)[number] | 'withdrawn'

/**
 * A fresh capability for one spot: 160 random bits, URL-safe.
 *
 * Drawn, not derived. A value computed from the row's own id would be
 * reproducible by anybody who ever saw that id, could not be rotated if a link
 * leaked, and would silently invalidate every live link the day somebody set
 * the secret it was salted with. `session_participants.manage_token` carries the
 * reasoning for storing it as it is rather than hashed.
 */
function newSpotToken(): string {
  return randomBytes(20).toString('base64url')
}

export type SessionRow = typeof gameSessions.$inferSelect
export type ParticipantRow = typeof sessionParticipants.$inferSelect

/** ₹1,00,000 a head. Far beyond any real session, and well inside an int4. */
export const MAX_PRICE_PAISE = 10_000_000

export type Fail = { ok: false; error: string }
const fail = (error: string): Fail => ({ ok: false, error })

// ───────────────────────────── reading ─────────────────────────────

function slugify(title: string, startsAt: Date) {
  const base = normalizeName(title).replace(/\s+/g, '-').slice(0, 32) || 'game'
  const day = startsAt.toISOString().slice(5, 10).replace('-', '')
  return `${base}-${day}-${Math.random().toString(36).slice(2, 6)}`
}

export async function getSessionBySlug(slug: string): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(gameSessions)
    .where(and(eq(gameSessions.slug, slug), isNull(gameSessions.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

export async function getSession(id: string): Promise<SessionRow | null> {
  const rows = await db
    .select()
    .from(gameSessions)
    .where(and(eq(gameSessions.id, id), isNull(gameSessions.deletedAt)))
    .limit(1)
  return rows[0] ?? null
}

export type RosterEntry = {
  id: string
  playerId: string
  payerPlayerId: string
  invitedByPlayerId: string | null
  name: string
  /** The roster name, which may since have been corrected on the player row. */
  currentName: string
  phone: string | null
  state: ParticipationState
  seq: number
  seatNo: number | null
  isGuest: boolean
  source: 'self' | 'host'
  hideFromPublic: boolean
  joinedAt: Date
  confirmedAt: Date | null
  promotedAt: Date | null
  checkedInAt: Date | null
  withdrawnAt: Date | null
  withdrawnBy: string | null
  withdrawReason: string | null
  /** The player's own capability URL is /s/<token>. Never leaves an admin screen. */
  token: string
}

/**
 * Everyone attached to this session, arrival order. Includes withdrawals —
 * the host's screen needs to show that someone dropped out, and the history is
 * append-only.
 */
export async function roster(sessionId: string): Promise<RosterEntry[]> {
  const rows = await db
    .select({
      id: sessionParticipants.id,
      playerId: sessionParticipants.playerId,
      payerPlayerId: sessionParticipants.payerPlayerId,
      invitedByPlayerId: sessionParticipants.invitedByPlayerId,
      name: sessionParticipants.displayName,
      currentName: players.name,
      phone: players.phone,
      state: sessionParticipants.state,
      seq: sessionParticipants.seq,
      seatNo: sessionParticipants.seatNo,
      isGuest: sessionParticipants.isGuest,
      source: sessionParticipants.source,
      hideFromPublic: sessionParticipants.hideFromPublic,
      joinedAt: sessionParticipants.joinedAt,
      confirmedAt: sessionParticipants.confirmedAt,
      promotedAt: sessionParticipants.promotedAt,
      checkedInAt: sessionParticipants.checkedInAt,
      withdrawnAt: sessionParticipants.withdrawnAt,
      withdrawnBy: sessionParticipants.withdrawnBy,
      withdrawReason: sessionParticipants.withdrawReason,
      token: sessionParticipants.manageToken,
    })
    .from(sessionParticipants)
    .innerJoin(players, eq(players.id, sessionParticipants.playerId))
    .where(eq(sessionParticipants.sessionId, sessionId))
    .orderBy(asc(sessionParticipants.seq))
  return rows as RosterEntry[]
}

export type SessionCounts = { taken: number; waiting: number; confirmed: number; unconfirmed: number; here: number }

export function countRoster(entries: readonly RosterEntry[]): SessionCounts {
  let taken = 0
  let waiting = 0
  let confirmed = 0
  let unconfirmed = 0
  let here = 0
  for (const e of entries) {
    if (e.state === 'waitlisted') waiting++
    else if (e.state !== 'withdrawn') {
      taken++
      if (e.state === 'joined') unconfirmed++
      if (e.state === 'confirmed' || e.state === 'checked_in' || e.state === 'played') confirmed++
      if (e.state === 'checked_in' || e.state === 'played') here++
    }
  }
  return { taken, waiting, confirmed, unconfirmed, here }
}

/** Upcoming and in-progress sessions, soonest first. */
export async function upcomingSessions(from: Date = new Date(), limit = 30) {
  return db
    .select()
    .from(gameSessions)
    .where(
      and(
        isNull(gameSessions.deletedAt),
        inArray(gameSessions.status, ['open', 'live']),
        gte(gameSessions.autoEndAt, from),
      ),
    )
    .orderBy(asc(gameSessions.startsAt))
    .limit(limit)
}

/** Everything the host's list needs, including drafts and finished games. */
export async function allSessions(limit = 60) {
  return db
    .select()
    .from(gameSessions)
    .where(isNull(gameSessions.deletedAt))
    .orderBy(sql`${gameSessions.startsAt} desc`)
    .limit(limit)
}

// ───────────────────────────── creating ─────────────────────────────

export type CreateSessionInput = {
  title: string
  startsAt: Date
  endsAt: Date
  pricePaise: number
  capacity: number
  courtCount: number
  kind?: 'open_play' | 'booked'
  confirmationGate?: boolean
  notes?: string | null
}

export type CreateResult = { ok: true; session: SessionRow } | Fail

/**
 * `price_paise` is a 32-bit integer column. Without a ceiling, a mistyped price
 * reaches the database as `integer out of range` — a 500 rather than a sentence.
 */
function checkPrice(paise: number): Fail | null {
  if (!Number.isInteger(paise) || paise < 0) return fail('That price isn’t money — a number of rupees, like 300.')
  if (paise > MAX_PRICE_PAISE) return fail('That price is too high — ₹1,00,000 a head is the most.')
  return null
}

export async function createSession(
  input: CreateSessionInput,
  actor: { id: string; username: string },
  now: Date = new Date(),
): Promise<CreateResult> {
  const title = input.title.trim()
  if (title.length < 2) return fail('Give the game a name.')
  if (title.length > 80) return fail('That name is too long — eighty characters is the most.')
  if (!(input.startsAt instanceof Date) || Number.isNaN(input.startsAt.getTime())) return fail('That start time isn’t a time.')
  if (!(input.endsAt instanceof Date) || Number.isNaN(input.endsAt.getTime())) return fail('That finish time isn’t a time.')
  if (input.endsAt <= input.startsAt) return fail('It has to finish after it starts.')
  if (input.endsAt.getTime() - input.startsAt.getTime() > 12 * 3600_000) return fail('Twelve hours is the longest a game can run.')
  const price = checkPrice(input.pricePaise)
  if (price) return price
  if (!Number.isInteger(input.capacity) || input.capacity < 1 || input.capacity > 200) return fail('Spots have to be between 1 and 200.')
  if (!Number.isInteger(input.courtCount) || input.courtCount < 0 || input.courtCount > 50) {
    return fail('Courts have to be between 0 and 50.')
  }

  const venue = await getVenue()
  const bounds = boundariesFor(input.startsAt, input.endsAt, DEFAULT_SESSION_POLICY, now)

  const [row] = await db
    .insert(gameSessions)
    .values({
      id: newId('gs'),
      venueId: venue.id,
      slug: slugify(title, input.startsAt),
      title,
      kind: input.kind ?? 'open_play',
      status: 'draft',
      startsAt: input.startsAt,
      endsAt: input.endsAt,
      pricePaise: input.pricePaise,
      capacity: input.capacity,
      courtCount: input.courtCount,
      confirmationGate: input.confirmationGate ?? true,
      confirmOpensAt: bounds.confirmOpensAt,
      confirmDeadlineAt: bounds.confirmDeadlineAt,
      autoEndAt: bounds.autoEndAt,
      policyVersion: SESSION_POLICY_VERSION,
      notes: input.notes?.trim() || null,
      createdByUserId: actor.id,
    })
    .returning()

  await recordAudit({
    userId: actor.id,
    actorLabel: actor.username,
    action: 'session.created',
    entity: 'game_session',
    entityId: row.id,
    after: { title, startsAt: input.startsAt, capacity: input.capacity, pricePaise: input.pricePaise },
  })
  return { ok: true, session: row }
}

// ─────────────────────── lifecycle transitions ───────────────────────

/**
 * Every transition re-asserts its own pre-state in the WHERE clause and uses
 * `.returning()` as the test, so two hosts tapping at once cannot both win and
 * an illegal transition is "that already happened" rather than a wrong row.
 */
async function transition(
  sessionId: string,
  from: readonly SessionRow['status'][],
  set: Partial<typeof gameSessions.$inferInsert>,
): Promise<boolean> {
  return transact(async (tx) => {
    const rows = await tx
      .update(gameSessions)
      .set({ ...set, updatedAt: new Date() })
      .where(and(eq(gameSessions.id, sessionId), inArray(gameSessions.status, [...from])))
      .returning({ id: gameSessions.id })
    if (rows.length) await bumpSessionVersion(sessionId, tx)
    return rows.length > 0
  })
}

export async function publishSession(sessionId: string, actor: { id: string; username: string }) {
  const ok = await transition(sessionId, ['draft'], { status: 'open', publishedAt: new Date() })
  if (!ok) return fail('That game is already published, or it has finished. Nothing changed.')
  await recordAudit({ userId: actor.id, actorLabel: actor.username, action: 'session.published', entity: 'game_session', entityId: sessionId })
  return { ok: true as const }
}

export async function startSession(sessionId: string, actor: { id: string; username: string }) {
  const ok = await transition(sessionId, ['open'], { status: 'live', startedAt: new Date() })
  if (!ok) return fail('That game isn’t open yet — publish it first. Nothing changed.')
  await recordAudit({ userId: actor.id, actorLabel: actor.username, action: 'session.started', entity: 'game_session', entityId: sessionId })
  return { ok: true as const }
}

/**
 * The host taps "that's it". Attendance stays editable until the session locks
 * — moving a dispute to before the money moves is the cheapest dispute handling
 * there is.
 */
export async function endSession(sessionId: string, actor: { id: string; username: string }, now: Date = new Date()) {
  const ok = await transition(sessionId, ['open', 'live'], {
    status: 'ended',
    endedAt: now,
    endedByUserId: actor.id,
    lockAt: lockAtFor(now),
  })
  if (!ok) return fail('That game has already finished.')
  await recordAudit({ userId: actor.id, actorLabel: actor.username, action: 'session.ended', entity: 'game_session', entityId: sessionId })
  return { ok: true as const }
}

export async function cancelSession(sessionId: string, reason: string, actor: { id: string; username: string }) {
  const ok = await transition(sessionId, ['draft', 'open', 'live'], {
    status: 'cancelled',
    cancelledAt: new Date(),
    cancelReason: reason.trim().slice(0, 200) || null,
  })
  if (!ok) return fail('That game has finished — it can’t be called off now.')
  await recordAudit({
    userId: actor.id,
    actorLabel: actor.username,
    action: 'session.cancelled',
    entity: 'game_session',
    entityId: sessionId,
    reason: reason.trim().slice(0, 200) || null,
  })
  return { ok: true as const }
}

/**
 * Freeze the night. `checked_in` becomes `played`; anyone who held a spot and
 * was never ticked off becomes `absent`, which produces **no** session charge
 * when stage 3 arrives — they did not play, so they do not owe the session fee.
 * Anyone still on the waitlist never got a spot and is withdrawn.
 *
 * If the host did nothing all night, nobody is charged. Failing to charge is
 * recoverable; wrongly charging sixteen people is not.
 */
export async function lockSessionAttendance(sessionId: string, tx: Tx, now: Date = new Date()) {
  const rows = await tx
    .update(gameSessions)
    .set({ status: 'locked', lockedAt: now, updatedAt: now })
    .where(and(eq(gameSessions.id, sessionId), eq(gameSessions.status, 'ended')))
    .returning({ id: gameSessions.id })
  if (!rows.length) return { locked: false as const, played: 0, absent: 0 }

  const played = await tx
    .update(sessionParticipants)
    .set({ state: 'played', attendanceMarkedAt: now, version: sql`${sessionParticipants.version} + 1`, updatedAt: now })
    .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.state, 'checked_in')))
    .returning({ id: sessionParticipants.id })

  const absent = await tx
    .update(sessionParticipants)
    .set({ state: 'absent', attendanceMarkedAt: now, version: sql`${sessionParticipants.version} + 1`, updatedAt: now })
    .where(
      and(eq(sessionParticipants.sessionId, sessionId), inArray(sessionParticipants.state, ['joined', 'confirmed'])),
    )
    .returning({ id: sessionParticipants.id })

  await tx
    .update(sessionParticipants)
    .set({
      state: 'withdrawn',
      seatNo: null,
      withdrawnAt: now,
      withdrawnBy: 'system',
      withdrawReason: 'never got a spot',
      version: sql`${sessionParticipants.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(sessionParticipants.sessionId, sessionId), eq(sessionParticipants.state, 'waitlisted')))

  await bumpSessionVersion(sessionId, tx)
  return { locked: true as const, played: played.length, absent: absent.length }
}

// ─────────────────────────── seats & waitlist ───────────────────────────

async function seatMapFor(tx: Tx, sessionId: string) {
  const rows = await tx
    .select({ seatNo: sessionParticipants.seatNo })
    .from(sessionParticipants)
    .where(and(eq(sessionParticipants.sessionId, sessionId), inArray(sessionParticipants.state, [...OCCUPYING])))
  return new Set<number>(rows.map((r) => r.seatNo).filter((n): n is number => n !== null))
}

function freeSeats(taken: ReadonlySet<number>, capacity: number): number[] {
  const free: number[] = []
  for (let n = 1; n <= capacity; n++) if (!taken.has(n)) free.push(n)
  return free
}

/**
 * Renumber the seats in use onto 1..n, in arrival order.
 *
 * In two statements, via an offset, and that is not belt and braces: a single
 * renumbering UPDATE raises `duplicate key ... session_participants_seat_uq`
 * the moment the new numbering swaps two rows — seq 1 holding seat 2 and seq 2
 * holding seat 1 is enough, and recycled seats produce exactly that. Postgres
 * checks a plain unique index per row, not at the end of the statement.
 *
 * Always called under the session row lock.
 */
const SEAT_SHUFFLE_OFFSET = 100_000

async function compactSeats(tx: Tx, sessionId: string) {
  const held = await tx
    .select({ id: sessionParticipants.id, seq: sessionParticipants.seq, seatNo: sessionParticipants.seatNo })
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        inArray(sessionParticipants.state, [...OCCUPYING]),
      ),
    )
    .orderBy(asc(sessionParticipants.seq))

  const wanted = held.map((h, i) => ({ id: h.id, seat: i + 1, was: h.seatNo }))
  if (wanted.every((w) => w.seat === w.was)) return

  await tx
    .update(sessionParticipants)
    .set({ seatNo: sql`${sessionParticipants.seatNo} + ${SEAT_SHUFFLE_OFFSET}` })
    .where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        inArray(sessionParticipants.state, [...OCCUPYING]),
      ),
    )
  for (const w of wanted) {
    await tx.update(sessionParticipants).set({ seatNo: w.seat }).where(eq(sessionParticipants.id, w.id))
  }
}

async function nextSeq(tx: Tx, sessionId: string) {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(max(${sessionParticipants.seq}), 0) + 1` })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.sessionId, sessionId))
  return Number(row?.n ?? 1)
}

/**
 * Fill whatever seats are free from the front of the waitlist.
 *
 * Always called inside the transaction that freed the seat, under the session
 * row lock, so a spot can never be given to two people. Promotion sets
 * `confirmed` once the confirmation window has opened and `joined` before it —
 * promoting to `joined` after the deadline would have the very next tick
 * withdraw them, and promoting to `confirmed` before the window opens would
 * skip the gate entirely.
 */
async function promoteWaitlist(tx: Tx, session: SessionRow, now: Date) {
  const taken = await seatMapFor(tx, session.id)
  const free = freeSeats(taken, session.capacity)
  if (free.length === 0) return [] as { id: string; playerId: string; name: string; state: 'joined' | 'confirmed' }[]

  const waiting = await tx
    .select()
    .from(sessionParticipants)
    .where(and(eq(sessionParticipants.sessionId, session.id), eq(sessionParticipants.state, 'waitlisted')))
    .orderBy(asc(sessionParticipants.seq))
    .limit(free.length)

  const phase = gatePhase(session, now)
  const target: 'joined' | 'confirmed' = phase === 'before' ? 'joined' : 'confirmed'

  const promoted: { id: string; playerId: string; name: string; state: 'joined' | 'confirmed' }[] = []
  for (let i = 0; i < waiting.length; i++) {
    const w = waiting[i]
    const done = await tx
      .update(sessionParticipants)
      .set({
        state: target,
        seatNo: free[i],
        promotedAt: now,
        confirmedAt: target === 'confirmed' ? now : null,
        version: sql`${sessionParticipants.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(sessionParticipants.id, w.id), eq(sessionParticipants.state, 'waitlisted')))
      .returning({ id: sessionParticipants.id })
    if (done.length) promoted.push({ id: w.id, playerId: w.playerId, name: w.displayName, state: target })
  }
  return promoted
}

/**
 * Somebody on the waitlist who has turned up anyway.
 *
 * They take the first free seat, or the soft cap opens by one — the same
 * reasoning as a fresh walk-in: they are standing in front of the host, and a
 * screen that says "waiting" about somebody who is about to play is lying.
 * Returns null if they were not waitlisted after all, so the caller falls back.
 */
async function seatAWaitingPlayer(tx: Tx, session: SessionRow, p: ParticipantRow, now: Date) {
  const taken = await seatMapFor(tx, session.id)
  let capacity = session.capacity
  let seat = freeSeats(taken, capacity)[0] ?? null
  if (seat === null) {
    if (capacity >= 200) return null
    capacity += 1
    await tx.update(gameSessions).set({ capacity, updatedAt: now }).where(eq(gameSessions.id, session.id))
    seat = freeSeats(taken, capacity)[0] ?? null
    // Every other path that moves the cap writes a row; this one pushes it past
    // what the host set, and can do it repeatedly.
    await recordAudit(
      {
        actorLabel: 'host',
        action: 'session.capacity.waitlist',
        entity: 'game_session',
        entityId: session.id,
        reason: 'somebody waiting was put in and the list was full',
        after: { capacity },
      },
      tx,
    )
  }
  if (seat === null) return null

  const done = await tx
    .update(sessionParticipants)
    .set({
      state: 'checked_in',
      seatNo: seat,
      promotedAt: now,
      confirmedAt: p.confirmedAt ?? now,
      checkedInAt: now,
      version: sql`${sessionParticipants.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(sessionParticipants.id, p.id), eq(sessionParticipants.state, 'waitlisted')))
    .returning({ id: sessionParticipants.id })
  if (!done.length) return null

  await bumpSessionVersion(session.id, tx)
  return {
    ok: true as const,
    alreadyIn: false,
    participantId: p.id,
    playerId: p.playerId,
    state: 'checked_in' as ParticipationState,
    seatNo: seat,
    waiting: false,
    token: p.manageToken,
    flagged: null,
    openedASpot: capacity !== session.capacity,
  }
}

// ───────────────────────────── joining ─────────────────────────────

type ResolvedPlayer = {
  playerId: string
  created: boolean
  name: string
  /** Somebody on this list whose name looks like it, for the host to judge. */
  flagged: { playerId: string; name: string } | null
  /** A player with exactly this name is already on this list. */
  duplicateOnList: boolean
  /** It matched somebody already in the venue's book rather than making a new one. */
  matchedExisting: boolean
}

/**
 * Who this is in the venue's book of players.
 *
 * The same ladder `registration.ts:290` already climbs, and for the same
 * reasons: a phone number is the strong key, but the same number under a
 * different name is never silently turned into last month's name — anyone with
 * the public link could otherwise learn who a number belongs to.
 *
 * A bare name — which only the host can submit, because the public form
 * requires a phone — matches a same-name player already in the venue's book,
 * phone or no phone. That is the host being the router and it is deliberate:
 * they are looking at the person. `duplicateOnList` comes back when somebody of
 * exactly that name is already on THIS list, because then the host is the only
 * one who can say whether it is a second Priya or a second tap.
 */
async function resolvePlayer(
  tx: Tx,
  sessionId: string,
  name: string,
  phoneKey: string | null,
  phoneRaw: string | null,
): Promise<ResolvedPlayer> {
  const nameKey = normalizeName(name)

  const already = await tx
    .select({ playerId: sessionParticipants.playerId, name: sessionParticipants.displayName })
    .from(sessionParticipants)
    .where(and(eq(sessionParticipants.sessionId, sessionId), inArray(sessionParticipants.state, [...LIVE])))
  const inSession = new Set(already.map((r) => r.playerId))
  const flagged =
    already.find((r) => looksLikeSamePerson(normalizeName(r.name), nameKey) && normalizeName(r.name) !== nameKey) ?? null

  let playerId: string | null = null
  let phoneTaken = false

  if (phoneKey) {
    const [byPhone] = await tx
      .select({ id: players.id, name: players.name })
      .from(players)
      .where(and(eq(players.phoneKey, phoneKey), isNull(players.deletedAt)))
      .limit(1)
    if (byPhone) {
      if (normalizeName(byPhone.name) === nameKey) playerId = byPhone.id
      else phoneTaken = true
    }
  }

  if (!playerId) {
    const sameName = await tx
      .select({ id: players.id, phoneKey: players.phoneKey })
      .from(players)
      .where(and(eq(players.nameKey, nameKey), isNull(players.deletedAt)))
      .orderBy(asc(players.createdAt))
    playerId = sameName.find((p) => !inSession.has(p.id) && (!phoneKey || !p.phoneKey))?.id ?? null
  }

  const duplicateOnList = already.some((r) => normalizeName(r.name) === nameKey)
  const flag = flagged ? { playerId: flagged.playerId, name: flagged.name } : null

  if (!playerId) {
    const id = newId('ply')
    await tx.insert(players).values({
      id,
      name,
      nameKey,
      phone: phoneRaw,
      phoneKey: phoneTaken ? null : phoneKey,
    })
    return { playerId: id, created: true, name, flagged: flag, duplicateOnList, matchedExisting: false }
  }

  if (phoneKey && !phoneTaken) {
    // A number we did not have. Safe to set: nobody else carries it, or the
    // lookup above would have found them.
    await tx
      .update(players)
      .set({ phone: phoneRaw, phoneKey, updatedAt: new Date() })
      .where(and(eq(players.id, playerId), isNull(players.phoneKey)))
  }
  return { playerId, created: false, name, flagged: flag, duplicateOnList, matchedExisting: true }
}

export type JoinInput = {
  sessionId: string
  name: string
  phone?: string | null
  source: 'self' | 'host'
  deviceId?: string | null
  ipHash?: string | null
  hideFromPublic?: boolean
  /** Set to the inviter's player id to add somebody's guest (s1k). */
  guestOfPlayerId?: string | null
  /** A walk-in is created already checked in — never a resurrected withdrawal. */
  arriveCheckedIn?: boolean
}

export type JoinResult =
  | {
      ok: true
      alreadyIn: boolean
      participantId: string
      playerId: string
      state: ParticipationState
      seatNo: number | null
      waiting: boolean
      /** Raw manage token — returned once, at join. Null when we cannot re-issue one. */
      token: string | null
      flagged: { playerId: string; name: string } | null
      /** True when a walk-in pushed the soft cap up by one. */
      openedASpot?: boolean
    }
  | Fail

export async function joinSession(input: JoinInput, now: Date = new Date()): Promise<JoinResult> {
  const name = input.name.trim().replace(/\s+/g, ' ')
  if (name.length < 2) return fail('Put a name in.')
  if (name.length > 60) return fail('That name is too long — sixty characters is the most.')
  if (!normalizeName(name)) return fail('That doesn’t look like a name.')

  const phoneRaw = input.phone?.trim() || null
  const phoneKey = normalizePhone(phoneRaw)
  if (input.source === 'self' && !phoneRaw) {
    return fail('The host needs a phone number to reach you. It never goes on the public list.')
  }
  if (phoneRaw && !phoneKey) {
    return fail('That phone number doesn’t look right — ten digits, or leave it blank.')
  }

  return transact(async (tx) => {
    // The session row lock orders every join, walk-in, guest and promotion for
    // this session. The seat index is what catches a path that forgot it.
    const [session] = await tx
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.id, input.sessionId))
      .limit(1)
      .for('update')

    if (!session || session.deletedAt) return fail('That game has gone.')
    if (session.status === 'cancelled') return fail('That game was called off. Nobody is charged for it.')
    // `locked` is the wall. `ended` is not: the host has 45 minutes to fix who
    // turned up, and somebody who arrived at nine o'clock still has to go on.
    if (session.status === 'locked') return fail('That night is closed — the list can’t change now.')
    if (input.source === 'self') {
      if (session.status === 'draft') return fail('That game isn’t open yet. Ask the host.')
      if (session.status === 'ended') return fail('That game has finished. Ask the host if you played.')
      if (now >= session.startsAt) return fail('That game has started — ask the host to put you on.')
    }

    if (input.guestOfPlayerId) {
      const [host] = await tx
        .select({ id: sessionParticipants.playerId })
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.sessionId, session.id),
            eq(sessionParticipants.playerId, input.guestOfPlayerId),
            inArray(sessionParticipants.state, [...OCCUPYING]),
          ),
        )
        .limit(1)
      if (!host) return fail('Whoever invited them isn’t on this list.')
    }

    /**
     * Somebody already on this list, by the strongest key we have.
     *
     * The phone is checked BEFORE any player row is resolved or created, and
     * on its own — not "phone and name". One number is one spot: otherwise the
     * same number under sixteen different names takes sixteen seats, because
     * `resolvePlayer` deliberately refuses to merge a number onto a different
     * name and each one becomes a fresh player.
     *
     * The answer is the same shape whether the name matched or not, so the
     * form cannot be used to ask "is this number Suresh's?".
     */
    const alreadyHere = async (): Promise<ParticipantRow | null> => {
      if (!phoneKey) return null
      const rows = await tx
        .select({ p: sessionParticipants, phone: players.phone, phoneKey: players.phoneKey })
        .from(sessionParticipants)
        .innerJoin(players, eq(players.id, sessionParticipants.playerId))
        .where(
          and(
            eq(sessionParticipants.sessionId, session.id),
            inArray(sessionParticipants.state, [...LIVE]),
          ),
        )
      // Matched in JS on the NORMALISED number, not by `phone_key` alone.
      // `phone_key` is unique across players, so somebody whose number already
      // belonged to a different name carries it as text with a null key — and a
      // check that only read the key would miss them, which is the whole
      // seat-stuffing hole in a subtler shape. The roster is a few dozen rows.
      const hit = rows.find((r) => r.phoneKey === phoneKey || normalizePhone(r.phone) === phoneKey)
      return hit?.p ?? null
    }

    const standing = (existing: ParticipantRow) => {
      // Same device, same person: hand the link back so a phone that cleared
      // its storage can still manage its own spot. A different device gets the
      // fact and no link — otherwise anybody who could guess a name and a
      // number could cancel somebody else's evening.
      const sameDevice = !!input.deviceId && !!existing.deviceId && input.deviceId === existing.deviceId
      return {
        ok: true as const,
        alreadyIn: true,
        participantId: existing.id,
        playerId: existing.playerId,
        state: existing.state as ParticipationState,
        seatNo: existing.seatNo,
        waiting: existing.state === 'waitlisted',
        token: sameDevice ? existing.manageToken : null,
        flagged: null,
      }
    }

    const byPhone = await alreadyHere()
    if (byPhone) {
      // A walk-in who is already on the waitlist should come off it and play,
      // not be told they are "already in" and left waiting.
      if (input.arriveCheckedIn && byPhone.state === 'waitlisted') {
        const seated = await seatAWaitingPlayer(tx, session, byPhone, now)
        if (seated) return seated
      }
      return standing(byPhone)
    }

    const resolved = await resolvePlayer(tx, session.id, name, phoneKey, phoneRaw)

    // A bare name the host typed that exactly matches somebody already on this
    // list: only they can say whether that is a second Priya or a second tap.
    if (!phoneKey && resolved.duplicateOnList) {
      return fail(`There’s already a ${name} on this list. Add a surname or a number so you can tell them apart.`)
    }

    const [existing] = await tx
      .select()
      .from(sessionParticipants)
      .where(
        and(
          eq(sessionParticipants.sessionId, session.id),
          eq(sessionParticipants.playerId, resolved.playerId),
          inArray(sessionParticipants.state, [...LIVE]),
        ),
      )
      .limit(1)

    if (existing) {
      if (input.arriveCheckedIn && existing.state === 'waitlisted') {
        const seated = await seatAWaitingPlayer(tx, session, existing, now)
        if (seated) return seated
      }
      return standing(existing)
    }

    const taken = await seatMapFor(tx, session.id)
    let capacity = session.capacity
    let seat = freeSeats(taken, capacity)[0] ?? null

    // A walk-in is standing in front of the host. Putting them on a waitlist
    // for a game they are about to play is a lie the screen would have to tell,
    // so the soft cap opens by one instead — 16 is comfortable, 18 is fine.
    if (seat === null && input.arriveCheckedIn && capacity < 200) {
      capacity += 1
      await tx.update(gameSessions).set({ capacity, updatedAt: now }).where(eq(gameSessions.id, session.id))
      seat = freeSeats(taken, capacity)[0] ?? null
      await recordAudit(
        {
          actorLabel: 'host',
          action: 'session.capacity.walkin',
          entity: 'game_session',
          entityId: session.id,
          reason: 'a walk-in arrived and the list was full',
          after: { capacity },
        },
        tx,
      )
    }

    let state: ParticipationState
    if (seat === null) state = 'waitlisted'
    else if (input.arriveCheckedIn) state = 'checked_in'
    // Joining IS confirming: somebody who signs up ninety minutes before the
    // start must not then be withdrawn for failing to confirm what they just did.
    else state = gatePhase(session, now) === 'before' ? 'joined' : 'confirmed'

    const id = newId('sp')
    const token = newSpotToken()
    await tx.insert(sessionParticipants).values({
      id,
      sessionId: session.id,
      playerId: resolved.playerId,
      payerPlayerId: input.guestOfPlayerId ?? resolved.playerId,
      invitedByPlayerId: input.guestOfPlayerId ?? null,
      state,
      seq: await nextSeq(tx, session.id),
      seatNo: seat,
      isGuest: !!input.guestOfPlayerId,
      source: input.source,
      displayName: name,
      hideFromPublic: !!input.hideFromPublic,
      manageToken: token,
      deviceId: input.deviceId ?? null,
      ipHash: input.ipHash ?? null,
      joinedAt: now,
      confirmedAt: state === 'confirmed' || state === 'checked_in' ? now : null,
      checkedInAt: state === 'checked_in' ? now : null,
    })
    await bumpSessionVersion(session.id, tx)

    return {
      ok: true as const,
      alreadyIn: false,
      participantId: id,
      playerId: resolved.playerId,
      state,
      seatNo: seat,
      waiting: state === 'waitlisted',
      token,
      flagged: resolved.flagged,
      openedASpot: capacity !== session.capacity,
    }
  })
}

// ─────────────────────── a spot, from the player's side ───────────────────────

export type SpotView = { participant: ParticipantRow; session: SessionRow }

/** Resolve the capability URL. Rate limiting is the caller's job. */
export async function resolveSpot(rawToken: string): Promise<SpotView | null> {
  const token = rawToken.trim()
  if (!token || token.length > 200) return null
  const rows = await db
    .select({ participant: sessionParticipants, session: gameSessions })
    .from(sessionParticipants)
    .innerJoin(gameSessions, eq(gameSessions.id, sessionParticipants.sessionId))
    .where(eq(sessionParticipants.manageToken, token))
    .limit(1)
  const row = rows[0]
  if (!row || row.session.deletedAt) return null
  return { participant: row.participant, session: row.session }
}

/**
 * The same resolution, with a limiter of its own.
 *
 * FAILED lookups are counted, successes are not, and the budget is per IP with
 * no venue-wide ceiling — this URL is forwarded into WhatsApp groups, so a
 * global cap here would be a switch anyone could flip to turn off every court
 * QR code and every tournament sign-up link in the building.
 *
 * A blocked lookup and an unknown token give the same answer, so a guesser
 * learns nothing from the difference.
 */
export async function resolveSpotToken(raw: string): Promise<SpotView | null> {
  const h = await headers()
  // Null is a bucket of its own in the limiter, so a request that arrives
  // without a forwarded IP is counted rather than exempted.
  const ipHash = hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim()) ?? 'no-ip'
  const gate = await checkSpotLookupAllowed(ipHash)
  if (!gate.allowed) return null

  const found = await resolveSpot(raw)
  await recordTokenAttempt('spot', raw.slice(0, 5), ipHash, !!found)
  return found
}

export async function confirmSpot(participantId: string, now: Date = new Date()) {
  const out = await transact(async (tx) => {
    const [p] = await tx
      .select({ sessionId: sessionParticipants.sessionId })
      .from(sessionParticipants)
      .where(eq(sessionParticipants.id, participantId))
      .limit(1)
    if (!p) return fail('That spot has gone.')

    // Confirming for a game that was called off would tell somebody "see you
    // there" about an evening that is not happening.
    const [session] = await tx
      .select({ status: gameSessions.status })
      .from(gameSessions)
      .where(eq(gameSessions.id, p.sessionId))
      .limit(1)
    if (!session) return fail('That game has gone.')
    if (session.status === 'cancelled') return fail('That game was called off. Nothing to confirm.')
    if (session.status === 'ended' || session.status === 'locked') return fail('That game has finished.')

    const rows = await tx
      .update(sessionParticipants)
      .set({ state: 'confirmed', confirmedAt: now, version: sql`${sessionParticipants.version} + 1`, updatedAt: now })
      .where(and(eq(sessionParticipants.id, participantId), eq(sessionParticipants.state, 'joined')))
      .returning({ sessionId: sessionParticipants.sessionId })
    if (!rows.length) return fail('Nothing to confirm — you’re either already in or no longer on the list.')
    await bumpSessionVersion(rows[0].sessionId, tx)
    return { ok: true as const }
  })
  return out
}

export type LeaveResult =
  | { ok: true; promoted: { id: string; playerId: string; name: string; state: string }[] }
  | Fail

/**
 * Give up a spot — the player from their own link, or the host from the list.
 *
 * The withdrawal and the promotion it causes are one transaction under one row
 * lock, so a freed spot can never be given to two people. Free right up to the
 * start time: punishing a late cancel converts it into a silent no-show.
 */
export async function leaveSession(
  participantId: string,
  by: { kind: 'player' | 'host' | 'system'; label: string; userId?: string | null },
  reason: string | null = null,
  now: Date = new Date(),
): Promise<LeaveResult> {
  const [head] = await db
    .select({ sessionId: sessionParticipants.sessionId })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.id, participantId))
    .limit(1)
  if (!head) return fail('That spot has gone.')

  const out = await transact(async (tx) => {
    const [session] = await tx
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.id, head.sessionId))
      .limit(1)
      .for('update')
    if (!session) return fail('That game has gone.')
    if (session.status === 'locked') return fail('That night is closed — the list can’t change now.')
    // A player gives up a spot right up to the start and not after: the rule
    // lived only in the view, and a replayed POST at half past seven withdrew
    // somebody mid-game and handed their place to the waitlist.
    if (by.kind === 'player' && now >= session.startsAt) {
      return fail('That game has started. Have a word with the host.')
    }

    const gone = await tx
      .update(sessionParticipants)
      .set({
        state: 'withdrawn',
        seatNo: null,
        withdrawnAt: now,
        withdrawnBy: by.label.slice(0, 60),
        withdrawReason: reason?.slice(0, 120) ?? null,
        version: sql`${sessionParticipants.version} + 1`,
        updatedAt: now,
      })
      .where(and(eq(sessionParticipants.id, participantId), inArray(sessionParticipants.state, [...LIVE])))
      .returning({ id: sessionParticipants.id })
    if (!gone.length) return fail('That spot has already gone.')

    // Once the game is under way a freed seat is not a seat anybody can take,
    // so nobody is moved up into an evening that is already half over.
    const promoted = now < session.startsAt ? await promoteWaitlist(tx, session, now) : []
    await bumpSessionVersion(session.id, tx)
    return { ok: true as const, promoted }
  })

  if (out.ok) {
    await recordAudit({
      userId: by.userId ?? null,
      actorLabel: by.label,
      action: 'session.left',
      entity: 'session_participant',
      entityId: participantId,
      reason,
      after: { promoted: out.promoted.map((p) => p.name) },
    })
  }
  return out
}

// ─────────────── transitions the reconciler drives (tx-scoped) ───────────────
//
// These take the open transaction rather than opening their own: the applier
// writes the boundary key and the effect together, or neither happens.

/**
 * The confirmation gate closing. Everyone still `joined` — asked to confirm and
 * silent — gives the spot up, and the waitlist fills it in the same breath, so
 * a freed spot can never be given to two people.
 */
export async function releaseUnconfirmed(tx: Tx, session: SessionRow, now: Date) {
  const released = await tx
    .update(sessionParticipants)
    .set({
      state: 'withdrawn',
      seatNo: null,
      withdrawnAt: now,
      withdrawnBy: 'gate',
      withdrawReason: 'not confirmed',
      version: sql`${sessionParticipants.version} + 1`,
      updatedAt: now,
    })
    .where(and(eq(sessionParticipants.sessionId, session.id), eq(sessionParticipants.state, 'joined')))
    .returning({ id: sessionParticipants.id, name: sessionParticipants.displayName, playerId: sessionParticipants.playerId })

  const promoted = released.length ? await promoteWaitlist(tx, session, now) : []
  if (released.length || promoted.length) await bumpSessionVersion(session.id, tx)
  return { released, promoted }
}

export async function markLive(tx: Tx, sessionId: string, at: Date) {
  const rows = await tx
    .update(gameSessions)
    .set({ status: 'live', startedAt: at, updatedAt: new Date() })
    .where(and(eq(gameSessions.id, sessionId), eq(gameSessions.status, 'open')))
    .returning({ id: gameSessions.id })
  if (rows.length) await bumpSessionVersion(sessionId, tx)
  return rows.length > 0
}

/**
 * A session nobody ended, ending itself. `endedAt` is the scheduled moment, not
 * `now`, so a game missed for a week is recorded as having finished when it did
 * and its lock boundary lands where it should rather than a week late.
 */
export async function markAutoEnded(tx: Tx, sessionId: string, at: Date) {
  const rows = await tx
    .update(gameSessions)
    .set({ status: 'ended', endedAt: at, lockAt: lockAtFor(at), updatedAt: new Date() })
    .where(and(eq(gameSessions.id, sessionId), inArray(gameSessions.status, ['open', 'live'])))
    .returning({ id: gameSessions.id })
  if (rows.length) await bumpSessionVersion(sessionId, tx)
  return rows.length > 0
}

// ───────────────────────── the host's screen ─────────────────────────

/** Raising the cap fills the new seats from the waitlist, in the same breath. */
export async function setCapacity(
  sessionId: string,
  /** An absolute number, or `{ by: n }` to change it relative to whatever it is now. */
  want: number | { by: number },
  actor: { id: string; username: string },
  now: Date = new Date(),
) {
  if (typeof want === 'number' && (!Number.isInteger(want) || want < 1 || want > 200)) {
    return fail('Spots have to be between 1 and 200.')
  }
  if (typeof want !== 'number' && !Number.isInteger(want.by)) return fail('That isn’t a number of spots.')

  const out = await transact(async (tx) => {
    const [session] = await tx
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.id, sessionId))
      .limit(1)
      .for('update')
    if (!session) return fail('That game has gone.')
    if (session.status === 'locked' || session.status === 'cancelled') {
      return fail('That game is closed, so the spots can’t change. Nothing was lost.')
    }

    // The delta is applied to the value read UNDER the lock. Read outside it,
    // two hosts both tapping "open 4 more" both see 16 and both write 20.
    const capacity =
      typeof want === 'number' ? want : Math.min(200, Math.max(1, session.capacity + want.by))

    // Seats are recycled, so after a few withdrawals the numbers in use can be
    // {12, 15} for two people. Lowering the cap to four then leaves two seats
    // ABOVE it, invisible to `freeSeats` — which scans 1..capacity — so the
    // promotion below would fill 1..4 on top of them and put six people in a
    // four-seat game. Compacting first makes the highest seat number equal the
    // headcount, which is the only floor that is both safe and not
    // over-conservative.
    await compactSeats(tx, sessionId)
    const taken = await seatMapFor(tx, sessionId)
    // Lowering never turns anybody out — it only stops new joins.
    const floor = Math.max(1, taken.size, ...taken)
    const applied = Math.max(capacity, floor)

    await tx
      .update(gameSessions)
      .set({ capacity: applied, updatedAt: now })
      .where(eq(gameSessions.id, sessionId))

    const promoted = await promoteWaitlist(tx, { ...session, capacity: applied }, now)
    await bumpSessionVersion(sessionId, tx)
    return { ok: true as const, capacity: applied, clamped: applied !== capacity, promoted }
  })

  if (out.ok) {
    await recordAudit({
      userId: actor.id,
      actorLabel: actor.username,
      action: 'session.capacity',
      entity: 'game_session',
      entityId: sessionId,
      after: { capacity: out.capacity, promoted: out.promoted.map((p) => p.name) },
    })
  }
  return out
}

/** The one human step: tap who turned up. Reversible until the night locks. */
export async function setPresent(participantId: string, present: boolean, now: Date = new Date()) {
  const [head] = await db
    .select({ sessionId: sessionParticipants.sessionId })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.id, participantId))
    .limit(1)
  if (!head) return fail('That spot has gone.')

  return transact(async (tx) => {
    // `for update`, because the status read and the attendance write have to be
    // ordered against the tick that closes the night. Without it the host's tap
    // and the lock interleave: the guard sees `ended`, the lock commits
    // `locked` and turns everyone `absent`, and the tap then writes
    // `checked_in` into a night that is supposed to be frozen — a participation
    // that is neither played nor away, which nothing will ever resolve again.
    const [session] = await tx
      .select({ status: gameSessions.status })
      .from(gameSessions)
      .where(eq(gameSessions.id, head.sessionId))
      .limit(1)
      .for('update')
    if (!session) return fail('That game has gone.')
    if (session.status === 'locked') return fail('That night is closed — attendance can’t change now.')
    if (session.status === 'draft') return fail('That game hasn’t started yet. Publish it first.')

    const rows = present
      ? await tx
          .update(sessionParticipants)
          .set({ state: 'checked_in', checkedInAt: now, version: sql`${sessionParticipants.version} + 1`, updatedAt: now })
          .where(
            and(
              eq(sessionParticipants.id, participantId),
              // `absent` is not here: it is only ever written by the lock, in
              // the same transaction that freezes the night.
              inArray(sessionParticipants.state, ['joined', 'confirmed']),
            ),
          )
          .returning({ id: sessionParticipants.id })
      : await tx
          .update(sessionParticipants)
          .set({ state: 'confirmed', checkedInAt: null, version: sql`${sessionParticipants.version} + 1`, updatedAt: now })
          .where(and(eq(sessionParticipants.id, participantId), eq(sessionParticipants.state, 'checked_in')))
          .returning({ id: sessionParticipants.id })

    if (!rows.length) return fail('That was already done — nothing changed.')
    await bumpSessionVersion(head.sessionId, tx)
    return { ok: true as const }
  })
}

/**
 * Move one named person off the waitlist and onto the court, now.
 *
 * The tick fills vacancies on its own before the start. This is the host at ten
 * past seven looking at a no-show with somebody standing next to them, which no
 * schedule can anticipate.
 */
export async function seatFromWaitlist(participantId: string, now: Date = new Date()) {
  const [head] = await db
    .select({ sessionId: sessionParticipants.sessionId })
    .from(sessionParticipants)
    .where(eq(sessionParticipants.id, participantId))
    .limit(1)
  if (!head) return fail('That spot has gone.')

  return transact(async (tx) => {
    const [session] = await tx
      .select()
      .from(gameSessions)
      .where(eq(gameSessions.id, head.sessionId))
      .limit(1)
      .for('update')
    if (!session) return fail('That game has gone.')
    if (session.status === 'locked' || session.status === 'cancelled') {
      return fail('That game is closed, so the list can’t change. Nothing was lost.')
    }
    // The same wall `joinSession` puts up: an unpublished game has no list to
    // be put in to.
    if (session.status === 'draft') return fail('That game isn’t published yet.')

    const [p] = await tx
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.id, participantId))
      .limit(1)
    if (!p) return fail('That spot has gone.')
    if (p.state !== 'waitlisted') return fail('They aren’t waiting — nothing changed.')

    const seated = await seatAWaitingPlayer(tx, session, p, now)
    return seated ? { ok: true as const } : fail('There was no room for them. Open a spot first.')
  })
}

/**
 * Draw a new link for one spot and retire the old one.
 *
 * The reason the token is stored rather than hashed is that the host has to be
 * able to send it; the reason it is drawn rather than derived is that it has to
 * be replaceable when a link ends up in the wrong group chat. This is that.
 */
export async function rotateSpotToken(participantId: string) {
  const token = newSpotToken()
  const rows = await db
    .update(sessionParticipants)
    .set({ manageToken: token, version: sql`${sessionParticipants.version} + 1`, updatedAt: new Date() })
    .where(eq(sessionParticipants.id, participantId))
    .returning({ sessionId: sessionParticipants.sessionId })
  if (!rows.length) return fail('That spot has gone.')
  await bumpSessionVersion(rows[0].sessionId)
  return { ok: true as const, token }
}

/** Keep a name off the public list without keeping them out of the game. */
export async function setHidden(participantId: string, hidden: boolean) {
  return transact(async (tx) => {
    const rows = await tx
      .update(sessionParticipants)
      .set({ hideFromPublic: hidden, updatedAt: new Date() })
      .where(eq(sessionParticipants.id, participantId))
      .returning({ sessionId: sessionParticipants.sessionId })
    if (!rows.length) return fail('That spot has gone.')
    await bumpSessionVersion(rows[0].sessionId, tx)
    return { ok: true as const }
  })
}

/** Move a guest's bill to somebody else on the list, or back to themselves. */
export async function setPayer(participantId: string, payerPlayerId: string, actor: { id: string; username: string }) {
  const out = await transact(async (tx) => {
    const [p] = await tx
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.id, participantId))
      .limit(1)
    if (!p) return fail('That spot has gone.')

    const [session] = await tx
      .select({ status: gameSessions.status })
      .from(gameSessions)
      .where(eq(gameSessions.id, p.sessionId))
      .limit(1)
    // Once the night is locked the charge carries its own payer and a change
    // here would silently re-point an immutable row. Stage 3 makes this an
    // adjustment plus a new charge instead.
    if (session?.status === 'locked') return fail('That night is closed — who pays is fixed now.')

    if (payerPlayerId !== p.playerId) {
      const [onList] = await tx
        .select({ id: sessionParticipants.id })
        .from(sessionParticipants)
        .where(
          and(
            eq(sessionParticipants.sessionId, p.sessionId),
            eq(sessionParticipants.playerId, payerPlayerId),
            inArray(sessionParticipants.state, [...OCCUPYING]),
          ),
        )
        .limit(1)
      if (!onList) return fail('That person isn’t on this list.')
    }

    await tx
      .update(sessionParticipants)
      .set({
        payerPlayerId,
        invitedByPlayerId: payerPlayerId === p.playerId ? null : payerPlayerId,
        isGuest: payerPlayerId !== p.playerId ? p.isGuest : false,
        version: sql`${sessionParticipants.version} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(sessionParticipants.id, participantId))
    await bumpSessionVersion(p.sessionId, tx)
    return { ok: true as const, before: p.payerPlayerId }
  })

  if (out.ok) {
    await recordAudit({
      userId: actor.id,
      actorLabel: actor.username,
      action: 'session.payer',
      entity: 'session_participant',
      entityId: participantId,
      before: { payerPlayerId: out.before },
      after: { payerPlayerId },
    })
  }
  return out
}

/** Change the time or the price of a game that has not started. */
export async function rescheduleSession(
  sessionId: string,
  input: {
    startsAt: Date
    endsAt: Date
    pricePaise: number
    courtCount: number
    title: string
    notes: string | null
    confirmationGate: boolean
  },
  actor: { id: string; username: string },
  now: Date = new Date(),
) {
  if (input.endsAt <= input.startsAt) return fail('It has to finish after it starts.')
  const price = checkPrice(input.pricePaise)
  if (price) return price

  const bounds = boundariesFor(input.startsAt, input.endsAt, DEFAULT_SESSION_POLICY, now)
  const rows = await transact(async (tx) => {
    const r = await tx
      .update(gameSessions)
      .set({
        title: input.title.trim().slice(0, 80),
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        pricePaise: input.pricePaise,
        courtCount: input.courtCount,
        notes: input.notes?.trim() || null,
        confirmationGate: input.confirmationGate,
        confirmOpensAt: bounds.confirmOpensAt,
        confirmDeadlineAt: bounds.confirmDeadlineAt,
        autoEndAt: bounds.autoEndAt,
        policyVersion: SESSION_POLICY_VERSION,
        updatedAt: now,
      })
      .where(and(eq(gameSessions.id, sessionId), inArray(gameSessions.status, ['draft', 'open'])))
      .returning({ id: gameSessions.id })
    if (r.length) {
      // The boundaries just moved, so any claim the reconciler holds against
      // the OLD schedule refers to a moment that no longer exists. Left in
      // place, a new deadline that happens to land on an already-claimed
      // instant would be treated as done and the gate would never fire.
      await tx
        .delete(sessionScheduledActions)
        .where(
          and(
            eq(sessionScheduledActions.sessionId, sessionId),
            gte(sessionScheduledActions.boundaryAt, now),
          ),
        )
      await bumpSessionVersion(sessionId, tx)
    }
    return r
  })
  if (!rows.length) return fail('That game has already started — it can’t be moved now.')
  await recordAudit({
    userId: actor.id,
    actorLabel: actor.username,
    action: 'session.rescheduled',
    entity: 'game_session',
    entityId: sessionId,
    after: { startsAt: input.startsAt, endsAt: input.endsAt, pricePaise: input.pricePaise },
  })
  return { ok: true as const }
}

/** Who can be picked as a guest's payer: everyone holding a seat. */
export async function payerOptions(sessionId: string) {
  return db
    .select({ playerId: sessionParticipants.playerId, name: sessionParticipants.displayName })
    .from(sessionParticipants)
    .where(
      and(
        eq(sessionParticipants.sessionId, sessionId),
        inArray(sessionParticipants.state, [...OCCUPYING]),
        eq(sessionParticipants.isGuest, false),
      ),
    )
    .orderBy(asc(sessionParticipants.seq))
}

export { OCCUPYING, LIVE as LIVE_PARTICIPATION_STATES }
