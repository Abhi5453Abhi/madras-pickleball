'use server'

import { resolveRegistrationToken, submitRegistration, submitTeamRegistration } from '@/server/registration'
import { ensureReady } from '@/server/bootstrap'

export type SignupState = { ok?: boolean; alreadyIn?: boolean; error?: string }

/**
 * Public, no login, no cookie. Everything is re-resolved from the token: the
 * form carries nothing that is trusted.
 *
 * `registerTeammate` (sent only for doubles, when the "sign them up too"
 * checkbox is on) switches this from naming a wish to registering both
 * people and pairing them on the spot — see `submitTeamRegistration`.
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

  const name = String(formData.get('name') ?? '').slice(0, 200)
  const phone = String(formData.get('phone') ?? '').slice(0, 40) || null
  const partnerName = String(formData.get('partnerName') ?? '').slice(0, 200) || null
  const registerTeammate = view.discipline === 'doubles' && formData.get('registerTeammate') === 'on'

  const res =
    registerTeammate && partnerName
      ? await submitTeamRegistration({
          tournamentId: view.tournament.id,
          name,
          phone,
          teammateName: partnerName,
          deviceId,
        })
      : await submitRegistration({
          tournamentId: view.tournament.id,
          name,
          phone,
          partnerName,
          deviceId,
        })
  if (!res.ok) return { error: res.error }
  return { ok: true, alreadyIn: res.alreadyIn }
}
