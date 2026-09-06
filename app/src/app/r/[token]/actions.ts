'use server'

import { resolveRegistrationToken, submitRegistration } from '@/server/registration'
import { ensureReady } from '@/server/bootstrap'

export type RegState = { ok?: boolean; alreadyIn?: boolean; error?: string; name?: string }

/**
 * Public, no login. Everything is re-resolved from the token server-side: the
 * tournament id in the form is a hint, never an authorisation.
 */
export async function register(_prev: RegState, formData: FormData): Promise<RegState> {
  await ensureReady()
  const token = String(formData.get('token') ?? '')
  const view = await resolveRegistrationToken(token)
  if (!view) return { error: 'This link has expired. Ask the organiser for a new one.' }

  const categoryIds = formData.getAll('categoryIds').map(String)
  // A per-browser id the form carries, so a name already in the list belongs to
  // whoever put it there. The link lives in a group chat; without this anyone
  // holding it can rewrite anyone else's entry. Kept out of a cookie so the
  // page stays cookie-free.
  const raw = String(formData.get('deviceId') ?? '').trim()
  const deviceId = /^[A-Za-z0-9_-]{8,64}$/.test(raw) ? raw : null

  const res = await submitRegistration({
    tournamentId: view.tournament.id,
    name: String(formData.get('name') ?? ''),
    phone: String(formData.get('phone') ?? '') || null,
    categoryIds,
    partnerName: String(formData.get('partnerName') ?? '') || null,
    deviceId,
  })

  if (!res.ok) return { error: res.error }
  return { ok: true, alreadyIn: res.alreadyIn, name: String(formData.get('name') ?? '').trim() }
}
