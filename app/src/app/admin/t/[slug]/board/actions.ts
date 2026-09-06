'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { sendToCourt, clearCourt } from '@/server/board'

export async function placeMatch(formData: FormData) {
  const user = await requireUser('umpire')
  const matchId = String(formData.get('matchId'))
  const courtId = String(formData.get('courtId'))
  const slug = String(formData.get('slug'))

  const result = await sendToCourt(matchId, courtId)
  if (result.ok) {
    await recordAudit({
      userId: user.id,
      actorLabel: user.username,
      action: 'match.send_to_court',
      entity: 'match',
      entityId: matchId,
      after: { courtId },
    })
  }
  revalidatePath(`/admin/t/${slug}/board`)
}

export async function takeOffCourt(formData: FormData) {
  const user = await requireUser('umpire')
  const matchId = String(formData.get('matchId'))
  const slug = String(formData.get('slug'))
  await clearCourt(matchId)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'match.clear_court',
    entity: 'match',
    entityId: matchId,
  })
  revalidatePath(`/admin/t/${slug}/board`)
}
