import 'server-only'
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { db, transact, type Tx } from '@/db'
import {
  categories,
  matches,
  pendingRegistrations,
  players,
  registrationTokens,
  teamPlayers,
  teams,
  tournamentPlayers,
  tournaments,
} from '@/db/schema'
import { hashIp, normalizeCrockford, sha256Hex } from '@/lib/crypto'
import { newId } from '@/lib/ids'
import {
  looksLikeSamePerson,
  normalizeName,
  normalizePhone,
  parsePlayerList,
} from '@/lib/parse-players'
import { bumpStreamVersion } from '@/lib/stream'
import { checkTokenLookupAllowed, recordTokenAttempt } from '@/lib/rate-limit'
import { primaryCategory, syncCategoryPlayers } from './events'

/**
 * Registration — SPEC v4.
 *
 * One link per tournament, dropped in the WhatsApp group. A player types their
 * name, a phone number if they like, and who they want to play with, and they
 * are on the list — there is no queue for the organiser to wave people through.
 * The organiser adds the ones who phoned, removes the ones who cannot make it,
 * and closes the link when the list is full.
 *
 * The one thing the machine cannot decide is whether "Ravi S" is Ravi Shankar.
 * It says so, on the row, and the organiser answers with one tap.
 */

// ───────────────────────────── the link ─────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * The link sits on the organiser's screen every time they open Registration,
 * so it has to be reconstructible. It is derived from the token row's own
 * random id rather than drawn fresh, and the hash of it is stored beside the
 * row as before — the lookup path did not change, and a row issued the old way
 * simply fails the check in `currentRegistrationToken` and is replaced.
 */
function tokenFromId(id: string): string {
  const hex = sha256Hex(`registration-link:${id}`)
  let out = ''
  for (let i = 0; i < 10; i++) out += CROCKFORD[parseInt(hex.slice(i * 2, i * 2 + 2), 16) % 32]
  return `${out.slice(0, 5)}-${out.slice(5)}`
}

export async function issueRegistrationLink(tournamentId: string, expiresAt: Date) {
  const id = newId('rt')
  const raw = tokenFromId(id)
  // One transaction: the partial unique index allows exactly one active link
  // per tournament, so revoking and issuing have to land together.
  await transact(async (tx) => {
    await tx
      .update(registrationTokens)
      .set({ status: 'revoked', revokedAt: new Date() })
      .where(
        and(
          eq(registrationTokens.tournamentId, tournamentId),
          eq(registrationTokens.status, 'active'),
        ),
      )
    await tx.insert(registrationTokens).values({
      id,
      tournamentId,
      tokenHash: sha256Hex(normalizeCrockford(raw)),
      tokenPrefix: raw.slice(0, 5),
      expiresAt,
    })
  })
  return raw
}

export async function currentRegistrationToken(tournamentId: string) {
  const [row] = await db
    .select({ id: registrationTokens.id, tokenHash: registrationTokens.tokenHash, expiresAt: registrationTokens.expiresAt })
    .from(registrationTokens)
    .where(
      and(
        eq(registrationTokens.tournamentId, tournamentId),
        eq(registrationTokens.status, 'active'),
        sql`${registrationTokens.expiresAt} > now()`,
      ),
    )
    .limit(1)
  if (!row) return null
  const raw = tokenFromId(row.id)
  if (sha256Hex(normalizeCrockford(raw)) !== row.tokenHash) return null
  return { raw, expiresAt: row.expiresAt }
}

/** The link the organiser sees. Made the first time it is asked for. */
export async function ensureRegistrationLink(tournamentId: string, expiresAt: Date) {
  const current = await currentRegistrationToken(tournamentId)
  if (current) return current.raw
  // Once the day has gone there is nothing to sign up for: issuing a link
  // that has already expired, on every render, is just churn.
  if (expiresAt.getTime() <= Date.now()) return null
  return issueRegistrationLink(tournamentId, expiresAt)
}

export type RegistrationView = {
  tournament: { id: string; name: string; slug: string; startDate: Date }
  discipline: 'singles' | 'doubles'
  /** The organiser closed sign-ups, or the tournament has started. */
  closed: boolean
}

