'use server'

import { eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { db } from '@/db'
import { users } from '@/db/schema'
import { verifyPassword } from '@/lib/password'
import { createSession, destroySession } from '@/lib/session'
import { checkLoginAllowed, recordLoginAttempt } from '@/lib/rate-limit'
import { hashIp } from '@/lib/crypto'

export type LoginState = { error?: string }

export async function login(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get('username') ?? '')
    .trim()
    .toLowerCase()
  const password = String(formData.get('password') ?? '')

  if (!username || !password) return { error: 'Enter your username and password.' }

  const gate = await checkLoginAllowed(username)
  if (!gate.allowed) {
    return {
      error: `Too many attempts. Try again in ${gate.retryInMinutes} minute${gate.retryInMinutes === 1 ? '' : 's'}, or ask the organiser to reset it.`,
    }
  }

  const h = await headers()
  const ipHash = hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim())

  const row = (await db.select().from(users).where(eq(users.username, username)).limit(1))[0]

  // Same message and roughly the same work either way, so login is not a
  // user-enumeration oracle (SPEC A9).
  const ok = row && row.active && !row.deletedAt && (await verifyPassword(row.passwordHash, password))

  await recordLoginAttempt(username, ipHash, !!ok)
  if (!ok || !row) return { error: 'That username and password don’t match.' }

  await createSession({
    id: row.id,
    name: row.name,
    username: row.username,
    role: row.role,
    mustChangePassword: row.mustChangePassword,
  })

  // redirect() throws, so it must be the last thing and outside any try block.
  // An umpire has no admin area to land in; sending them there and bouncing
  // them straight back reads as a broken login.
  redirect(
    row.mustChangePassword
      ? '/admin/account?first=1'
      : row.role === 'umpire'
        ? '/umpire'
        : '/admin',
  )
}

export async function logout() {
  await destroySession()
  redirect('/login')
}
