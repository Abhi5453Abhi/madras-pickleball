import 'server-only'
import { redirect } from 'next/navigation'
import { getSessionUser, type SessionUser } from './session'

export type Role = SessionUser['role']

const RANK: Record<Role, number> = { umpire: 1, admin: 2, super_admin: 3 }

export function atLeast(user: SessionUser | null, role: Role): boolean {
  return !!user && RANK[user.role] >= RANK[role]
}

/**
 * Where a signed-in person belongs when they land somewhere they may not be.
 * Sending an umpire to `/admin?denied=1` would bounce them straight back off
 * `/admin`'s own admin guard — a redirect loop, in front of a queue.
 */
export function homeFor(user: SessionUser): string {
  return user.role === 'umpire' ? '/umpire' : '/admin'
}

export type GuardOptions = {
  /**
   * Only the page that replaces a temporary password may be reached while one
   * is still in force. Everything else waits.
   */
  allowPasswordChange?: boolean
}

/**
 * Server-side guard. Middleware is a cheap redirect only and is never the
 * authorization boundary (SPEC A9).
 */
export async function requireUser(role: Role = 'umpire', opts?: GuardOptions): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  // A temporary password is a credential read off a slip of paper and typed on
  // a shared phone. It opens exactly one door: the one that replaces it.
  if (user.mustChangePassword && !opts?.allowPasswordChange) redirect('/admin/account?first=1')
  if (!atLeast(user, role)) {
    redirect(user.role === 'umpire' ? '/umpire?denied=1' : '/admin?denied=1')
  }
  return user
}

export async function currentUser(): Promise<SessionUser | null> {
  return getSessionUser()
}