/** Resolve a registration link. Rate-limited exactly like a court token. */
export async function resolveRegistrationToken(raw: string): Promise<RegistrationView | null> {
  const h = await headers()
  const ipHash = hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim())
  const gate = await checkTokenLookupAllowed(ipHash)
  if (!gate.allowed) return null

  const normalized = normalizeCrockford(raw)
  const [token] = await db
    .select({ tournamentId: registrationTokens.tournamentId })
    .from(registrationTokens)
    .where(
      and(
        eq(registrationTokens.tokenHash, sha256Hex(normalized)),
        eq(registrationTokens.status, 'active'),
        sql`${registrationTokens.expiresAt} > now()`,
      ),
    )
    .limit(1)

  await recordTokenAttempt('registration', normalized.slice(0, 5), ipHash, !!token)
  if (!token) return null

  const [row] = await db
    .select({
      id: tournaments.id,
      name: tournaments.name,
      slug: tournaments.slug,
      startDate: tournaments.startDate,
      status: tournaments.status,
      registrationClosedAt: tournaments.registrationClosedAt,
      discipline: categories.discipline,
    })
    .from(tournaments)
    .innerJoin(categories, eq(categories.tournamentId, tournaments.id))
    .where(
      and(
        eq(tournaments.id, token.tournamentId),
        isNull(tournaments.deletedAt),
        isNull(categories.deletedAt),
      ),
    )
    .orderBy(asc(categories.seq))
    .limit(1)
  if (!row) return null

  return {
    tournament: { id: row.id, name: row.name, slug: row.slug, startDate: row.startDate },
    discipline: row.discipline === 'singles' ? 'singles' : 'doubles',
    closed: signupsClosed(row),
  }
}

export function signupsClosed(t: { status: string; registrationClosedAt: Date | null }) {
  return !!t.registrationClosedAt || t.status === 'live' || t.status === 'completed' || t.status === 'archived'
}

// ───────────────────────────── the list ─────────────────────────────

type RosterRow = {
  tpId: string
  playerId: string
  name: string
  nameKey: string
  phone: string | null
  phoneKey: string | null
  source: string
  partnerWish: string | null
  partnerPlayerId: string | null
  registeredAt: Date
}

async function rosterRows(tournamentId: string): Promise<RosterRow[]> {
  return db
    .select({
      tpId: tournamentPlayers.id,
      playerId: players.id,
      name: players.name,
      nameKey: players.nameKey,
      phone: players.phone,
      phoneKey: players.phoneKey,
      source: tournamentPlayers.source,
      partnerWish: tournamentPlayers.partnerWish,
      partnerPlayerId: tournamentPlayers.partnerPlayerId,
      registeredAt: tournamentPlayers.registeredAt,
    })
    .from(tournamentPlayers)
    .innerJoin(players, eq(players.id, tournamentPlayers.playerId))
    .where(eq(tournamentPlayers.tournamentId, tournamentId))
    .orderBy(asc(tournamentPlayers.registeredAt), asc(players.name))
}

export type RosterEntry = {
  playerId: string
  name: string
  source: 'link' | 'hand'
  /** The roster player they named, or the name as they typed it. */
  partner: string | null
  partnerOnList: boolean
  registeredAt: Date
  /** Somebody already on the list who looks like the same person. */
  duplicateOf: { playerId: string; name: string } | null
}

/**
 * Who is in, in the order they arrived. A row flagged at sign-up as a possible
 * duplicate carries the earlier person it looks like, worked out the same way
 * it was at sign-up, so the organiser's answer is about two names they can see.
 */
