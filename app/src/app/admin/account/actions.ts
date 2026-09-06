'use server'

import { eq } from 'drizzle-orm'
import { redirect } from 'next/navigation'
import { db } from '@/db'
import { users } from '@/db/schema'
import { verifyPin } from '@/lib/password'
import { requireUser } from '@/lib/auth'
import { revokeAllSessionsFor, createSession } from '@/lib/session'
import { recordAudit } from '@/lib/audit'
import { addOrganiser, normalizePin, removeOrganiser, setPin } from '@/server/organisers'

export type PinState = { error?: string; ok?: boolean }

/** Six digits that are not one digit six times, and not a run. */
function tooEasy(pin: string) {
  if (/^(\d)\1{5}$/.test(pin)) return true
  const up = '0123456789'
  const down = '9876543210'
  return up.includes(pin) || down.includes(pin)
}

export async function changePin(_prev: PinState, formData: FormData): Promise<PinState> {
  const user = await requireUser('admin', { allowPasswordChange: true })
  const current = normalizePin(formData.get('current'))
  const next = normalizePin(formData.get('next'))
  const confirm = normalizePin(formData.get('confirm'))

  if (!current) return { error: 'Type your current PIN — six digits.' }
  if (!next) return { error: 'The new PIN needs to be six digits.' }
  if (tooEasy(next)) return { error: 'Not that one — six of the same digit or a run like 123456 is the first thing anyone tries.' }
  if (next !== confirm) return { error: 'The two new PINs don’t match.' }

  const row = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0]
  if (!row?.pinHash || !(await verifyPin(row.pinHash, current))) {
    return { error: 'Your current PIN is wrong.' }
  }

  const set = await setPin(user.id, next)
  if (!set.ok) return { error: set.error }

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'pin.change',
    entity: 'user',
    entityId: user.id,
  })

  // Every other device is signed out, then this one is signed back in.
  await revokeAllSessionsFor(user.id)
  await createSession({ ...user, mustChangePassword: false })

  redirect('/admin')
}

function back(note?: string, err?: string): never {
  const q = new URLSearchParams()
  if (note) q.set('note', note)
  if (err) q.set('err', err)
  const qs = q.toString()
  redirect(`/admin/account${qs ? `?${qs}` : ''}` as never)
}

export async function addOrganiserAction(formData: FormData) {
  const user = await requireUser('super_admin')
  const res = await addOrganiser(formData.get('name'))
  if (!res.ok) return back(undefined, res.error)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'organiser.add',
    entity: 'user',
    entityId: res.id,
    after: { name: res.name },
  })
  // The PIN is said once, here, and nowhere else.
  back(`${res.name} is in. Their PIN is ${res.pin} — tell them, and they choose their own the first time they sign in.`)
}

export async function removeOrganiserAction(formData: FormData) {
  const user = await requireUser('super_admin')
  const userId = String(formData.get('userId') ?? '')
  const res = await removeOrganiser(userId, user.id)
  if (!res.ok) return back(undefined, res.error)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'organiser.remove',
    entity: 'user',
    entityId: userId,
  })
  back('Removed. Their PIN no longer works.')
}
