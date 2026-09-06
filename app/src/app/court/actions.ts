'use server'

import { revalidatePath } from 'next/cache'
import { newId } from '@/lib/ids'
import { currentCourtSession, scoreableMatches } from '@/server/court-tokens'
import { confirmOnSameDevice, raiseDispute, submitResult } from '@/server/scoring'
import type { GameScore } from '@/lib/rules'

export async function courtSubmit(payload: {
  matchId: string
  games: GameScore[]
  resultType: 'normal' | 'walkover' | 'retired'
  winnerTeamId: string | null
  retiredTeamId: string | null
  submittingTeamId: string | null
}) {
  const ctx = await currentCourtSession()
  if (!ctx) return { ok: false, error: 'This court link has expired. Ask the organiser for a new card.' }

  // The server checks the match is one this court may write to; it never
  // resolves "whatever is on this court now" from the request.
  const allowed = await scoreableMatches(ctx)
  if (!allowed.some((m) => m.id === payload.matchId)) {
    return { ok: false, error: 'That match has moved. Pull down to refresh and try again.' }
  }

  const res = await submitResult({
    ...payload,
    attributorKey: `token:${ctx.courtId}:dev:${ctx.deviceId}`,
    actorType: ctx.umpireUserId ? 'umpire_pin' : 'court_token',
    deviceId: ctx.deviceId,
    clientEventId: newId('ce'),
  })
  revalidatePath('/court')
  return res.ok ? { ok: true, state: res.state } : { ok: false, error: res.error }
}

export async function courtAgree(formData: FormData) {
  const ctx = await currentCourtSession()
  if (!ctx) return
  const matchId = String(formData.get('matchId'))
  const teamId = String(formData.get('teamId') || '') || null
  await confirmOnSameDevice({
    matchId,
    attributorKey: `token:${ctx.courtId}:dev:${ctx.deviceId}:confirm`,
    agreedForTeamId: teamId,
    deviceId: ctx.deviceId,
  })
  revalidatePath('/court')
}

export async function courtDispute(formData: FormData) {
  const ctx = await currentCourtSession()
  if (!ctx) return
  await raiseDispute(String(formData.get('matchId')), 'the other side disagreed at the net')
  revalidatePath('/court')
}