export async function listRoster(tournamentId: string): Promise<RosterEntry[]> {
  const [roster, flags] = await Promise.all([
    rosterRows(tournamentId),
    db
      .select({ playerId: pendingRegistrations.mergedPlayerId })
      .from(pendingRegistrations)
      .where(
        and(
          eq(pendingRegistrations.tournamentId, tournamentId),
          eq(pendingRegistrations.status, 'pending'),
        ),
      ),
  ])
  const flagged = new Set(flags.map((f) => f.playerId))
  const byId = new Map(roster.map((r) => [r.playerId, r]))

  return roster.map((r) => {
    const named = r.partnerPlayerId ? byId.get(r.partnerPlayerId) : undefined
    const earlier = flagged.has(r.playerId)
      ? roster.find((o) => o.playerId !== r.playerId && looksLikeSamePerson(o.nameKey, r.nameKey))
      : undefined
    return {
      playerId: r.playerId,
      name: r.name,
      source: r.source === 'link' ? 'link' : 'hand',
      partner: named?.name ?? r.partnerWish,
      partnerOnList: !!named,
      registeredAt: r.registeredAt,
      duplicateOf: earlier ? { playerId: earlier.playerId, name: earlier.name } : null,
    }
  })
}

// ───────────────────────────── adding ─────────────────────────────

type AddInput = {
  name: string
  phone?: string | null
  partnerWish?: string | null
  source: 'link' | 'hand'
  deviceId?: string | null
  ipHash?: string | null
}

export type AddResult =
  | { ok: true; playerId: string; flagged: { playerId: string; name: string } | null }
  | { ok: false; error: string }

/**
 * Put one person on the list, whichever way they arrived.
 *
 * Who they are in the venue's book of players: the phone number if it is
 * known, otherwise a player with exactly this name who is not already on this
 * list and does not carry a different number, otherwise somebody new. If they
 * look like somebody already on the list they still go on — the organiser is
 * the one who knows — with a flag, stored as the sign-up record left open.
 *
 * Partner wishes resolve both ways: theirs to whoever on the list has that
 * name, and anyone who had already named THEM gets the pointer filled in now.
 */
export async function addPlayer(tournamentId: string, input: AddInput): Promise<AddResult> {
  const name = input.name.trim()
  if (name.length < 2) return { ok: false, error: 'Put a name in.' }
  if (name.length > 60) return { ok: false, error: 'That name is too long.' }
  const nameKey = normalizeName(name)
  if (!nameKey) return { ok: false, error: 'That doesn’t look like a name.' }
  const phone = input.phone?.trim() || null
  const phoneKey = normalizePhone(phone)
  if (phone && !phoneKey) {
    return { ok: false, error: 'That phone number doesn’t look right — ten digits, or leave it blank.' }
  }
  const partnerWish = input.partnerWish?.trim().slice(0, 60) || null
  const partnerKey = partnerWish ? normalizeName(partnerWish) : null

  const roster = await rosterRows(tournamentId)
  const onList = new Set(roster.map((r) => r.playerId))

  let playerId: string | null = null
  // A number already on someone else's record cannot be the new row's dedupe
  // key too — the index is unique — so it is kept as text only.
  let phoneTaken = false
  if (phoneKey) {
    const [byPhone] = await db
      .select({ id: players.id, name: players.name })
      .from(players)
      .where(and(eq(players.phoneKey, phoneKey), isNull(players.deletedAt)))
      .limit(1)
    if (byPhone) {
      // The same number under the same name is the same person, back for
      // another Sunday. The same number under a different name is not
      // silently turned into last month's name — anyone with the link could
      // otherwise learn who a number belongs to. It becomes a new player,
      // flagged if the names look alike; the organiser merges if it is them.
      const sameName = normalizeName(byPhone.name) === nameKey
      if (sameName && onList.has(byPhone.id)) {
        return { ok: false, error: `${byPhone.name} is already on the list.` }
      }
      if (sameName) playerId = byPhone.id
      else phoneTaken = true
    }
  }
  if (!playerId) {
    const sameName = await db
      .select({ id: players.id, phoneKey: players.phoneKey })
      .from(players)
      .where(and(eq(players.nameKey, nameKey), isNull(players.deletedAt)))
      .orderBy(asc(players.createdAt))
    playerId = sameName.find((p) => !onList.has(p.id) && (!phoneKey || !p.phoneKey))?.id ?? null
  }
  const isNew = !playerId
  const id = playerId ?? newId('ply')

  const looksLike = roster.find((r) => looksLikeSamePerson(r.nameKey, nameKey)) ?? null
  const partner = partnerKey && partnerKey !== nameKey ? roster.find((r) => r.nameKey === partnerKey) : undefined
  const namedMe = roster
    .filter((r) => !r.partnerPlayerId && r.partnerWish && normalizeName(r.partnerWish) === nameKey)
    .map((r) => r.tpId)

  await transact(async (tx) => {
    if (isNew) {
      await tx.insert(players).values({ id, name, nameKey, phone, phoneKey: phoneTaken ? null : phoneKey })
    } else if (phoneKey && !phoneTaken) {
      // A number we did not have. Safe to set: nobody else carries it, or the
      // phone lookup above would have found them.
      await tx
        .update(players)
        .set({ phone, phoneKey, updatedAt: new Date() })
        .where(and(eq(players.id, id), isNull(players.phoneKey)))
    }
    await tx.insert(tournamentPlayers).values({
      id: newId('tp'),
      tournamentId,
      playerId: id,
      source: input.source,
      partnerWish,
      partnerPlayerId: partner?.playerId ?? null,
    })
    if (namedMe.length) {
      await tx
        .update(tournamentPlayers)
        .set({ partnerPlayerId: id })
        .where(inArray(tournamentPlayers.id, namedMe))
    }
    // The sign-up record. Left 'pending' when the organiser has a question to
    // answer about it; that is the whole of the duplicate flag.
    await tx.insert(pendingRegistrations).values({
      id: newId('reg'),
      tournamentId,
      name,
      nameKey,
      phone: phoneKey,
      partnerName: partnerWish,
      partnerNameKey: partnerKey,
      deviceId: input.deviceId ?? null,
      ipHash: input.ipHash ?? null,
      status: looksLike ? 'pending' : 'approved',
      mergedPlayerId: id,
      reviewedAt: looksLike ? null : new Date(),
    })
    await bumpStreamVersion(tournamentId, tx)
  })
  await syncCategoryPlayers(tournamentId)

  return {
    ok: true,
    playerId: id,
    flagged: looksLike ? { playerId: looksLike.playerId, name: looksLike.name } : null,
  }
}

