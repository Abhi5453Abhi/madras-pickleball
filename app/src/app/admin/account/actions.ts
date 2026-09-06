'use server'

import { eq } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { db } from '@/db'
import { users } from '@/db/schema'
import { verifyPin } from '@/lib/password'
import { requireUser } from '@/lib/auth'
import { revokeAllSessionsFor, createSession } from '@/lib/session'
import { recordAudit } from '@/lib/audit'
import { checkKeyAllowed, recordKeyAttempt } from '@/lib/rate-limit'
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

  // Five wrong goes in fifteen minutes and this form waits, like sign-in:
  // both "your current PIN is wrong" and "another organiser uses that one"
  // are answers a patient guesser could learn from.
  const key = `pin-change:${user.id}`
  const gate = await checkKeyAllowed(key)
  if (!gate.allowed) {
    return { error: `Too many tries. Come back in ${gate.retryInMinutes} minute${gate.retryInMinutes === 1 ? '' : 's'}.` }
  }

  const row = (await db.select().from(users).where(eq(users.id, user.id)).limit(1))[0]
  if (!row?.pinHash || !(await verifyPin(row.pinHash, current))) {
    await recordKeyAttempt(key, false)
    return { error: 'Your current PIN is wrong.' }
  }

  const set = await setPin(user.id, next)
  if (!set.ok) {
    await recordKeyAttempt(key, false)
    return { error: set.error }
  }
  await recordKeyAttempt(key, true)

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

export type AddOrganiserState = { error?: string; name?: string; pin?: string; done: number }

/**
 * The new organiser's PIN comes back in the action's own response — never in
 * a URL, which would put it in browser history and in the host's logs.
 */
export async function addOrganiserAction(
  prev: AddOrganiserState,
  formData: FormData,
): Promise<AddOrganiserState> {
  const user = await requireUser('super_admin')
  const res = await addOrganiser(formData.get('name'))
  if (!res.ok) return { error: res.error, done: prev.done }
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'organiser.add',
    entity: 'user',
    entityId: res.id,
    after: { name: res.name },
  })
  revalidatePath('/admin/account')
  return { name: res.name, pin: res.pin, done: prev.done + 1 }
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
