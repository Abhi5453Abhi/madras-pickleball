'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/db'
import { matches } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { minutesOfDay } from '@/lib/time'
import { assignCourts, primaryCategory } from '@/server/events'
import { settleTeams } from '@/server/teams'
import { generateDrawForCategory, getTournamentBySlug } from '@/server/tournaments'

async function load(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug') ?? '')
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) redirect('/admin')
  return { user, slug, tournament, back: `/admin/t/${slug}/schedule` }
}

export async function setCourtsAction(formData: FormData) {
  const { user, slug, tournament, back } = await load(formData)
  const courtIds = formData.getAll('courts').map(String).filter(Boolean)

  // Both blank holds the courts all day, which is what every tournament did
  // before it could hold part of one. One blank is a half-finished thought.
  const fromRaw = String(formData.get('courtsFrom') ?? '').trim()
  const untilRaw = String(formData.get('courtsUntil') ?? '').trim()
  let hours: { fromMin: number; untilMin: number } | null = null
  if (fromRaw || untilRaw) {
    const fromMin = minutesOfDay(fromRaw)
    const untilMin = minutesOfDay(untilRaw)
    if (fromMin === null || untilMin === null || untilMin <= fromMin) {
      redirect(`${back}?err=${encodeURIComponent('Those court hours don’t read as a start and a finish.')}` as never)
    }
    hours = { fromMin, untilMin }
  }

  const res = await assignCourts(tournament.id, courtIds, hours)
  if (!res.ok) redirect(`${back}?err=${encodeURIComponent(res.error)}` as never)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.courts',
    entity: 'tournament',
    entityId: tournament.id,
    after: { courts: courtIds, held: res.count, hours },
  })
  revalidatePath(`/admin/t/${slug}`, 'layout')
  revalidatePath('/admin')
  // A receipt, like every other act in this app. This screen can now save
  // something subtly different from what was ticked, and silence is the wrong
  // way to say so.
  const note = res.count === 0 ? 'No courts held for it now.' : `On ${res.count} court${res.count === 1 ? '' : 's'}.`
  redirect(`${back}?note=${encodeURIComponent(note)}` as never)
}

/**
 * Make (or remake) the order of play. `persistDraw` deletes the matches and
 * writes new ones, so it refuses the moment a result exists.
 */
export async function makeScheduleAction(formData: FormData) {
  const { user, slug, tournament, back } = await load(formData)
  const category = await primaryCategory(tournament.id)

  const [started] = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournament.id), ne(matches.resultState, 'none')))
    .limit(1)
  if (started) {
    redirect(`${back}?err=${encodeURIComponent('Results are already in — the schedule can’t be remade now.')}` as never)
  }

  try {
    await settleTeams(tournament.id)
    await generateDrawForCategory(category.id)
  } catch {
    redirect(`${back}?err=${encodeURIComponent('You need at least two pairs before there is a schedule to make.')}` as never)
  }

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'draw.generated',
    entity: 'category',
    entityId: category.id,
  })
  revalidatePath(`/admin/t/${slug}`, 'layout')
  redirect(back as never)
}
