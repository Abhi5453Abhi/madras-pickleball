import 'server-only'
import { redirect } from 'next/navigation'
import { getSessionUser, type SessionUser } from './session'

export type Role = SessionUser['role']

const RANK: Record<Role, number> = { umpire: 1, admin: 2, super_admin: 3 }

export function atLeast(user: SessionUser | null, role: Role): boolean {
  return !!user && RANK[user.role] >= RANK[role]
}

/**
 * Server-side guard. Middleware is a cheap redirect only and is never the
 * authorization boundary (SPEC A9).
 */
export async function requireUser(role: Role = 'umpire'): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  if (!atLeast(user, role)) redirect('/admin?denied=1')
  return user
}

export async function currentUser(): Promise<SessionUser | null> {
  return getSessionUser()
}
