'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { addCourt, removeCourt, renameCourt } from '@/server/venue'

function back(note?: string, err?: string): never {
  const q = new URLSearchParams()
  if (note) q.set('note', note)
  if (err) q.set('err', err)
  const s = q.toString()
  redirect(`/admin/courts${s ? `?${s}` : ''}` as never)
}

export async function addCourtAction(formData: FormData) {
  const user = await requireUser('admin')
  const res = await addCourt(formData.get('name'))
  if (!res.ok) back(undefined, res.error)
  await recordAudit({ userId: user.id, actorLabel: user.username, action: 'court.add', entity: 'venue', entityId: 'venue', after: { name: String(formData.get('name') ?? '') } })
  revalidatePath('/admin', 'layout')
  back(`${String(formData.get('name') ?? '').trim()} is in.`)
}

export async function renameCourtAction(formData: FormData) {
  const user = await requireUser('admin')
  const courtId = String(formData.get('courtId') ?? '')
  const res = await renameCourt(courtId, formData.get('name'))
  if (!res.ok) back(undefined, res.error)
  await recordAudit({ userId: user.id, actorLabel: user.username, action: 'court.rename', entity: 'court', entityId: courtId, after: { name: String(formData.get('name') ?? '') } })
  revalidatePath('/admin', 'layout')
  revalidatePath('/', 'layout')
  back('Renamed.')
}

export async function removeCourtAction(formData: FormData) {
  const user = await requireUser('admin')
  const courtId = String(formData.get('courtId') ?? '')
  const res = await removeCourt(courtId)
  if (!res.ok) back(undefined, res.error)
  await recordAudit({ userId: user.id, actorLabel: user.username, action: 'court.remove', entity: 'court', entityId: courtId })
  revalidatePath('/admin', 'layout')
  revalidatePath('/', 'layout')
  back('Taken out. Add it again any time and it comes back with its history.')
}
