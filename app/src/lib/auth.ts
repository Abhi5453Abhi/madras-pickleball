import 'server-only'
import { redirect } from 'next/navigation'
import { getSessionUser, type SessionUser } from './session'

export type Role = SessionUser['role']

/**
 * The organiser is the only person who signs in (SPEC v4). The umpire role is
 * still a value in the database enum — rows from earlier versions may carry
 * it — but it opens nothing: an umpire account can neither sign in nor pass a
 * guard, and there is no screen made for one.
 */
const RANK: Record<Role, number> = { umpire: 0, admin: 2, super_admin: 3 }

export function atLeast(user: SessionUser | null, role: Role): boolean {
  return !!user && RANK[user.role] >= RANK[role]
}

/** Where a signed-in person belongs. There is one answer now. */
export function homeFor(): string {
  return '/admin'
}

export type GuardOptions = {
  /**
   * Only the page that replaces a temporary PIN may be reached while one is
   * still in force. Everything else waits.
   */
  allowPasswordChange?: boolean
}

/**
 * Server-side guard. Middleware is a cheap redirect only and is never the
 * authorization boundary (SPEC A9).
 */
export async function requireUser(role: Role = 'admin', opts?: GuardOptions): Promise<SessionUser> {
  const user = await getSessionUser()
  if (!user) redirect('/login')
  // A temporary PIN is a credential read off a terminal and typed on a shared
  // phone. It opens exactly one door: the one that replaces it.
  // A session that is not an organiser's is not a session here.
  if (!atLeast(user, 'admin')) redirect('/login')
  if (user.mustChangePassword && !opts?.allowPasswordChange) redirect('/admin/account?first=1')
  if (!atLeast(user, role)) redirect('/admin?denied=1')
  return user
}

export async function currentUser(): Promise<SessionUser | null> {
  const user = await getSessionUser()
  // An umpire session from an earlier version is not a signed-in organiser.
  return user && atLeast(user, 'admin') ? user : null
}
