'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { venueDayKey, venueInstant } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { blockCourt, unblockCourt } from '@/server/courts'

/**
 * Taking a court out of action, and giving it back.
 *
 * A block is a hold like any other — the same table, the same quarter-hour
 * index — so a blocked court cannot also be a tournament's, and the refusal
 * comes from Postgres rather than from remembering to check.
 */

function back(dayKey: string, q?: { note?: string; err?: string }): never {
  const params = new URLSearchParams({ day: dayKey })
  if (q?.err) params.set('err', q.err)
  else if (q?.note) params.set('note', q.note)
  revalidatePath('/admin/courts/day')
  revalidatePath('/admin/live')
  redirect(`/admin/courts/day?${params.toString()}` as never)
}

export async function blockCourtAction(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()

  const dayRaw = String(formData.get('day') ?? '')
  const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(dayRaw) ? dayRaw : venueDayKey()
  const courtId = String(formData.get('courtId') ?? '')
  const reason = String(formData.get('reason') ?? '').slice(0, 80)

  const from = venueInstant(dayKey, String(formData.get('from') ?? ''))
  const untilSameDay = venueInstant(dayKey, String(formData.get('until') ?? ''))
  if (!courtId || !from || !untilSameDay) back(dayKey, { err: 'Pick a court and both times.' })
  // "22:00 until 00:30" is a real evening, not a typo.
  const until =
    untilSameDay <= from ? new Date(untilSameDay.getTime() + 24 * 3600_000) : untilSameDay

  const res = await blockCourt({ courtId, reason, from, until, createdByUserId: user.id })
  if (!res.ok) back(dayKey, { err: res.error })

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'court.blocked',
    entity: 'court',
    entityId: courtId,
    after: { reason, from, until },
  })
  back(dayKey, { note: 'Out of action. It comes back on its own at the time you set.' })
}

export async function unblockCourtAction(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()

  const dayRaw = String(formData.get('day') ?? '')
  const dayKey = /^\d{4}-\d{2}-\d{2}$/.test(dayRaw) ? dayRaw : venueDayKey()
  const holdId = String(formData.get('holdId') ?? '')

  const res = await unblockCourt(holdId)
  if (!res.ok) back(dayKey, { err: res.error })

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'court.unblocked',
    entity: 'court',
    entityId: holdId,
  })
  back(dayKey, { note: 'Back in play.' })
}