/** The organiser's one-line box: "Name 98400 12345", phone optional. */
export async function addPlayerByHand(tournamentId: string, text: string): Promise<AddResult> {
  const [row] = parsePlayerList(text.slice(0, 120))
  if (!row?.name) return { ok: false, error: 'Put a name in — the phone number is optional.' }
  const nameKey = normalizeName(row.name)
  const roster = await rosterRows(tournamentId)
  // Typing a name that is already there is a slip, not a second person.
  const same = roster.find((r) => r.nameKey === nameKey)
  if (same) return { ok: false, error: `${same.name} is already on the list.` }
  return addPlayer(tournamentId, { name: row.name, phone: row.phone, source: 'hand' })
}

/**
 * The list pasted out of the group chat — one name per line, numbering,
 * ticks and phone numbers all fine. Names already on the list are skipped
 * and counted, not refused: the paste is the same list the organiser posted
 * last week plus three new people.
 */
export async function addPlayersByHand(tournamentId: string, text: string) {
  const rows = parsePlayerList(text.slice(0, 4000)).filter((r) => r.name)
  if (!rows.length) return { ok: false as const, error: 'Put a name in — the phone number is optional.' }
  let added = 0
  let skipped = 0
  const flagged: string[] = []
  for (const row of rows) {
    const roster = await rosterRows(tournamentId)
    if (roster.some((r) => r.nameKey === normalizeName(row.name))) {
      skipped++
      continue
    }
    const res = await addPlayer(tournamentId, { name: row.name, phone: row.phone, source: 'hand' })
    if (!res.ok) return { ok: false as const, error: res.error }
    added++
    if (res.flagged) flagged.push(row.name)
  }
  return { ok: true as const, added, skipped, flagged }
}

export type SubmitRegistration = {
  tournamentId: string
  name: string
  phone?: string | null
  partnerName?: string | null
  deviceId?: string | null
}

