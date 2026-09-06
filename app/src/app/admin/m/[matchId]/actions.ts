'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth'
import { newId } from '@/lib/ids'
import { submitResult } from '@/server/scoring'
import type { GameScore } from '@/lib/rules'

export async function saveResult(payload: {
  matchId: string
  games: GameScore[]
  resultType: 'normal' | 'walkover' | 'retired'
  winnerTeamId: string | null
  retiredTeamId: string | null
}) {
  const user = await requireUser('umpire')
  const res = await submitResult({
    ...payload,
    submittingTeamId: null,
    attributorKey: `user:${user.id}`,
    actorType: 'user',
    userId: user.id,
    clientEventId: newId('ce'),
    // An admin standing on the court is authoritative; no confirmation dance.
    authoritative: true,
  })
  revalidatePath('/admin', 'layout')
  return res.ok ? { ok: true } : { ok: false, error: res.error }
}
