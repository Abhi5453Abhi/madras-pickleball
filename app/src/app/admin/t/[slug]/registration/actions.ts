'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { closeRegistration, reopenRegistration } from '@/server/events'
import { addPlayerByHand, addPlayersByHand, keepBoth, mergePlayers, removePlayer } from '@/server/registration'
import { getTournamentBySlug } from '@/server/tournaments'

/**
 * Every action re-resolves the tournament from the slug in the form and checks
 * the player ids against it. The ids arrive from a form; the slug is the only
 * thing the URL vouches for.
 */

function back(slug: string, q?: { note?: string; err?: string }): never {
  const qs = q?.err
    ? `?err=${encodeURIComponent(q.err)}`
    : q?.note
      ? `?note=${encodeURIComponent(q.note)}`
      : ''
  revalidatePath(`/admin/t/${slug}/registration`)
  revalidatePath(`/admin/t/${slug}`)
  redirect(`/admin/t/${slug}/registration${qs}` as never)
}

export async function closeSignups(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug') ?? '')
  const t = await getTournamentBySlug(slug)
  if (!t) return
  await closeRegistration(t.id)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'registration.closed',
    entity: 'tournament',
    entityId: t.id,
  })
  back(slug)
}

export async function reopenSignups(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug') ?? '')
  const t = await getTournamentBySlug(slug)
  if (!t) return
  if (t.status === 'live' || t.status === 'completed' || t.status === 'archived') {
    back(slug, { err: 'The tournament has started, so sign-ups stay closed.' })
  }
  await reopenRegistration(t.id)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'registration.reopened',
    entity: 'tournament',
    entityId: t.id,
  })
  back(slug)
}

export type AddState = { error?: string; done: number }

/** "Add a player — name, phone optional". One line, parsed like a pasted list. */
export async function addByHand(prev: AddState, formData: FormData): Promise<AddState> {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug') ?? '')
  const text = String(formData.get('text') ?? '')
  const t = await getTournamentBySlug(slug)
  if (!t) return { error: 'That tournament no longer exists.', done: prev.done }

  // One name, or the whole list pasted from the group chat.
  const many = /\n/.test(text.trim())
  if (many) {
    const res = await addPlayersByHand(t.id, text)
    if (!res.ok) return { error: res.error, done: prev.done }
    await recordAudit({
      userId: user.id,
      actorLabel: user.username,
      action: 'registration.pasted_list',
      entity: 'tournament',
      entityId: t.id,
      after: { added: res.added, skipped: res.skipped, flagged: res.flagged },
    })
    revalidatePath(`/admin/t/${slug}/registration`)
    revalidatePath(`/admin/t/${slug}`)
    if (res.added === 0) return { error: 'Everyone in that list is already on it.', done: prev.done }
    return { done: prev.done + 1 }
  }

  const res = await addPlayerByHand(t.id, text)
  if (!res.ok) return { error: res.error, done: prev.done }
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'registration.added_by_hand',
    entity: 'player',
    entityId: res.playerId,
    after: { flagged: res.flagged?.name ?? null },
  })
  revalidatePath(`/admin/t/${slug}/registration`)
  revalidatePath(`/admin/t/${slug}`)
  return { done: prev.done + 1 }
}

export async function remove(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug') ?? '')
  const playerId = String(formData.get('playerId') ?? '')
  const t = await getTournamentBySlug(slug)
  if (!t) return
  const res = await removePlayer(t.id, playerId)
  if (!res.ok) back(slug, { err: res.error })
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'registration.removed',
    entity: 'player',
    entityId: playerId,
  })
  back(slug, { note: res.note })
}

/** "Same as Ravi Shankar?" — Same person merges, Different clears the flag. */
export async function settleDuplicate(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug') ?? '')
  const playerId = String(formData.get('playerId') ?? '')
  const keepId = String(formData.get('keepId') ?? '')
  const same = String(formData.get('decision') ?? '') === 'same'
  const t = await getTournamentBySlug(slug)
  if (!t) return

  if (!same) {
    await keepBoth(t.id, playerId)
    await recordAudit({
      userId: user.id,
      actorLabel: user.username,
      action: 'registration.kept_both',
      entity: 'player',
      entityId: playerId,
    })
    back(slug)
  }

  const res = await mergePlayers(t.id, keepId, playerId)
  if (!res.ok) back(slug, { err: res.error })
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'registration.merged',
    entity: 'player',
    entityId: keepId,
    after: { droppedPlayerId: playerId },
  })
  back(slug, { note: res.note })
}
