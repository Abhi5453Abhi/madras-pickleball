'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { endOfVenueDay } from '@/lib/time'
import {
  approveRegistration,
  listPendingRegistrations,
  issueRegistrationLink,
  pairApproved,
  rejectRegistration,
  revokeRegistrationLink,
} from '@/server/registration'
import { getTournamentBySlug } from '@/server/tournaments'

export type LinkState = { link?: string; error?: string }

/**
 * The link is shown ONCE, right after it's made. Storing only the hash means
 * nobody — including a leaked database — can reconstruct it later, which is the
 * point; it also means the organiser has to copy it now.
 */
export async function makeLink(_prev: LinkState, formData: FormData): Promise<LinkState> {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const t = await getTournamentBySlug(slug)
  if (!t) return { error: 'That tournament no longer exists.' }

  const raw = await issueRegistrationLink(t.id, endOfVenueDay(t.endDate))
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'registration.link_issued',
    entity: 'tournament',
    entityId: t.id,
  })
  revalidatePath(`/admin/t/${slug}/registrations`)
  return { link: `/r/${raw}` }
}

export async function closeLink(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const t = await getTournamentBySlug(slug)
  if (!t) return
  await revokeRegistrationLink(t.id)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'registration.link_closed',
    entity: 'tournament',
    entityId: t.id,
  })
  revalidatePath(`/admin/t/${slug}/registrations`)
}

export async function approve(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const id = String(formData.get('id'))
  const linkPlayerId = String(formData.get('linkPlayerId') ?? '') || null

  // The id comes off a form. Like every other action here, it has to resolve
  // back to the tournament named in the URL.
  const t = await getTournamentBySlug(slug)
  if (!t) return
  const rows = await listPendingRegistrations(t.id)
  if (!rows.some((r) => r.id === id)) return

  const res = await approveRegistration(id, { linkPlayerId })
  if (res.ok) {
    await recordAudit({
      userId: user.id,
      actorLabel: user.username,
      action: 'registration.approved',
      entity: 'registration',
      entityId: id,
      after: { playerId: res.playerId, mergedWithExisting: !!linkPlayerId },
    })
  }
  revalidatePath(`/admin/t/${slug}/registrations`)
  revalidatePath(`/admin/t/${slug}`)
  if (!res.ok) {
    redirect(`/admin/t/${slug}/registrations?err=${encodeURIComponent(res.error)}` as never)
  }
}

export async function reject(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const id = String(formData.get('id'))

  const t = await getTournamentBySlug(slug)
  if (!t) return
  const rows = await listPendingRegistrations(t.id)
  if (!rows.some((r) => r.id === id)) return

  await rejectRegistration(id, 'not going ahead')
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'registration.rejected',
    entity: 'registration',
    entityId: id,
  })
  revalidatePath(`/admin/t/${slug}/registrations`)
}

/** Both of them named each other and both are on the roster — make the team. */
export async function makePair(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const categoryId = String(formData.get('categoryId'))
  const playerIds = String(formData.get('playerIds')).split(',').filter(Boolean)

  const t = await getTournamentBySlug(slug)
  if (!t) return

  // The names come from the players' own rows, not from the form.
  const res = await pairApproved(t.id, categoryId, playerIds)
  if (res.ok) {
    await recordAudit({
      userId: user.id,
      actorLabel: user.username,
      action: 'team.created_from_registration',
      entity: 'team',
      entityId: res.teamId,
      after: { name: res.name },
    })
  }
  revalidatePath(`/admin/t/${slug}/registrations`)
  revalidatePath(`/admin/t/${slug}`)
  if (!res.ok) {
    redirect(`/admin/t/${slug}/registrations?err=${encodeURIComponent(res.error)}` as never)
  }
}
