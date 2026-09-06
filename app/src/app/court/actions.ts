'use server'

import { revalidatePath } from 'next/cache'
import { newId } from '@/lib/ids'
import { currentCourtSession, scoreableMatches } from '@/server/court-tokens'
import { confirmOnSameDevice, raiseDispute, submitResult } from '@/server/scoring'
import type { GameScore } from '@/lib/rules'

export type CourtPayload = {
  matchId: string
  games: GameScore[]
  resultType: 'normal' | 'walkover' | 'retired'
  winnerTeamId: string | null
  retiredTeamId: string | null
  excludeFromDiff?: number[]
  submittingTeamId: string | null
}

const RESULT_TYPES = new Set(['normal', 'walkover', 'retired'])

/**
 * Every field is copied out by hand. A server action's argument is a wire
 * format, not a typed object: TypeScript is gone at runtime, so spreading the
 * client's payload into `submitResult` let a phone holding a court card set
 * `authoritative: true` and hand itself a final, bracket-advancing win.
 */
function sanitize(payload: CourtPayload): CourtPayload | null {
  if (typeof payload?.matchId !== 'string' || !payload.matchId) return null
  if (!RESULT_TYPES.has(payload.resultType)) return null
  if (!Array.isArray(payload.games) || payload.games.length > 9) return null

  const games: GameScore[] = []
  const seen = new Set<number>()
  for (const g of payload.games) {
    const gameNo = Number(g?.gameNo)
    const scoreA = Number(g?.scoreA)
    const scoreB = Number(g?.scoreB)
    if (!Number.isInteger(gameNo) || gameNo < 1 || gameNo > 9) return null
    // A repeated game number violates the unique index on (match, game_no)
    // halfway through rewriting the ledger, which used to leave the match with
    // no games at all and a winner nobody could explain.
    if (seen.has(gameNo)) return null
    seen.add(gameNo)
    if (!Number.isInteger(scoreA) || !Number.isInteger(scoreB)) return null
    if (scoreA < 0 || scoreB < 0 || scoreA > 99 || scoreB > 99) return null
    games.push({ gameNo, scoreA, scoreB, timeCapped: g?.timeCapped === true })
  }

  const exclude = Array.isArray(payload.excludeFromDiff)
    ? payload.excludeFromDiff.map(Number).filter((n) => seen.has(n))
    : undefined

  return {
    matchId: payload.matchId,
    games,
    resultType: payload.resultType,
    winnerTeamId: typeof payload.winnerTeamId === 'string' ? payload.winnerTeamId : null,
    retiredTeamId: typeof payload.retiredTeamId === 'string' ? payload.retiredTeamId : null,
    excludeFromDiff: exclude,
    submittingTeamId:
      typeof payload.submittingTeamId === 'string' ? payload.submittingTeamId : null,
  }
}

export async function courtSubmit(payload: CourtPayload) {
  const ctx = await currentCourtSession()
  if (!ctx) {
    return { ok: false, error: 'This court link has expired. Ask the organiser for a new card.' }
  }

  const clean = sanitize(payload)
  if (!clean) return { ok: false, error: 'That score didn’t make sense. Enter it again.' }

  // The server checks the match is one this court may write to; it never
  // resolves "whatever is on this court now" from the request.
  const allowed = await scoreableMatches(ctx)
  const match = allowed.find((m) => m.id === clean.matchId)
  if (!match) {
    return { ok: false, error: 'That match has moved. Pull down to refresh and try again.' }
  }

  // "Which side am I" decides whether this counts as independent agreement, so
  // it has to be one of the two sides actually in this match.
  if (clean.submittingTeamId && ![match.teamAId, match.teamBId].includes(clean.submittingTeamId)) {
    return { ok: false, error: 'Pick your own side.' }
  }

  const res = await submitResult({
    matchId: clean.matchId,
    games: clean.games,
    resultType: clean.resultType,
    winnerTeamId: clean.winnerTeamId,
    retiredTeamId: clean.retiredTeamId,
    excludeFromDiff: clean.excludeFromDiff,
    submittingTeamId: clean.submittingTeamId,
    // A court device is never authoritative and never speaks for a user
    // account. These are set here and nowhere else.
    authoritative: false,
    userId: null,
    attributorKey: `token:${ctx.courtId}:dev:${ctx.deviceId}`,
    actorType: ctx.umpireUserId ? 'umpire_pin' : 'court_token',
    deviceId: ctx.deviceId,
    clientEventId: newId('ce'),
  })
  revalidatePath('/court')
  return res.ok ? { ok: true, state: res.state } : { ok: false, error: res.error }
}

/**
 * Every court write is scoped the same way as a submission. Without this a
 * device holding any court card could finalise, un-finalise or dispute every
 * match in the database — the blast radius A1 promises is one court's own.
 */
async function scopedMatch(matchId: string) {
  const ctx = await currentCourtSession()
  if (!ctx) return null
  const allowed = await scoreableMatches(ctx)
  const match = allowed.find((m) => m.id === matchId)
  return match ? { ctx, match } : null
}

export async function courtAgree(formData: FormData) {
  const matchId = String(formData.get('matchId'))
  const scoped = await scopedMatch(matchId)
  if (!scoped) return
  const { ctx, match } = scoped

  const raw = String(formData.get('teamId') || '')
  const teamId = raw && [match.teamAId, match.teamBId].includes(raw) ? raw : null

  await confirmOnSameDevice({
    matchId,
    attributorKey: `token:${ctx.courtId}:dev:${ctx.deviceId}:confirm`,
    agreedForTeamId: teamId,
    deviceId: ctx.deviceId,
  })
  revalidatePath('/court')
}

export async function courtDispute(formData: FormData) {
  const matchId = String(formData.get('matchId'))
  const scoped = await scopedMatch(matchId)
  if (!scoped) return
  await raiseDispute(matchId, 'the other side disagreed at the net')
  revalidatePath('/court')
}
