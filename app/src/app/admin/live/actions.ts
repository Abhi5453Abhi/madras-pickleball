'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { tournaments } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { flowTournament, sendToCourt } from '@/server/board'
import { resumeDay } from '@/server/chaos'
import { unblockCourt } from '@/server/courts'
import { assignCourts, myCourts } from '@/server/events'

/**
 * The board's own buttons. Each one is a fix on the card it belongs to: a
 * paused tournament's Start again, an empty court's Add it, a free court's Put
 * them on, and a blocked court's Give it back. Everything else the board does
 * is a link.
 */

async function running(tournamentId: string) {
  const [t] = await db
    .select({ id: tournaments.id, name: tournaments.name, status: tournaments.status })
    .from(tournaments)
    .where(and(eq(tournaments.id, tournamentId), isNull(tournaments.deletedAt)))
    .limit(1)
  return t ?? null
}

function fail(message: string): never {
  redirect(`/admin/live?err=${encodeURIComponent(message)}` as never)
}

/** "Mixed Doubles is paused — rain. Start again" */
export async function resumeFromBoard(formData: FormData) {
  const user = await requireUser('admin')
  const t = await running(String(formData.get('tournamentId') ?? ''))
  if (!t) fail('That tournament no longer exists.')

  await resumeDay(t.id)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.resumed',
    entity: 'tournament',
    entityId: t.id,
  })
  revalidatePath('/admin', 'layout')
  redirect('/admin/live')
}

/** "Men's has 5 to play and a court sitting empty. Add Court 4 to Men's Doubles" */
export async function addCourtFromBoard(formData: FormData) {
  const user = await requireUser('admin')
  const courtId = String(formData.get('courtId') ?? '')
  const t = await running(String(formData.get('tournamentId') ?? ''))
  if (!t) fail('That tournament no longer exists.')
  if (!courtId) fail('Which court?')

  const mine = await myCourts(t.id)
  const res = await assignCourts(t.id, [...mine.map((c) => c.id), courtId])
  if (!res.ok) fail(res.error)

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.courts',
    entity: 'tournament',
    entityId: t.id,
    after: { courtIds: [...mine.map((c) => c.id), courtId] },
  })
  revalidatePath('/admin', 'layout')
  redirect('/admin/live')
}

/**
 * The safety net: a court that is free with a playable match nobody put on.
 * The flow does this itself after every score; this is for a court that came
 * free by a door the flow does not watch.
 */
export async function putOnCourt(formData: FormData) {
  const user = await requireUser('admin')
  const matchId = String(formData.get('matchId') ?? '')
  const courtId = String(formData.get('courtId') ?? '')
  const t = await running(String(formData.get('tournamentId') ?? ''))
  if (!t) fail('That tournament no longer exists.')

  const res = await sendToCourt(matchId, courtId)
  if (!res.ok) fail(res.error)

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'match.send_to_court',
    entity: 'match',
    entityId: matchId,
    after: { courtId },
  })
  await flowTournament(t.id)
  revalidatePath('/admin', 'layout')
  redirect('/admin/live')
}

/**
 * "Court 2 · Out of action — Coaching batch · Give Court 2 back."
 *
 * The same act as on the day view, on the screen the host is actually holding.
 * A block that has already ended is refused there and here alike — the button
 * does not render for one, and a stale screen is exactly where that tap comes
 * from.
 */
export async function giveCourtBack(formData: FormData) {
  const user = await requireUser('admin')
  const holdId = String(formData.get('holdId') ?? '')
  const res = await unblockCourt(holdId)
  if (!res.ok) fail(res.error)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'court.unblocked',
    entity: 'court',
    entityId: holdId,
  })
  revalidatePath('/admin/live')
  revalidatePath('/admin/courts/day')
  redirect('/admin/live?note=Back%20in%20play.' as never)
}