export type RegistrationResult =
  | { ok: true; alreadyIn: boolean }
  | { ok: false; error: string }

/**
 * The public form. Straight onto the list — unless they are on it already,
 * which is the common case: people reload, or come back to add a partner.
 * "Already" is the same phone number, or the same name from the same browser.
 * The same name from a different browser goes on with a flag, because two
 * Karthiks in one group is not unusual and the organiser knows which is which.
 */
export async function submitRegistration(input: SubmitRegistration): Promise<RegistrationResult> {
  const name = input.name.trim()
  if (name.length < 2) return { ok: false, error: 'Put your name in.' }
  if (name.length > 60) return { ok: false, error: 'That name is too long.' }
  const nameKey = normalizeName(name)
  const phoneKey = normalizePhone(input.phone)
  if (input.phone?.trim() && !phoneKey) {
    return { ok: false, error: 'That phone number doesn’t look right — ten digits, or leave it blank.' }
  }

  const [t] = await db
    .select({
      status: tournaments.status,
      registrationClosedAt: tournaments.registrationClosedAt,
      discipline: categories.discipline,
    })
    .from(tournaments)
    .innerJoin(categories, eq(categories.tournamentId, tournaments.id))
    .where(and(eq(tournaments.id, input.tournamentId), isNull(tournaments.deletedAt), isNull(categories.deletedAt)))
    .orderBy(asc(categories.seq))
    .limit(1)
  if (!t) return { ok: false, error: 'This link doesn’t work any more. Ask the organiser.' }
  if (signupsClosed(t)) return { ok: false, error: 'Sign-ups have closed — ask the organiser.' }
  const partnerWish = t.discipline === 'singles' ? null : input.partnerName?.trim() || null

  const roster = await rosterRows(input.tournamentId)
  // "Already on the list" only for the same number under the same name —
  // a number alone must not answer "is so-and-so playing", nor let a
  // stranger with the number change their partner wish.
  let mine = phoneKey ? roster.find((r) => r.phoneKey === phoneKey && r.nameKey === nameKey) : undefined
  if (!mine && input.deviceId) {
    const sameNameHere = roster.filter((r) => r.nameKey === nameKey)
    if (sameNameHere.length) {
      const [earlier] = await db
        .select({ playerId: pendingRegistrations.mergedPlayerId })
        .from(pendingRegistrations)
        .where(
          and(
            eq(pendingRegistrations.tournamentId, input.tournamentId),
            eq(pendingRegistrations.nameKey, nameKey),
            eq(pendingRegistrations.deviceId, input.deviceId),
            ne(pendingRegistrations.status, 'rejected'),
          ),
        )
        .limit(1)
      mine = sameNameHere.find((r) => r.playerId === earlier?.playerId)
    }
  }

  if (mine) {
    // Coming back to say who they are playing with is the one edit worth taking.
    if (partnerWish && !mine.partnerWish) {
      const partnerKey = normalizeName(partnerWish)
      const partner = partnerKey !== mine.nameKey ? roster.find((r) => r.nameKey === partnerKey) : undefined
      await db
        .update(tournamentPlayers)
        .set({ partnerWish, partnerPlayerId: partner?.playerId ?? null })
        .where(eq(tournamentPlayers.id, mine.tpId))
      await bumpStreamVersion(input.tournamentId)
    }
    return { ok: true, alreadyIn: true }
  }

  const h = await headers()
  const ipHash = hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim())
  const res = await addPlayer(input.tournamentId, {
    name,
    phone: input.phone,
    partnerWish,
    source: 'link',
    deviceId: input.deviceId ?? null,
    ipHash,
  })
  if (!res.ok) return res
  // A statistic on the link, nothing more.
  await db
    .update(registrationTokens)
    .set({ useCount: sql`${registrationTokens.useCount} + 1` })
    .where(
      and(
        eq(registrationTokens.tournamentId, input.tournamentId),
        eq(registrationTokens.status, 'active'),
      ),
    )
  return { ok: true, alreadyIn: false }
}

