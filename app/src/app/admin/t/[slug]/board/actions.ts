'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { sendToCourt, clearCourt } from '@/server/board'

export async function placeMatch(formData: FormData) {
  const user = await requireUser('admin')
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
    revalidatePath(`/admin/t/${slug}/board`)
    return
  }

  // sendToCourt refuses for six different reasons, and the most likely one is
  // the player conflict this product exists to surface. Throwing the sentence
  // away meant the organiser tapped the big terracotta button, the page
  // re-rendered unchanged, and nothing said why.
  revalidatePath(`/admin/t/${slug}/board`)
  redirect(`/admin/t/${slug}/board?err=${encodeURIComponent(result.error)}` as never)
}

export async function takeOffCourt(formData: FormData) {
  const user = await requireUser('admin')
  const matchId = String(formData.get('matchId'))
  const slug = String(formData.get('slug'))
  const cleared = await clearCourt(matchId)
  if (!cleared.ok) {
    revalidatePath(`/admin/t/${slug}/board`)
    redirect(`/admin/t/${slug}/board?err=${encodeURIComponent(cleared.error)}` as never)
  }
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'match.clear_court',
    entity: 'match',
    entityId: matchId,
  })
  revalidatePath(`/admin/t/${slug}/board`)
}
