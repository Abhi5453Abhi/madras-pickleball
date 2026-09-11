import 'server-only'
import { and, desc, eq, gte, inArray, isNull, sql } from 'drizzle-orm'
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
    // Scoped to the QR and sign-up links this gate was written for. A daily-game
    // spot link is a PUBLIC surface — the URL gets forwarded into WhatsApp
    // groups — and feeding its failures into a venue-wide hourly ceiling would
    // hand anyone on the internet a switch that turns off every court QR and
    // every tournament sign-up link for an hour. Spot links have their own
    // budget below.
    .where(
      and(
        inArray(tokenAttempts.kind, ['court', 'registration']),
        eq(tokenAttempts.succeeded, false),
        gte(tokenAttempts.at, hourAgo),
      ),
    )

  // Order matters: a global lockout is reported as global even when the same
  // IP would also have tripped its own cap.
  if (globalHour >= TOKEN_FAIL_PER_HOUR) return { allowed: false as const, scope: 'global' as const }
  if (ipHash && perIp >= TOKEN_FAIL_PER_MIN) return { allowed: false as const, scope: 'ip' as const }

  return { allowed: true as const }
}

export async function recordTokenAttempt(
  kind: 'court' | 'registration' | 'spot',
  prefix: string | null,
  ipHash: string | null,
  ok: boolean,
) {
  await db.insert(tokenAttempts).values({ id: newId('ta'), kind, prefix, ipHash, succeeded: ok })
}

/**
 * Somebody opening their own spot link, /s/<token>.
 *
 * Failures only, per IP, with NO global ceiling. The token is 160 random bits,
 * so this is not standing between an attacker and a guess — it is there to make
 * spraying pointless and to keep the noise out of the court-token gate above.
 * A venue-wide lockout on a public URL would be a denial of service anyone
 * could trigger with a hundred requests.
 */
/**
 * Deliberately high. The token is 160 random bits, so nothing here is standing
 * between an attacker and a guess — this is hygiene, to stop a spray filling
 * the table and the logs. Set low it would be worse than useless: the venue is
 * one NAT, so a tight per-IP cap on a PUBLIC URL is something anybody on the
 * club Wi-Fi could spend to lock everybody else out of their own spot links.
 */
const SPOT_FAIL_PER_HOUR = 300
/** A request with no forwarded IP is its own bucket, never an exemption. */
const NO_IP = 'no-ip'

export async function checkSpotLookupAllowed(ipHash: string | null) {
  const hourAgo = new Date(Date.now() - 3_600_000)
  const key = ipHash ?? NO_IP
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(tokenAttempts)
    .where(
      and(
        eq(tokenAttempts.kind, 'spot'),
        eq(tokenAttempts.succeeded, false),
        eq(tokenAttempts.ipHash, key),
        gte(tokenAttempts.at, hourAgo),
      ),
    )
  return Number(row?.n ?? 0) >= SPOT_FAIL_PER_HOUR
    ? { allowed: false as const }
    : { allowed: true as const }
}

/**
 * Joining a daily game.
 *
 * Per IP **and** per device, and no venue-wide ceiling.
 *
 * The device id comes from the browser, so a script simply sends a fresh one
 * each time — it is a courtesy limit, not a control, and on its own it stops
 * nobody. The IP is the real gate. Sixteen people signing up from the venue's
 * one Wi-Fi connection is the busiest minute of the week, so the per-IP number
 * is generous enough to swallow a whole Tuesday and still refuse a script.
 *
 * A global ceiling was the first version of this and was wrong for the same
 * reason the court-token gate's is: it is a switch anyone on the internet can
 * flip to stop the venue taking sign-ups. The structural defence against
 * list-stuffing is that one phone number holds one spot per game, which
 * `joinSession` enforces before it resolves a player at all.
 */
const JOIN_PER_DEVICE_HOUR = 10
const JOIN_PER_IP_HOUR = 60

export async function checkJoinAllowed(deviceId: string | null, ipHash: string | null) {
  const hourAgo = new Date(Date.now() - 3_600_000)
  const [row] = await db
    .select({
      perIp: ipHash
        ? sql<number>`count(*) filter (where ${tokenAttempts.ipHash} = ${ipHash})::int`
        : sql<number>`0::int`,
      perDevice: deviceId
        ? sql<number>`count(*) filter (where ${tokenAttempts.prefix} = ${deviceId})::int`
        : sql<number>`0::int`,
    })
    .from(tokenAttempts)
    .where(and(eq(tokenAttempts.kind, 'join'), gte(tokenAttempts.at, hourAgo)))

  if (ipHash && Number(row?.perIp ?? 0) >= JOIN_PER_IP_HOUR) return { allowed: false as const, scope: 'ip' as const }
  if (deviceId && Number(row?.perDevice ?? 0) >= JOIN_PER_DEVICE_HOUR) {
    return { allowed: false as const, scope: 'device' as const }
  }
  return { allowed: true as const }
}

export async function recordJoin(deviceId: string | null, ipHash: string | null) {
  await db
    .insert(tokenAttempts)
    .values({ id: newId('ta'), kind: 'join', prefix: deviceId, ipHash, succeeded: true })
}
