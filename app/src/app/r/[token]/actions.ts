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
  const res = await submitRegistration({
    tournamentId: view.tournament.id,
    name: String(formData.get('name') ?? ''),
    phone: String(formData.get('phone') ?? '') || null,
    categoryIds,
    partnerName: String(formData.get('partnerName') ?? '') || null,
  })

  if (!res.ok) return { error: res.error }
  return { ok: true, alreadyIn: res.alreadyIn, name: String(formData.get('name') ?? '').trim() }
}
