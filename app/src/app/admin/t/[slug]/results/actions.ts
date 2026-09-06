'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { courtClosures, matches } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { newId } from '@/lib/ids'
import { adminSetResult, confirmAllPending, getMatchForScoring } from '@/server/scoring'
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
  revalidatePath(`/admin/t/${slug}`)
}

/**
 * No-show → walkover — SPEC A7.
 *
 * Never a typed 11-0: the scoreline is generated so it can be excluded from
 * every difference column. And it goes through `adminSetResult` like any other
 * organiser change, so it clears the downstream guard, counts as a correction
 * and lands in the log with a reason. Routing it through an authoritative
 * `submitResult` meant a stray tap could overwrite a score the pair had entered
 * from the court two minutes earlier, silently, with no `before` in the audit
 * row and no check that a semi-final had already been built off it.
 */
export async function markNoShow(formData: FormData) {
  const user = await requireUser('admin')
  const matchId = String(formData.get('matchId'))
  const absentSide = String(formData.get('absent')) as 'A' | 'B'
  const slug = String(formData.get('slug'))
  if (absentSide !== 'A' && absentSide !== 'B') return

  const t = await getTournamentBySlug(slug)
  if (!t) return

  const loaded = await getMatchForScoring(matchId)
  if (!loaded || !loaded.match.teamAId || !loaded.match.teamBId) return
  // The id comes off a form. It has to belong to the tournament in the URL.
  if (loaded.match.tournamentId !== t.id) return

  const winnerTeamId = absentSide === 'A' ? loaded.match.teamBId : loaded.match.teamAId
  const absentName =
    (absentSide === 'A' ? loaded.nameA : loaded.nameB) ?? 'the absent pair'

  const res = await adminSetResult({
    matchId,
    games: [],
    resultType: 'walkover',
    winnerTeamId,
    reason: `${absentName} didn\u2019t turn up — recorded as a no-show from the results desk.`,
    userId: user.id,
    actorLabel: user.name,
  })

  revalidatePath(`/admin/t/${slug}/results`)
  revalidatePath(`/admin/t/${slug}/board`)
  revalidatePath(`/admin/t/${slug}`)
  if (!res.ok) {
    redirect(`/admin/t/${slug}/results?err=${encodeURIComponent(res.error)}` as never)
  }
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
