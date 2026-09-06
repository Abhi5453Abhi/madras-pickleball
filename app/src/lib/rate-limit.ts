import 'server-only'
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { loginAttempts, users, tokenAttempts } from '@/db/schema'
import { newId } from './ids'

/**
 * Rate limiting lives in Postgres — in-memory counters are useless on serverless,
 * where every invocation may be a fresh instance (SPEC A9).
 */

const WINDOW_MIN = 15
const MAX_FAILURES = 8
const LOCKOUT_MIN = 15

/**
 * Lock the ACCOUNT, not the IP: every umpire is behind one venue NAT, so
 * IP-locking locks out the whole club on the busiest minute of the day.
 */
export async function checkLoginAllowed(identifier: string) {
  const rows = await db
    .select({ lockedUntil: users.lockedUntil })
    .from(users)
    .where(eq(users.username, identifier))
    .limit(1)
  const lockedUntil = rows[0]?.lockedUntil
  if (lockedUntil && lockedUntil > new Date()) {
    const mins = Math.ceil((lockedUntil.getTime() - Date.now()) / 60000)
    return { allowed: false as const, retryInMinutes: mins }
  }
  return { allowed: true as const }
}

export async function recordLoginAttempt(identifier: string, ipHash: string | null, ok: boolean) {
  await db.insert(loginAttempts).values({ id: newId('la'), identifier, ipHash, succeeded: ok })

  if (ok) {
    await db
      .update(users)
      .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() })
      .where(eq(users.username, identifier))
    return
  }

  const since = new Date(Date.now() - WINDOW_MIN * 60_000)
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.identifier, identifier),
        eq(loginAttempts.succeeded, false),
        gte(loginAttempts.at, since),
      ),
    )

  if (n >= MAX_FAILURES) {
    await db
      .update(users)
      .set({ lockedUntil: new Date(Date.now() + LOCKOUT_MIN * 60_000), failedLoginCount: n })
      .where(eq(users.username, identifier))
  } else {
    await db.update(users).set({ failedLoginCount: n }).where(eq(users.username, identifier))
  }
}

/**
 * PIN sign-in. There is no username to lock, so the count is per IP: five
 * wrong PINs in fifteen minutes from one address and that address waits.
 * A per-IP count and not a global one, because a global count is a switch
 * anyone on the internet can flip to lock the organiser out mid-tournament.
 */
const PIN_WINDOW_MIN = 15
const PIN_MAX_FAILURES = 5
const PIN_IDENTIFIER = 'pin'

export async function checkPinAllowed(ipHash: string | null) {
  const since = new Date(Date.now() - PIN_WINDOW_MIN * 60_000)
  const rows = await db
    .select({ at: loginAttempts.at })
    .from(loginAttempts)
    .where(
      and(
        eq(loginAttempts.identifier, PIN_IDENTIFIER),
        ipHash ? eq(loginAttempts.ipHash, ipHash) : isNull(loginAttempts.ipHash),
        eq(loginAttempts.succeeded, false),
        gte(loginAttempts.at, since),
      ),
    )
    .orderBy(desc(loginAttempts.at))
    .limit(PIN_MAX_FAILURES)

  if (rows.length >= PIN_MAX_FAILURES) {
    // The wait ends when the oldest of the last five falls out of the window.
    const oldest = rows[rows.length - 1]!.at
    const until = oldest.getTime() + PIN_WINDOW_MIN * 60_000
    return {
      allowed: false as const,
      retryInMinutes: Math.max(1, Math.ceil((until - Date.now()) / 60_000)),
      triesLeft: 0,
    }
  }
  return { allowed: true as const, triesLeft: PIN_MAX_FAILURES - rows.length }
}

export async function recordPinAttempt(ipHash: string | null, ok: boolean, userId?: string) {
  await db
    .insert(loginAttempts)
    .values({ id: newId('la'), identifier: PIN_IDENTIFIER, ipHash, succeeded: ok })
  if (ok && userId) {
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, userId))
  }
}

/**
 * Court/registration links: rate-limit FAILED resolutions per IP, never successes.
 * The scanner is the venue behind its NAT; a blanket per-IP cap would lock out the
 * whole club on the busiest minute of the day (SPEC A1).
 */
const TOKEN_FAIL_PER_MIN = 10
const TOKEN_FAIL_PER_HOUR = 100

/**
 * One pass over the last hour of failures answers both questions: the per-IP
 * window is a minute, which is inside the hour the global window already scans.
 * Two round trips in front of every QR scan is a cost the venue pays on the
 * busiest minute of the day, for an answer one query can give.
 */
export async function checkTokenLookupAllowed(ipHash: string | null) {
  const minuteAgo = new Date(Date.now() - 60_000)
  const hourAgo = new Date(Date.now() - 3_600_000)

  const [{ globalHour, perIp }] = await db
    .select({
      globalHour: sql<number>`count(*)::int`,
      // The timestamp goes in as an explicit ISO string: a bare Date inside a
      // raw fragment carries no type for the driver to serialise it with.
      perIp: ipHash
        ? sql<number>`count(*) filter (
            where ${tokenAttempts.ipHash} = ${ipHash}
              and ${tokenAttempts.at} >= ${minuteAgo.toISOString()}::timestamptz
          )::int`
        : sql<number>`0::int`,
    })
    .from(tokenAttempts)
    .where(and(eq(tokenAttempts.succeeded, false), gte(tokenAttempts.at, hourAgo)))

  // Order matters: a global lockout is reported as global even when the same
  // IP would also have tripped its own cap.
  if (globalHour >= TOKEN_FAIL_PER_HOUR) return { allowed: false as const, scope: 'global' as const }
  if (ipHash && perIp >= TOKEN_FAIL_PER_MIN) return { allowed: false as const, scope: 'ip' as const }

  return { allowed: true as const }
}

export async function recordTokenAttempt(
  kind: 'court' | 'registration',
  prefix: string | null,
  ipHash: string | null,
  ok: boolean,
) {
  await db.insert(tokenAttempts).values({ id: newId('ta'), kind, prefix, ipHash, succeeded: ok })
}
