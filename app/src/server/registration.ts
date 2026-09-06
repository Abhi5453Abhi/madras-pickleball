import 'server-only'
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm'
import { headers } from 'next/headers'
import { db } from '@/db'
import {
  categories,
  categoryPlayers,
  pendingRegistrations,
  players,
  registrationTokens,
  teamPlayers,
  teams,
  tournamentPlayers,
  tournaments,
} from '@/db/schema'
import { hashIp, newCourtToken, normalizeCrockford, sha256Hex } from '@/lib/crypto'
import { newId } from '@/lib/ids'
import { normalizeName, normalizePhone } from '@/lib/parse-players'
import { bumpStreamVersion } from '@/lib/stream'
import { checkTokenLookupAllowed, recordTokenAttempt } from '@/lib/rate-limit'

/**
 * Player self-registration — SPEC A2.
 *
 * One link per tournament, shared in the WhatsApp group. A player types their
 * name, picks the categories they want, and names a partner if they already
 * have one. Nothing they submit touches the draw: it lands in a review list,
 * because the organiser is the one who knows that "Ravi" and "Ravi S" are the
 * same person and that the third Karthik never actually turns up.
 */

export type RegistrationView = {
  tournament: { id: string; name: string; slug: string; startDate: Date }
  categories: Array<{ id: string; name: string; discipline: string; needsPartner: boolean }>
}

export async function issueRegistrationLink(tournamentId: string, expiresAt: Date) {
  await db
    .update(registrationTokens)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(registrationTokens.tournamentId, tournamentId),
        eq(registrationTokens.status, 'active'),
      ),
    )

  const { raw, hash, prefix } = newCourtToken()
  await db.insert(registrationTokens).values({
    id: newId('rt'),
    tournamentId,
    tokenHash: hash,
    tokenPrefix: prefix,
    expiresAt,
  })
  return raw
}

export async function currentRegistrationToken(tournamentId: string) {
  const [row] = await db
    .select()
    .from(registrationTokens)
    .where(
      and(
        eq(registrationTokens.tournamentId, tournamentId),
        eq(registrationTokens.status, 'active'),
      ),
    )
    .limit(1)
  return row ?? null
}

export async function revokeRegistrationLink(tournamentId: string) {
  await db
    .update(registrationTokens)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(registrationTokens.tournamentId, tournamentId),
        eq(registrationTokens.status, 'active'),
      ),
    )
}

/** Resolve a registration link. Rate-limited exactly like a court token. */
export async function resolveRegistrationToken(raw: string): Promise<RegistrationView | null> {
  const h = await headers()
  const ipHash = hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim())
  const gate = await checkTokenLookupAllowed(ipHash)
  if (!gate.allowed) return null

  const normalized = normalizeCrockford(raw)
  const [token] = await db
    .select()
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

  const [tournament] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.id, token.tournamentId), isNull(tournaments.deletedAt)))
    .limit(1)
  if (!tournament) return null

  const cats = await db
    .select()
    .from(categories)
    .where(and(eq(categories.tournamentId, tournament.id), isNull(categories.deletedAt)))
    .orderBy(asc(categories.seq))

  return {
    tournament: {
      id: tournament.id,
      name: tournament.name,
      slug: tournament.slug,
      startDate: tournament.startDate,
    },
    categories: cats.map((c) => ({
      id: c.id,
      name: c.name,
      discipline: c.discipline,
      needsPartner: c.discipline !== 'singles',
    })),
  }
}

export type SubmitRegistration = {
  tournamentId: string
  name: string
  phone?: string | null
  categoryIds: string[]
  partnerName?: string | null
  deviceId?: string | null
}

export type RegistrationResult =
  | { ok: true; id: string; alreadyIn: boolean }
  | { ok: false; error: string }

