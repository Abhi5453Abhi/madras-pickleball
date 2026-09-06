'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { atLeast, requireUser } from '@/lib/auth'
import { newId } from '@/lib/ids'
import { adminSetResult, getMatchForScoring, submitResult } from '@/server/scoring'
import { umpireMayScore } from '@/server/umpire'
import type { GameScore } from '@/lib/rules'

export type SavePayload = {
  matchId: string
  games: GameScore[]
  resultType: 'normal' | 'walkover' | 'retired'
  winnerTeamId: string | null
  retiredTeamId: string | null
  excludeFromDiff?: number[]
  reason?: string
}

/**
 * Two different acts wear the same screen — SPEC A7.
 *
 * Entering a result nobody has entered yet is scoring, and an umpire may do it.
 * Changing one that is already in is a CORRECTION: organiser only, it has to
 * clear the downstream guard, and it goes in the log with a reason and a name.
 * Routing both through `submitResult` meant the guard, the reason and the audit
 * row never ran on the one path where they matter.
 */
export async function saveResult(payload: SavePayload) {
  const user = await requireUser('umpire')

  const loaded = await getMatchForScoring(payload.matchId)
  if (!loaded) return { ok: false as const, error: 'That match no longer exists.' }

  const alreadyHasResult = loaded.match.resultState !== 'none'

  // An umpire scores what is on a court, in a tournament that has started.
  // `umpireQueue` filters the LIST; this is the boundary, because the action
  // takes a match id off the wire.
  if (!atLeast(user, 'admin') && !(await umpireMayScore(payload.matchId))) {
    return {
      ok: false as const,
      error: 'That match isn’t one you can score. Ask the organiser.',
    }
  }

  if (alreadyHasResult) {
    if (!atLeast(user, 'admin')) {
      return {
        ok: false as const,
        error: 'This result is already in. Only an organiser can change it.',
      }
    }
    const reason = (payload.reason ?? '').trim()
    if (reason.length < 3) {
      return {
        ok: false as const,
        error: 'Say what changed — it goes in the log next to your name.',
      }
    }
    const res = await adminSetResult({
      matchId: payload.matchId,
      games: payload.games,
      resultType: payload.resultType,
      winnerTeamId: payload.winnerTeamId,
      retiredTeamId: payload.retiredTeamId,
      excludeFromDiff: payload.excludeFromDiff,
      reason,
      userId: user.id,
      actorLabel: user.name,
    })
    revalidatePath('/admin', 'layout')
    return res.ok ? { ok: true as const } : { ok: false as const, error: res.error }
  }

  const res = await submitResult({
    matchId: payload.matchId,
    games: payload.games,
    resultType: payload.resultType,
    winnerTeamId: payload.winnerTeamId,
    retiredTeamId: payload.retiredTeamId,
    excludeFromDiff: payload.excludeFromDiff,
    submittingTeamId: null,
    attributorKey: `user:${user.id}`,
    actorType: 'user',
    userId: user.id,
    clientEventId: newId('ce'),
    // An organiser or umpire standing on the court is authoritative; no
    // confirmation dance.
    authoritative: true,
  })
  revalidatePath('/admin', 'layout')
  revalidatePath('/umpire')
  return res.ok ? { ok: true as const } : { ok: false as const, error: res.error }
}

/**
 * Settling a disagreement — SPEC A5/A7.
 *
 * Two people entered two different scores. The organiser picks one, or enters
 * a third. Picking one is the common case and it must be one tap, with the
 * choice written to the log: "used the score from the side that lost" is
 * exactly the sentence someone will ask about later.
 */
export async function useSubmission(formData: FormData) {
  const user = await requireUser('admin')
  const matchId = String(formData.get('matchId'))
  const submissionId = String(formData.get('submissionId'))
  const back = String(formData.get('back') || '/admin')

  const loaded = await getMatchForScoring(matchId)
  if (!loaded) return
  const sub = loaded.submissions.find((s) => s.id === submissionId)
  if (!sub) return

  await adminSetResult({
    matchId,
    games: sub.games as GameScore[],
    resultType: sub.resultType as 'normal' | 'walkover' | 'retired',
    winnerTeamId: sub.winnerTeamId,
    retiredTeamId: sub.retiredTeamId,
    // The stored games ARE the ledger, exclusions and all. Re-deriving them
    // from an already-expanded list finds nothing left to expand and marks
    // none of it excluded — so settling a disputed retirement used to hand the
    // winner every point of the games nobody played.
    expanded: true,
    excludeFromDiff: sub.excludeFromDiff,
    reason: `Settled the disagreement — used the score from ${
      sub.submittingTeamId === loaded.match.teamAId
        ? (loaded.nameA ?? 'side A')
        : sub.submittingTeamId === loaded.match.teamBId
          ? (loaded.nameB ?? 'side B')
          : 'the court device'
    }.`,
    userId: user.id,
    actorLabel: user.name,
  })

  revalidatePath('/admin', 'layout')
  redirect(back as never)
}
