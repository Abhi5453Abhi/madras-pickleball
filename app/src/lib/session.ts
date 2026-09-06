import 'server-only'
import { cookies, headers } from 'next/headers'
import { and, eq, gt } from 'drizzle-orm'
import { db } from '@/db'
import { sessions, users } from '@/db/schema'
import { newSessionToken, sha256Hex, hashIp } from './crypto'

/**
 * DB-backed sessions, not stateless JWTs: Super Admin deactivating an account
 * has to actually take effect (SPEC A9).
 */
const PROD = process.env.NODE_ENV === 'production'
export const SESSION_COOKIE = PROD ? '__Host-mpb_session' : 'mpb_session'

const ADMIN_TTL_MS = 1000 * 60 * 60 * 24 * 14
/** Umpire sessions die at the end of the tournament day — these are shared phones. */
const UMPIRE_TTL_MS = 1000 * 60 * 60 * 14

export type SessionUser = {
  id: string
  name: string
  username: string
  role: 'super_admin' | 'admin' | 'umpire'
  mustChangePassword: boolean
}

function ttlFor(role: SessionUser['role']) {
  return role === 'umpire' ? UMPIRE_TTL_MS : ADMIN_TTL_MS
}

export async function createSession(user: SessionUser) {
  const { raw, hash } = newSessionToken()
  const h = await headers()
  const expiresAt = new Date(Date.now() + ttlFor(user.role))

  await db.insert(sessions).values({
    idHash: hash,
    userId: user.id,
    expiresAt,
    userAgent: h.get('user-agent')?.slice(0, 256) ?? null,
    ipHash: hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim()),
  })

  const jar = await cookies()
  jar.set(SESSION_COOKIE, raw, {
    httpOnly: true,
    secure: PROD,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
}

/** Returns the signed-in user, or null. Checks `active` on every request. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value
  if (!raw) return null

  const idHash = sha256Hex(raw)
  const rows = await db
    .select({
      idHash: sessions.idHash,
      expiresAt: sessions.expiresAt,
      id: users.id,
      name: users.name,
      username: users.username,
      role: users.role,
      active: users.active,
      deletedAt: users.deletedAt,
      mustChangePassword: users.mustChangePassword,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.idHash, idHash), gt(sessions.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  if (!row || !row.active || row.deletedAt) return null

  // Sliding refresh past 50% elapsed, so an all-day organiser is never logged out mid-match.
  const ttl = ttlFor(row.role)
  if (row.expiresAt.getTime() - Date.now() < ttl / 2) {
    const next = new Date(Date.now() + ttl)
    await db
      .update(sessions)
      .set({ expiresAt: next, lastSeenAt: new Date() })
      .where(eq(sessions.idHash, idHash))
  }

  return {
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
  }
}

export async function destroySession() {
  const jar = await cookies()
  const raw = jar.get(SESSION_COOKIE)?.value
  if (raw) await db.delete(sessions).where(eq(sessions.idHash, sha256Hex(raw)))
  jar.delete(SESSION_COOKIE)
}

/** Called when an account is deactivated or its password is reset. */
export async function revokeAllSessionsFor(userId: string) {
  await db.delete(sessions).where(eq(sessions.userId, userId))
}

