'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { flowTournament, sendToCourt } from '@/server/board'
import { getTournamentBySlug } from '@/server/tournaments'

/**
 * Send one match to one court by hand. The flow does this on its own now;
 * this is the More page's attention row, kept for the rare court that came
 * free by a door the flow does not watch.
 */
export async function placeMatch(formData: FormData) {
  const user = await requireUser('admin')
  const matchId = String(formData.get('matchId'))
  const courtId = String(formData.get('courtId'))
  const slug = String(formData.get('slug'))

  const tournament = await getTournamentBySlug(slug)
  if (!tournament) redirect('/admin')

  const result = await sendToCourt(matchId, courtId)
  if (!result.ok) {
    // sendToCourt refuses for six different reasons, and the most likely one
    // is the player conflict this product exists to surface. Throwing the
    // sentence away meant the page re-rendered unchanged and nothing said why.
    redirect(`/admin/t/${slug}/more?err=${encodeURIComponent(result.error)}` as never)
  }
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'match.send_to_court',
    entity: 'match',
    entityId: matchId,
    after: { courtId },
  })
  await flowTournament(tournament.id)
  revalidatePath('/admin', 'layout')
}
