import 'server-only'
import { and, desc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm'
import { cookies, headers } from 'next/headers'
import { db } from '@/db'
import { courtSessions, courtTokens, courts, matches } from '@/db/schema'
import { newCourtToken, normalizeCrockford, sha256Hex, newSessionToken, hashIp } from '@/lib/crypto'
import { newId } from '@/lib/ids'
import { checkTokenLookupAllowed, recordTokenAttempt } from '@/lib/rate-limit'
import { projectedState } from './scoring'

/**
 * Court access — SPEC A1.
 *
 * A QR on the net post opens the score screen with no login, because club
 * pickleball is self-refereed and per-scorer accounts get shared in the
 * WhatsApp group anyway. The token is exchanged immediately for a device-bound
 * cookie so the secret leaves the URL bar, history and screenshots.
 *
 * Blast radius: one court's current and recently finished matches, reversible
 * and attributed.
 */

export const COURT_COOKIE = 'mpb_court'

export async function issueCourtTokens(tournamentId: string, expiresAt: Date) {
  const courtRows = await db.select().from(courts).where(eq(courts.active, true))
  const issued: Array<{ courtId: string; courtName: string; raw: string; prefix: string }> = []

  for (const court of courtRows) {
    await db
      .update(courtTokens)
      .set({ status: 'revoked', revokedAt: new Date(), revokedReason: 'rotated' })
      .where(
        and(
          eq(courtTokens.tournamentId, tournamentId),
          eq(courtTokens.courtId, court.id),
          eq(courtTokens.status, 'active'),
        ),
      )

    const { raw, hash, prefix } = newCourtToken()
    await db.insert(courtTokens).values({
      id: newId('ct'),
      tournamentId,
      courtId: court.id,
      tokenHash: hash,
      tokenPrefix: prefix,
      label: `${court.name} — ${new Date().toDateString()}`,
      expiresAt,
    })
    issued.push({ courtId: court.id, courtName: court.name, raw, prefix })
  }
  return issued
}

export async function revokeAllCourtTokens(tournamentId: string) {
  const active = await db
    .select({ id: courtTokens.id })
    .from(courtTokens)
    .where(and(eq(courtTokens.tournamentId, tournamentId), eq(courtTokens.status, 'active')))

  for (const t of active) {
    // Killing the token kills every session issued from it, in the same breath.
    await db.delete(courtSessions).where(eq(courtSessions.courtTokenId, t.id))
    await db
      .update(courtTokens)
      .set({ status: 'revoked', revokedAt: new Date(), revokedReason: 'revoked by organiser' })
      .where(eq(courtTokens.id, t.id))
  }
  return active.length
}

export type ExchangeResult =
  | { ok: true; courtId: string }
  | { ok: false; reason: 'unknown' | 'rate_limited' }

/** Exchange the printed token for a device-bound session cookie. */
export async function exchangeToken(raw: string): Promise<ExchangeResult> {
  const h = await headers()
  const ipHash = hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim())

  // Only FAILED resolutions are rate-limited per IP: the scanner is the venue
  // behind its NAT, and a blanket cap locks out the whole club at once.
  const gate = await checkTokenLookupAllowed(ipHash)
  if (!gate.allowed) return { ok: false, reason: 'rate_limited' }

  const normalized = normalizeCrockford(raw)
  const hash = sha256Hex(normalized)

  const [token] = await db
    .select()
    .from(courtTokens)
    .where(
      and(
        eq(courtTokens.tokenHash, hash),
        eq(courtTokens.status, 'active'),
        gt(courtTokens.expiresAt, new Date()),
      ),
    )
    .limit(1)

  await recordTokenAttempt('court', normalized.slice(0, 5), ipHash, !!token)
  // Identical response for "no such token" and "revoked", so it is not an oracle.
  if (!token) return { ok: false, reason: 'unknown' }

  const deviceId = newId('dev')
  const { raw: sessionRaw, hash: sessionHash } = newSessionToken()
  const expiresAt = token.expiresAt

  await db.insert(courtSessions).values({
    idHash: sessionHash,
    courtTokenId: token.id,
    deviceId,
    expiresAt,
    ipHash,
    userAgent: h.get('user-agent')?.slice(0, 256) ?? null,
  })
  await db
    .update(courtTokens)
    .set({ lastUsedAt: new Date(), useCount: sql`${courtTokens.useCount} + 1` })
    .where(eq(courtTokens.id, token.id))

  const jar = await cookies()
  jar.set(COURT_COOKIE, sessionRaw, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })

  return { ok: true, courtId: token.courtId }
}

export type CourtSessionContext = {
  courtId: string
  courtName: string
  colorKey: string
  tournamentId: string
  deviceId: string
  umpireUserId: string | null
}

export async function currentCourtSession(): Promise<CourtSessionContext | null> {
  const jar = await cookies()
  const raw = jar.get(COURT_COOKIE)?.value
  if (!raw) return null

  const [row] = await db
    .select({
      deviceId: courtSessions.deviceId,
      umpireUserId: courtSessions.umpireUserId,
      courtId: courtTokens.courtId,
      tournamentId: courtTokens.tournamentId,
      status: courtTokens.status,
      courtName: courts.name,
      colorKey: courts.colorKey,
    })
    .from(courtSessions)
    .innerJoin(courtTokens, eq(courtTokens.id, courtSessions.courtTokenId))
    .innerJoin(courts, eq(courts.id, courtTokens.courtId))
    .where(and(eq(courtSessions.idHash, sha256Hex(raw)), gt(courtSessions.expiresAt, new Date())))
    .limit(1)

  if (!row || row.status !== 'active') return null
  return {
    courtId: row.courtId,
    courtName: row.courtName,
    colorKey: row.colorKey,
    tournamentId: row.tournamentId,
    deviceId: row.deviceId,
    umpireUserId: row.umpireUserId,
  }
}

/**
 * What this court session may write to: the match on its court now, or one that
 * finished here in the last hour — because confirmation always happens after
 * the match, by which time the board has usually sent the next pair on.
 */
export async function scoreableMatches(ctx: CourtSessionContext) {
  const hourAgo = new Date(Date.now() - 60 * 60_000)
  const rows = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.tournamentId, ctx.tournamentId),
        eq(matches.courtId, ctx.courtId),
        inArray(matches.resultState, ['none', 'reported']),
        or(
          inArray(matches.status, ['live', 'called', 'warming_up']),
          // Confirmation always happens after the match, by which time the
          // board has usually sent the next pair on — so a match that finished
          // here in the last hour stays writable.
          and(eq(matches.status, 'completed'), isNotNull(matches.endedAt), gt(matches.endedAt, hourAgo)),
        ),
      ),
    )
    .orderBy(desc(matches.startedAt))

  // A result that crossed the ten-minute mark is FINAL, even though nothing
  // wrote `final` to the row. Filtering on the stored state let a pair rescan
  // the card 45 minutes later and pull a settled, already-advanced result back
  // into "under review" — deleting their own loss from the public table.
  return rows.filter((m) => projectedState(m) !== 'final')
}
