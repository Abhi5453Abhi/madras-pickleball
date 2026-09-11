'use server'

import { headers } from 'next/headers'
import { hashIp } from '@/lib/crypto'
import { checkJoinAllowed, recordJoin } from '@/lib/rate-limit'
import { ensureReady } from '@/server/bootstrap'
import { getSessionBySlug, joinSession } from '@/server/sessions'

/**
 * Joining a game from the public page. No login, no account, two fields.
 *
 * Everything is re-resolved from the slug server-side; nothing the form sends
 * is trusted beyond the name, the phone and this browser's own id.
 */

/**
 * What the browser is told.
 *
 * **`alreadyIn` is deliberately not in here.** Sending it back made the form a
 * one-request oracle: "already on the list" versus "you're in" answers *is this
 * number playing tonight* for any number, under any name, and the early return
 * costs an attacker nothing — no player row, no seat, nothing on the host's
 * screen. Both outcomes now render the same sentence, and the only thing that
 * distinguishes the person who actually holds the spot is that a token comes
 * back, which requires the device to match.
 *
 * A residual signal survives and is worth naming: the public page shows the
 * count, so anybody can watch whether joining moved it. Limits make that slow;
 * only the OTP at stage 5 makes it wrong.
 */
export type JoinState = {
  ok?: boolean
  error?: string
  /** They got a seat, or they are on the waitlist. */
  waiting?: boolean
  /** The capability for managing this spot. Returned once, stored on the device. */
  token?: string | null
  name?: string
}

const DEVICE = /^[A-Za-z0-9_-]{8,64}$/

export async function joinGame(_prev: JoinState, formData: FormData): Promise<JoinState> {
  await ensureReady()

  const slug = String(formData.get('slug') ?? '').slice(0, 80)
  const name = String(formData.get('name') ?? '').slice(0, 80)
  const phone = String(formData.get('phone') ?? '').slice(0, 24)
  const rawDevice = String(formData.get('deviceId') ?? '')
  const deviceId = DEVICE.test(rawDevice) ? rawDevice : null
  const hideFromPublic = formData.get('hideFromPublic') === 'on'

  const session = await getSessionBySlug(slug)
  // Same answer for "no such game" and "not published": the existence of an
  // unpublished game is not public either.
  if (!session || session.status === 'draft') {
    return { error: 'That game isn’t on the list any more. Ask the host.' }
  }

  const h = await headers()
  const ipHash = hashIp(h.get('x-forwarded-for')?.split(',')[0]?.trim())

  const gate = await checkJoinAllowed(deviceId, ipHash)
  if (!gate.allowed) {
    return {
      error:
        gate.scope === 'device'
          ? 'That’s a lot of sign-ups from this phone. Give it an hour, or ask the host to put you on.'
          : 'That’s a lot of sign-ups from one connection. Give it a little while, or ask the host to put you on.',
    }
  }

  const res = await joinSession({
    sessionId: session.id,
    name,
    phone,
    source: 'self',
    deviceId,
    ipHash,
    hideFromPublic,
  })
  if (!res.ok) return { error: res.error }

  await recordJoin(deviceId, ipHash)

  return { ok: true, waiting: res.waiting, token: res.token, name: name.trim() }
}
