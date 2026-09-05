'use server'

import { eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { db } from '@/db'
import { users } from '@/db/schema'
import { hashPassword, verifyPassword } from '@/lib/password'
import { requireUser } from '@/lib/auth'
import { revokeAllSessionsFor, createSession } from '@/lib/session'
import { recordAudit } from '@/lib/audit'

export type PwState = { error?: string; ok?: boolean }

export async function changePassword(_prev: PwState, formData: FormData): Promise<PwState> {
  const user = await requireUser('umpire')
  const current = String(formData.get('current') ?? '')
  const next = String(formData.get('next') ?? '')
  const confirm = String(formData.get('confirm') ?? '')

  if (next.length < 10) return { error: 'Use at least 10 characters.' }
  if (next !== confirm) return { error: 'The two new passwords don’t match.' }

  const row = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0]
  if (!row || !(await verifyPassword(row.passwordHash, current))) {
    return { error: 'Your current password is wrong.' }
  }

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(next),
      mustChangePassword: false,
      passwordChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(users.id, user.id))

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'password.change',
    entity: 'user',
    entityId: user.id,
  })

  // Every other device is signed out, then this one is signed back in.
  await revokeAllSessionsFor(user.id)
  await createSession({ ...user, mustChangePassword: false })

  redirect('/admin')
}
