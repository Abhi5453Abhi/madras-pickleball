import 'server-only'
import { and, eq, gte, sql } from 'drizzle-orm'
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
 * Court/registration links: rate-limit FAILED resolutions per IP, never successes.
 * The scanner is the venue behind its NAT; a blanket per-IP cap would lock out the
 * whole club on the busiest minute of the day (SPEC A1).
 */
const TOKEN_FAIL_PER_MIN = 10
const TOKEN_FAIL_PER_HOUR = 100

export async function checkTokenLookupAllowed(ipHash: string | null) {
  const minuteAgo = new Date(Date.now() - 60_000)
  const hourAgo = new Date(Date.now() - 3_600_000)

  const [{ n: globalHour }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tokenAttempts)
    .where(and(eq(tokenAttempts.succeeded, false), gte(tokenAttempts.at, hourAgo)))
  if (globalHour >= TOKEN_FAIL_PER_HOUR) return { allowed: false as const, scope: 'global' as const }

  if (ipHash) {
    const [{ n: perIp }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(tokenAttempts)
      .where(
        and(
          eq(tokenAttempts.ipHash, ipHash),
          eq(tokenAttempts.succeeded, false),
          gte(tokenAttempts.at, minuteAgo),
        ),
      )
    if (perIp >= TOKEN_FAIL_PER_MIN) return { allowed: false as const, scope: 'ip' as const }
  }

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
