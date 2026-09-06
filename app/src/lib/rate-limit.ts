import 'server-only'
import { and, desc, eq, gte, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { loginAttempts, users, tokenAttempts } from '@/db/schema'
import { newId } from './ids'

/**
 * Rate limiting lives in Postgres — in-memory counters are useless on serverless,
 * where every invocation may be a fresh instance (SPEC A9).
 */

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

/**
 * The same five-in-fifteen rule for any other guess-able check, keyed by
 * whatever names the actor — "pin-change:<userId>" for the change-PIN form,
 * whose "another organiser already uses that PIN" answer would otherwise be
 * a free oracle for the owner's PIN.
 */
export async function checkKeyAllowed(key: string) {
  const since = new Date(Date.now() - PIN_WINDOW_MIN * 60_000)
  const rows = await db
    .select({ at: loginAttempts.at })
    .from(loginAttempts)
    .where(and(eq(loginAttempts.identifier, key), eq(loginAttempts.succeeded, false), gte(loginAttempts.at, since)))
    .orderBy(desc(loginAttempts.at))
    .limit(PIN_MAX_FAILURES)
  if (rows.length >= PIN_MAX_FAILURES) {
    const until = rows[rows.length - 1]!.at.getTime() + PIN_WINDOW_MIN * 60_000
    return { allowed: false as const, retryInMinutes: Math.max(1, Math.ceil((until - Date.now()) / 60_000)) }
  }
  return { allowed: true as const }
}

export async function recordKeyAttempt(key: string, ok: boolean) {
  await db.insert(loginAttempts).values({ id: newId('la'), identifier: key, ipHash: null, succeeded: ok })
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