export async function submitRegistration(
  input: SubmitRegistration,
): Promise<RegistrationResult> {
  const name = input.name.trim()
  if (name.length < 2) return { ok: false, error: 'Put your name in.' }
  if (name.length > 60) return { ok: false, error: 'That name is too long.' }
  if (input.categoryIds.length === 0) {
    return { ok: false, error: 'Pick at least one — singles, doubles, or both.' }
  }

  // The categories have to belong to THIS tournament; the ids arrive from a
  // form on a page anyone with the link can open.
  const valid = await db
    .select({ id: categories.id })
    .from(categories)
    .where(
      and(
        eq(categories.tournamentId, input.tournamentId),
        inArray(categories.id, input.categoryIds),
        isNull(categories.deletedAt),
      ),
    )
  if (valid.length !== input.categoryIds.length) {
    return { ok: false, error: 'That form is out of date — reload the page and try again.' }
  }

  const nameKey = normalizeName(name)
  const partnerName = input.partnerName?.trim() || null

  // Registering twice from the same phone is the norm, not an attack: people
  // reload, or add a second category later. Update rather than duplicate.
  const [existing] = await db
    .select()
    .from(pendingRegistrations)
    .where(
      and(
        eq(pendingRegistrations.tournamentId, input.tournamentId),
        eq(pendingRegistrations.nameKey, nameKey),
      ),
    )
    .limit(1)

  const h = await headers()
  const ipHash = hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim())

  if (existing) {
    if (existing.status === 'approved') return { ok: true, id: existing.id, alreadyIn: true }
    await db
      .update(pendingRegistrations)
      .set({
        phone: normalizePhone(input.phone) ?? existing.phone,
        categoryIds: [...new Set([...existing.categoryIds, ...input.categoryIds])],
        partnerName: partnerName ?? existing.partnerName,
        partnerNameKey: partnerName ? normalizeName(partnerName) : existing.partnerNameKey,
        status: 'pending',
      })
      .where(eq(pendingRegistrations.id, existing.id))
    return { ok: true, id: existing.id, alreadyIn: false }
  }

  const id = newId('reg')
  await db.insert(pendingRegistrations).values({
    id,
    tournamentId: input.tournamentId,
    name,
    nameKey,
    phone: normalizePhone(input.phone),
    categoryIds: input.categoryIds,
    partnerName,
    partnerNameKey: partnerName ? normalizeName(partnerName) : null,
    deviceId: input.deviceId ?? null,
    ipHash,
  })

  await db
    .update(registrationTokens)
    .set({ useCount: sql`${registrationTokens.useCount} + 1` })
    .where(
      and(
        eq(registrationTokens.tournamentId, input.tournamentId),
        eq(registrationTokens.status, 'active'),
      ),
    )

  return { ok: true, id, alreadyIn: false }
}

export type PendingRow = {
  id: string
  name: string
  phone: string | null
  categoryIds: string[]
  categoryNames: string[]
  partnerName: string | null
  /** The other pending registration that named this person back. */
  mutualWith: { id: string; name: string } | null
  /** An existing player with the same name — probably the same human. */
  looksLike: { id: string; name: string } | null
  status: string
  /** Set once approved: the roster player this became. */
  playerId: string | null
  createdAt: Date
}

export async function listPendingRegistrations(tournamentId: string): Promise<PendingRow[]> {
  const rows = await db
    .select()
    .from(pendingRegistrations)
    .where(eq(pendingRegistrations.tournamentId, tournamentId))
    .orderBy(desc(pendingRegistrations.createdAt))

  const cats = await db
    .select({ id: categories.id, name: categories.name })
    .from(categories)
    .where(eq(categories.tournamentId, tournamentId))
  const catName = new Map(cats.map((c) => [c.id, c.name]))

  const keys = [...new Set(rows.map((r) => r.nameKey))]
  const known = keys.length
    ? await db
        .select({ id: players.id, name: players.name, nameKey: players.nameKey })
        .from(players)
        .where(inArray(players.nameKey, keys))
    : []
  const knownByKey = new Map(known.map((p) => [p.nameKey, p]))

  const byKey = new Map(rows.map((r) => [r.nameKey, r]))

  return rows.map((r) => {
    // A pair is only a pair when both of them said so. One person naming a
    // partner who never registers is the common case, and it must not silently
    // create a team of one.
    const named = r.partnerNameKey ? byKey.get(r.partnerNameKey) : undefined
    const mutual =
      named && named.partnerNameKey === r.nameKey
        ? { id: named.id, name: named.name }
        : null
    const seen = knownByKey.get(r.nameKey)
    return {
      id: r.id,
      name: r.name,
      phone: r.phone,
      categoryIds: r.categoryIds,
      categoryNames: r.categoryIds.map((c) => catName.get(c) ?? '—'),
      partnerName: r.partnerName,
      mutualWith: mutual,
      looksLike: seen ? { id: seen.id, name: seen.name } : null,
      status: r.status,
      playerId: r.mergedPlayerId,
      createdAt: r.createdAt,
    }
  })
}

