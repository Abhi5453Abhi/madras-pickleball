'use server'

import { resolveRegistrationToken, submitRegistration } from '@/server/registration'
import { ensureReady } from '@/server/bootstrap'

export type SignupState = { ok?: boolean; alreadyIn?: boolean; error?: string }

/**
 * Public, no login, no cookie. Everything is re-resolved from the token: the
 * form carries nothing that is trusted.
 */
export async function signUp(_prev: SignupState, formData: FormData): Promise<SignupState> {
  await ensureReady()
  const token = String(formData.get('token') ?? '')
  const view = await resolveRegistrationToken(token)
  if (!view) return { error: 'This link doesn’t work any more. Ask the organiser.' }
  if (view.closed) return { error: 'Sign-ups have closed — ask the organiser.' }

  // A per-browser id the form carries, so the same person reloading or coming
  // back to name a partner is recognised, and a second "Karthik" from another
  // phone is not silently taken to be the first. Kept out of a cookie so the
  // page stays cookie-free.
  const raw = String(formData.get('deviceId') ?? '').trim()
  const deviceId = /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null

  const res = await submitRegistration({
    tournamentId: view.tournament.id,
    name: String(formData.get('name') ?? '').slice(0, 200),
    phone: String(formData.get('phone') ?? '').slice(0, 40) || null,
    partnerName: String(formData.get('partnerName') ?? '').slice(0, 200) || null,
    deviceId,
  })
  if (!res.ok) return { error: res.error }
  return { ok: true, alreadyIn: res.alreadyIn }
}
