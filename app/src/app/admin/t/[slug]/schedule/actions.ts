'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/db'
import { matches } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
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
  const res = await assignCourts(tournament.id, courtIds)
  if (!res.ok) redirect(`${back}?err=${encodeURIComponent(res.error)}` as never)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.courts',
    entity: 'tournament',
    entityId: tournament.id,
    after: { courts: courtIds },
  })
  revalidatePath(`/admin/t/${slug}`, 'layout')
  revalidatePath('/admin')
  redirect(back as never)
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
