'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { finishEvent, startEvent } from '@/server/events'
import { getTournamentBySlug } from '@/server/tournaments'

async function load(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug') ?? '')
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) redirect('/admin')
  return { user, slug, tournament }
}

export async function startEventAction(formData: FormData) {
  const { user, slug, tournament } = await load(formData)
  const res = await startEvent(tournament.id)
  if (!res.ok) redirect(`/admin/t/${slug}?err=${encodeURIComponent(res.error)}` as never)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.start',
    entity: 'tournament',
    entityId: tournament.id,
  })
  revalidatePath('/admin', 'layout')
  redirect('/admin/live')
}

export async function finishEventAction(formData: FormData) {
  const { user, slug, tournament } = await load(formData)
  const res = await finishEvent(tournament.id)
  if (!res.ok) redirect(`/admin/t/${slug}?err=${encodeURIComponent(res.error)}` as never)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.finish',
    entity: 'tournament',
    entityId: tournament.id,
  })
  revalidatePath('/admin', 'layout')
  redirect(`/admin/t/${slug}` as never)
}
