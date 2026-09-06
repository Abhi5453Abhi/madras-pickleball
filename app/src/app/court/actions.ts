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

/**
 * `retry` means send the same thing again — a dropped connection, a lock, a
 * score the engine wants a second look at. `reload` means the world moved and
 * the screen is looking at the wrong match. The difference decides which button
 * the pair standing on the court is offered, so it is computed rather than
 * guessed from the wording of an error.
 */
export type CourtSubmitResult =
  | { ok: true; state: 'reported' | 'final' | 'disputed' }
  | { ok: false; error: string; recover: 'retry' | 'reload' }

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

export async function courtSubmit(payload: CourtPayload): Promise<CourtSubmitResult> {
  const ctx = await currentCourtSession()
  if (!ctx) {
    return {
      ok: false,
      error: 'This court card has stopped working — the organiser may have printed new ones today.',
      recover: 'reload',
    }
  }

  const clean = sanitize(payload)
  if (!clean) {
    return { ok: false, error: 'That score didn’t make sense. Enter it again.', recover: 'retry' }
  }

  // The server checks the match is one this court may write to; it never
  // resolves "whatever is on this court now" from the request.
  const allowed = await scoreableMatches(ctx)
  const match = allowed.find((m) => m.id === clean.matchId)
  if (!match) {
    return {
      ok: false,
      error: `That match isn’t on ${ctx.courtName} any more. Read the score out to the organiser, or scan the card on the court it moved to.`,
      recover: 'reload',
    }
  }

  // "Which side am I" decides whether this counts as independent agreement, so
  // it has to be one of the two sides actually in this match.
  if (clean.submittingTeamId && ![match.teamAId, match.teamBId].includes(clean.submittingTeamId)) {
    return { ok: false, error: 'Pick one of the two sides in this match.', recover: 'retry' }
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

  if (res.ok) {
    revalidatePath('/court')
    return { ok: true, state: res.state }
  }

  // Whether the next step is "try again" or "look at this court again" is a
  // question about the world, not about the wording of the error — so ask the
  // world. Matching on the message would go stale the first time somebody
  // rewrites a string.
  const stillWritable = await scoreableMatches(ctx)
  const moved = !stillWritable.some((m) => m.id === clean.matchId)
  return { ok: false, error: res.error, recover: moved ? 'reload' : 'retry' }
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

/**
 * The confirmation buttons are a plain `<form action>` so they still work
 * before — or without — JavaScript, which on a phone at the far end of a court
 * on venue wifi is a real state and not a hypothetical one. That means these
 * take `(previousState, formData)` and hand a message back, rather than
 * swallowing the failure the way a void action did.
 */
export type ConfirmState = { error: string | null }

const GONE: ConfirmState = {
  error:
    'That match isn’t on this court any more, so it can’t be changed from here. Tell the organiser if the score is wrong.',
}

export async function courtAgree(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const matchId = String(formData.get('matchId') || '')
  const scoped = await scopedMatch(matchId)
  if (!scoped) return GONE
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
  // A failure here is always "there is nothing left to agree to" — two people
  // tapping at once, or the ten minutes running out mid-tap. Saying so would
  // contradict the page that is about to render, which will show the result as
  // in. The re-rendered state is the answer.
  return { error: null }
}

export async function courtDispute(_prev: ConfirmState, formData: FormData): Promise<ConfirmState> {
  const matchId = String(formData.get('matchId') || '')
  const scoped = await scopedMatch(matchId)
  if (!scoped) return GONE

  const res = await raiseDispute(matchId, 'the other side disagreed at the net')
  revalidatePath('/court')
  return res.ok ? { error: null } : { error: res.error }
}
