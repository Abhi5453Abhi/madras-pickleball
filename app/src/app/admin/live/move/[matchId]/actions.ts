'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { matches } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { clearCourt, flowTournament, moveMatch } from '@/server/board'

async function tournamentOf(matchId: string) {
  const [m] = await db
    .select({ tournamentId: matches.tournamentId })
    .from(matches)
    .where(eq(matches.id, matchId))
    .limit(1)
  return m?.tournamentId ?? null
}

/** Onto another of its own tournament's courts. `moveMatch` refuses any other. */
export async function moveMatchAction(formData: FormData) {
  const user = await requireUser('admin')
  const matchId = String(formData.get('matchId') ?? '')
  const courtId = String(formData.get('courtId') ?? '')
  const tournamentId = await tournamentOf(matchId)
  if (!tournamentId) redirect('/admin/live')

  const res = await moveMatch(matchId, courtId)
  if (!res.ok) {
    redirect(`/admin/live/move/${matchId}?err=${encodeURIComponent(res.error)}` as never)
  }
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'match.moved',
    entity: 'match',
    entityId: matchId,
    after: { courtId },
  })
  // The court it left is free now: the next match in order goes on it.
  await flowTournament(tournamentId)
  revalidatePath('/admin', 'layout')
  redirect('/admin/live')
}

/**
 * Off court, no score, and to the back of the order. The court it left fills
 * with the next match — not this one, which the organiser has just said to
 * play later.
 */
export async function backToQueueAction(formData: FormData) {
  const user = await requireUser('admin')
  const matchId = String(formData.get('matchId') ?? '')
  const tournamentId = await tournamentOf(matchId)
  if (!tournamentId) redirect('/admin/live')

  const res = await clearCourt(matchId, { later: true })
  if (!res.ok) {
    redirect(`/admin/live/move/${matchId}?err=${encodeURIComponent(res.error)}` as never)
  }
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'match.clear_court',
    entity: 'match',
    entityId: matchId,
  })
  await flowTournament(tournamentId, { skip: [matchId] })
  revalidatePath('/admin', 'layout')
  redirect('/admin/live')
}