/**
 * Approve one registration: it becomes a player on the roster and is added to
 * the categories they asked for. Teams are NOT built here — pairing is a
 * separate, deliberate act, and a pair that both named each other is offered
 * to the organiser rather than created behind their back.
 */
export async function approveRegistration(
  registrationId: string,
  opts?: { categoryIds?: string[]; linkPlayerId?: string | null },
) {
  const [reg] = await db
    .select()
    .from(pendingRegistrations)
    .where(eq(pendingRegistrations.id, registrationId))
    .limit(1)
  if (!reg) return { ok: false as const, error: 'That registration is gone.' }
  if (reg.status === 'approved') return { ok: false as const, error: 'Already on the roster.' }

  const wanted = opts?.categoryIds ?? reg.categoryIds

  let playerId = opts?.linkPlayerId ?? null
  if (!playerId) {
    const [match] = await db
      .select({ id: players.id })
      .from(players)
      .where(eq(players.nameKey, reg.nameKey))
      .limit(1)
    playerId = match?.id ?? null
  }
  if (!playerId) {
    playerId = newId('ply')
    await db.insert(players).values({
      id: playerId,
      name: reg.name,
      nameKey: reg.nameKey,
      phone: reg.phone,
      phoneKey: normalizePhone(reg.phone),
    })
  }

  await db
    .insert(tournamentPlayers)
    .values({ id: newId('tp'), tournamentId: reg.tournamentId, playerId })
    .onConflictDoNothing()

  for (const categoryId of wanted) {
    await db
      .insert(categoryPlayers)
      .values({ id: newId('cp'), categoryId, playerId })
      .onConflictDoNothing()
  }

  await db
    .update(pendingRegistrations)
    .set({
      status: 'approved',
      mergedPlayerId: playerId,
      reviewedAt: new Date(),
      categoryIds: wanted,
    })
    .where(eq(pendingRegistrations.id, registrationId))

  await bumpStreamVersion(reg.tournamentId)
  return { ok: true as const, playerId }
}

export async function rejectRegistration(registrationId: string, note?: string) {
  const [reg] = await db
    .select({ tournamentId: pendingRegistrations.tournamentId })
    .from(pendingRegistrations)
    .where(eq(pendingRegistrations.id, registrationId))
    .limit(1)
  if (!reg) return
  await db
    .update(pendingRegistrations)
    .set({ status: 'rejected', reviewedAt: new Date(), reviewNote: note ?? null })
    .where(eq(pendingRegistrations.id, registrationId))
  await bumpStreamVersion(reg.tournamentId)
}

/**
 * Build a team from two approved registrations who named each other. Offered on
 * the review screen, never automatic.
 */
export async function pairApproved(categoryId: string, playerIds: string[], names: string[]) {
  if (playerIds.length < 2) return { ok: false as const, error: 'A pair needs two players.' }

  const already = await db
    .select({ teamId: teamPlayers.teamId })
    .from(teamPlayers)
    .innerJoin(teams, eq(teams.id, teamPlayers.teamId))
    .where(and(eq(teams.categoryId, categoryId), inArray(teamPlayers.playerId, playerIds)))
  if (already.length) {
    return { ok: false as const, error: 'One of them is already in a team in this category.' }
  }

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(teams)
    .where(eq(teams.categoryId, categoryId))

  const teamId = newId('tm')
  await db.insert(teams).values({
    id: teamId,
    categoryId,
    name: names.join(' / '),
    seed: Number(n) + 1,
  })
  await db
    .insert(teamPlayers)
    .values(playerIds.map((playerId, position) => ({ teamId, playerId, position })))
  return { ok: true as const, teamId }
}