// ───────────────────────── removing and merging ─────────────────────────

/** The pair this player is in, and whether it is too late to take it apart. */
async function pairOf(tournamentId: string, playerId: string) {
  const category = await primaryCategory(tournamentId)
  const [row] = await db
    .select({ teamId: teams.id, name: teams.name })
    .from(teamPlayers)
    .innerJoin(teams, eq(teams.id, teamPlayers.teamId))
    .where(and(eq(teamPlayers.playerId, playerId), eq(teams.categoryId, category.id)))
    .limit(1)
  if (!row) return null
  const [agg] = await db
    .select({
      n: sql<number>`cast(count(*) as int)`,
      played: sql<number>`cast(count(*) filter (where ${matches.resultState} <> 'none') as int)`,
    })
    .from(matches)
    .where(
      and(
        eq(matches.tournamentId, tournamentId),
        or(
          eq(matches.teamAId, row.teamId),
          eq(matches.teamBId, row.teamId),
          eq(matches.winnerTeamId, row.teamId),
          eq(matches.retiredTeamId, row.teamId),
        ),
      ),
    )
  return { teamId: row.teamId, name: row.name, onSchedule: (agg?.n ?? 0) > 0, hasResult: (agg?.played ?? 0) > 0 }
}

function tooLate(name: string, pair: { name: string; onSchedule: boolean; hasResult: boolean }) {
  if (pair.hasResult) return `${name} is in ${pair.name}, and that pair has already played. Sort it out under More.`
  if (pair.onSchedule) return `${name} is in ${pair.name}, which is on the schedule. Split the pair first, then make the schedule again.`
  return null
}

/**
 * Flags that no longer point at anybody — the person they looked like has gone
 * — close themselves. Runs inside whichever transaction changed the list.
 */
async function settleOrphanFlags(tx: Tx, tournamentId: string, remaining: RosterRow[]) {
  const flags = await tx
    .select({ id: pendingRegistrations.id, playerId: pendingRegistrations.mergedPlayerId })
    .from(pendingRegistrations)
    .where(
      and(
        eq(pendingRegistrations.tournamentId, tournamentId),
        eq(pendingRegistrations.status, 'pending'),
      ),
    )
  const stale = flags
    .filter((f) => {
      const me = remaining.find((r) => r.playerId === f.playerId)
      return !me || !remaining.some((r) => r.playerId !== me.playerId && looksLikeSamePerson(r.nameKey, me.nameKey))
    })
    .map((f) => f.id)
  if (stale.length) {
    await tx
      .update(pendingRegistrations)
      .set({ status: 'approved', reviewedAt: new Date() })
      .where(inArray(pendingRegistrations.id, stale))
  }
}

export type ListChange = { ok: true; note: string } | { ok: false; error: string }

/**
 * Take somebody off the list. A pair they are in that has not played is taken
 * apart with them; one that has played is not ours to touch from here.
 */
export async function removePlayer(tournamentId: string, playerId: string): Promise<ListChange> {
  const roster = await rosterRows(tournamentId)
  const row = roster.find((r) => r.playerId === playerId)
  if (!row) return { ok: false, error: 'They are not on the list any more.' }
  const pair = await pairOf(tournamentId, playerId)
  const late = pair && tooLate(row.name, pair)
  if (late) return { ok: false, error: late }

  const remaining = roster.filter((r) => r.playerId !== playerId)
  await transact(async (tx) => {
    if (pair) await tx.delete(teams).where(eq(teams.id, pair.teamId))
    await tx
      .update(tournamentPlayers)
      .set({ partnerPlayerId: null })
      .where(
        and(
          eq(tournamentPlayers.tournamentId, tournamentId),
          eq(tournamentPlayers.partnerPlayerId, playerId),
        ),
      )
    await tx.delete(tournamentPlayers).where(eq(tournamentPlayers.id, row.tpId))
    await tx
      .update(pendingRegistrations)
      .set({ status: 'rejected', reviewedAt: new Date(), reviewNote: 'Removed by the organiser' })
      .where(
        and(
          eq(pendingRegistrations.tournamentId, tournamentId),
          eq(pendingRegistrations.mergedPlayerId, playerId),
        ),
      )
    await settleOrphanFlags(tx, tournamentId, remaining)
    await bumpStreamVersion(tournamentId, tx)
  })
  await syncCategoryPlayers(tournamentId)
  return {
    ok: true,
    note: pair
      ? `${row.name} is off the list, and the pair ${pair.name} is split.`
      : `${row.name} is off the list.`,
  }
}

