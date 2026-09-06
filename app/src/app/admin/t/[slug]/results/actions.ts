'use server'

import { revalidatePath } from 'next/cache'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { courtClosures, matches } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { newId } from '@/lib/ids'
import { walkoverGames } from '@/lib/rules'
import { confirmAllPending, getMatchForScoring, submitResult } from '@/server/scoring'
import { getTournamentBySlug } from '@/server/tournaments'
import { clearCourt } from '@/server/board'
import { bumpStreamVersion } from '@/lib/stream'

export async function confirmAll(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const t = await getTournamentBySlug(slug)
  if (!t) return
  const n = await confirmAllPending(t.id)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'results.confirm_all',
    entity: 'tournament',
    entityId: t.id,
    after: { confirmed: n },
  })
  revalidatePath(`/admin/t/${slug}/results`)
}

/** No-show → walkover. Never a typed 11-0: that would corrupt the tiebreak. */
export async function markNoShow(formData: FormData) {
  const user = await requireUser('admin')
  const matchId = String(formData.get('matchId'))
  const absentSide = String(formData.get('absent')) as 'A' | 'B'
  const slug = String(formData.get('slug'))

  const loaded = await getMatchForScoring(matchId)
  if (!loaded || !loaded.match.teamAId || !loaded.match.teamBId) return

  const winnerTeamId = absentSide === 'A' ? loaded.match.teamBId : loaded.match.teamAId
  const gs = walkoverGames(loaded.rules)
  const games = absentSide === 'A' ? gs.map((g) => ({ ...g, scoreA: g.scoreB, scoreB: g.scoreA })) : gs

  await submitResult({
    matchId,
    games,
    resultType: 'walkover',
    winnerTeamId,
    submittingTeamId: null,
    attributorKey: `user:${user.id}`,
    actorType: 'user',
    userId: user.id,
    clientEventId: newId('ce'),
    authoritative: true,
  })
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'match.no_show',
    entity: 'match',
    entityId: matchId,
    reason: 'recorded from the pending results screen',
  })
  revalidatePath(`/admin/t/${slug}/results`)
  revalidatePath(`/admin/t/${slug}/board`)
}

/** Court out of action — the queue and the finish estimate recompute. */
export async function toggleCourt(formData: FormData) {
  const user = await requireUser('admin')
  const courtId = String(formData.get('courtId'))
  const slug = String(formData.get('slug'))
  const reason = String(formData.get('reason') || 'Out of action')
  const t = await getTournamentBySlug(slug)
  if (!t) return

  const open = await db
    .select()
    .from(courtClosures)
    .where(eq(courtClosures.courtId, courtId))
  const active = open.find((c) => !c.until && c.tournamentId === t.id)

  if (active) {
    await db.update(courtClosures).set({ until: new Date() }).where(eq(courtClosures.id, active.id))
  } else {
    await db
      .insert(courtClosures)
      .values({ id: newId('cc'), courtId, tournamentId: t.id, reason })
    // Only this tournament's LIVE match comes off. The original cleared
    // court_id on every row that had ever been on this court, in every
    // tournament — erasing which court each finished match was played on, and
    // silently un-completing nothing but the record.
    const [live] = await db
      .select({ id: matches.id })
      .from(matches)
      .where(
        and(
          eq(matches.courtId, courtId),
          eq(matches.tournamentId, t.id),
          eq(matches.status, 'live'),
        ),
      )
      .limit(1)
    if (live) await clearCourt(live.id)
  }

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: active ? 'court.reopen' : 'court.close',
    entity: 'court',
    entityId: courtId,
    reason,
  })
  await bumpStreamVersion(t.id)
  revalidatePath(`/admin/t/${slug}/board`)
}
