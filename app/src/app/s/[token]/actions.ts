'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { ensureReady } from '@/server/bootstrap'
import { confirmSpot, leaveSession, resolveSpotToken } from '@/server/sessions'
import type { SpotOutcome } from './outcome'

/**
 * The two things a player can do to their own spot, from a link with no login.
 *
 * The token is the authority, and it is re-resolved here rather than trusted
 * from a hidden field — a participation id in a form is a wire value and proves
 * nothing about who is holding the phone.
 *
 * What comes back is a CODE, not a sentence — see `./outcome`, which holds the
 * codes because a `'use server'` module may only export async functions.
 */

function back(token: string, code: SpotOutcome): never {
  revalidatePath(`/s/${token}`)
  redirect(`/s/${token}?r=${code}` as never)
}

export async function confirmMySpot(formData: FormData) {
  await ensureReady()
  const token = String(formData.get('token') ?? '').slice(0, 200)
  const spot = await resolveSpotToken(token)
  if (!spot) back(token, 'gone')

  const res = await confirmSpot(spot.participant.id)
  if (!res.ok) back(token, spot.session.status === 'open' ? 'nothing' : 'over')
  back(token, 'confirmed')
}

export async function releaseMySpot(formData: FormData) {
  await ensureReady()
  const token = String(formData.get('token') ?? '').slice(0, 200)
  const spot = await resolveSpotToken(token)
  if (!spot) back(token, 'gone')

  const res = await leaveSession(
    spot.participant.id,
    { kind: 'player', label: 'player' },
    'let the spot go',
  )
  if (!res.ok) back(token, new Date() >= spot.session.startsAt ? 'started' : 'nothing')
  // Whether somebody moved up is worth saying; WHO moved up is not — their name
  // belongs to them, and some of them have asked to stay off the list entirely.
  back(token, res.promoted.length ? 'released-promoted' : 'released')
}