/**
 * "Same person": the earlier row stays, the later one goes, and anything the
 * earlier row lacked — a partner wish, a phone number — comes across. Anyone
 * who had named the later row now points at the one that stays.
 */
export async function mergePlayers(
  tournamentId: string,
  keepId: string,
  dropId: string,
): Promise<ListChange> {
  const roster = await rosterRows(tournamentId)
  const keep = roster.find((r) => r.playerId === keepId)
  const drop = roster.find((r) => r.playerId === dropId)
  if (!keep || !drop || keepId === dropId) {
    return { ok: false, error: 'One of them is not on the list any more.' }
  }
  const pair = await pairOf(tournamentId, dropId)
  const late = pair && tooLate(drop.name, pair)
  if (late) return { ok: false, error: late }

  const remaining = roster.filter((r) => r.playerId !== dropId)
  await transact(async (tx) => {
    if (pair) await tx.delete(teams).where(eq(teams.id, pair.teamId))
    if (!keep.partnerWish && drop.partnerWish) {
      await tx
        .update(tournamentPlayers)
        .set({
          partnerWish: drop.partnerWish,
          partnerPlayerId: drop.partnerPlayerId === keepId ? null : drop.partnerPlayerId,
        })
        .where(eq(tournamentPlayers.id, keep.tpId))
    }
    await tx
      .update(tournamentPlayers)
      .set({ partnerPlayerId: keepId })
      .where(
        and(
          eq(tournamentPlayers.tournamentId, tournamentId),
          eq(tournamentPlayers.partnerPlayerId, dropId),
          ne(tournamentPlayers.playerId, keepId),
        ),
      )
    await tx.delete(tournamentPlayers).where(eq(tournamentPlayers.id, drop.tpId))
    if (!keep.phoneKey && drop.phoneKey) {
      // The number is unique across players, so it has to leave one row before
      // it can land on the other.
      await tx.update(players).set({ phone: null, phoneKey: null }).where(eq(players.id, dropId))
      await tx
        .update(players)
        .set({ phone: drop.phone, phoneKey: drop.phoneKey, updatedAt: new Date() })
        .where(eq(players.id, keepId))
    }
    await tx
      .update(pendingRegistrations)
      .set({ status: 'approved', mergedPlayerId: keepId, reviewedAt: new Date() })
      .where(
        and(
          eq(pendingRegistrations.tournamentId, tournamentId),
          eq(pendingRegistrations.mergedPlayerId, dropId),
        ),
      )
    // A player row that was only ever this one mistaken sign-up goes with it.
    const [elsewhere] = await tx
      .select({ n: sql<number>`cast(count(*) as int)` })
      .from(tournamentPlayers)
      .where(eq(tournamentPlayers.playerId, dropId))
    if (!elsewhere?.n) await tx.delete(players).where(eq(players.id, dropId))
    await settleOrphanFlags(tx, tournamentId, remaining)
    await bumpStreamVersion(tournamentId, tx)
  })
  await syncCategoryPlayers(tournamentId)
  return { ok: true, note: `${drop.name} and ${keep.name} are one person on the list now.` }
}

/** "Different": the flag comes off and both stay. */
export async function keepBoth(tournamentId: string, playerId: string) {
  await db
    .update(pendingRegistrations)
    .set({ status: 'approved', reviewedAt: new Date() })
    .where(
      and(
        eq(pendingRegistrations.tournamentId, tournamentId),
        eq(pendingRegistrations.mergedPlayerId, playerId),
        eq(pendingRegistrations.status, 'pending'),
      ),
    )
  await bumpStreamVersion(tournamentId)
}
