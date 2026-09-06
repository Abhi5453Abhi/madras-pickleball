'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { newId } from '@/lib/ids'
import { adminSetResult, getMatchForScoring, submitResult } from '@/server/scoring'
import { flowVenue } from '@/server/board'
import { voidMatch } from '@/server/chaos'
import { recordAudit } from '@/lib/audit'
import type { GameScore } from '@/lib/rules'

/**
 * `back` arrives from a hidden form field, and `redirect()` will happily send
 * somebody to another origin. Every legitimate destination here is one of two
 * paths inside this app, so anything else falls back to the admin home.
 */
function safeBack(value: unknown): string {
  const s = String(value ?? '')
  return s.startsWith('/admin/') || s === '/admin' ? s : '/admin'
}

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
 * Entering a result nobody has entered yet is scoring. Changing one that is
 * already in is a CORRECTION: it has to clear the downstream guard, and it
 * goes in the log with a reason and a name. Routing both through
 * `submitResult` meant the guard, the reason and the audit row never ran on
 * the one path where they matter.
 */
export async function saveResult(payload: SavePayload) {
  const user = await requireUser('admin')

  const loaded = await getMatchForScoring(payload.matchId)
  if (!loaded) return { ok: false as const, error: 'That match no longer exists.' }

  const alreadyHasResult = loaded.match.resultState !== 'none'

  if (alreadyHasResult) {
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
    if (res.ok) await flowVenue({ first: loaded.match.tournamentId })
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
    // The organiser is the only person who enters scores; no confirmation
    // dance.
    authoritative: true,
  })
  // The court this was on is free the moment the score is in. The next match
  // in order goes on before the organiser is back on the board.
  if (res.ok) await flowVenue({ first: loaded.match.tournamentId })
  revalidatePath('/admin', 'layout')
  return res.ok ? { ok: true as const } : { ok: false as const, error: res.error }
}

/**
 * Cancel a match outright — SPEC A7. It counts for nothing and for nobody: not
 * in the table, not in anyone's difference column, not as a walkover.
 *
 * It lives here rather than on the tournament page because this is the screen
 * where you are already looking at the one match, and because the refusal names
 * the later match that was built off this result — a sentence that is only
 * useful next to the thing it is about.
 */
export async function voidThisMatch(formData: FormData) {
  const user = await requireUser('admin')
  const matchId = String(formData.get('matchId'))
  const reason = String(formData.get('reason') ?? '').trim()

  if (reason.length < 3) {
    redirect(
      `/admin/m/${matchId}?err=${encodeURIComponent('Say why it is being cancelled — it goes in the log next to your name.')}` as never,
    )
  }

  const loaded = await getMatchForScoring(matchId)
  if (!loaded) return

  const res = await voidMatch(matchId)
  if (!res.ok) {
    redirect(`/admin/m/${matchId}?err=${encodeURIComponent(res.error)}` as never)
  }

  await recordAudit({
    userId: user.id,
    actorLabel: user.name,
    action: 'match.voided',
    entity: 'match',
    entityId: matchId,
    reason,
    before: { nameA: loaded.nameA, nameB: loaded.nameB, resultState: loaded.match.resultState },
  })
  revalidatePath('/admin', 'layout')
  redirect(safeBack(formData.get('back')) as never)
}
