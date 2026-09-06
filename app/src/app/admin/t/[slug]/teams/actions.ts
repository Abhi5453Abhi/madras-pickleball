'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq, ne } from 'drizzle-orm'
import { db } from '@/db'
import { matches } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { primaryCategory } from '@/server/events'
import {
  createTeams,
  getTournamentBySlug,
  listTournamentPlayers,
  pairingSeedFor,
  pairRandomly,
  setCategoryPlayers,
} from '@/server/tournaments'

/**
 * Pair everyone at random (doubles) or put everyone in the draw (singles).
 * Rebuilds the whole set of teams, so it refuses once any match has a result.
 */
export async function pairEveryoneAction(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug') ?? '')
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) redirect('/admin')
  const category = await primaryCategory(tournament.id)
  const back = `/admin/t/${slug}/teams`

  const [started] = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.tournamentId, tournament.id), ne(matches.resultState, 'none')))
    .limit(1)
  if (started) {
    redirect(`${back}?err=${encodeURIComponent('Results are already in. Pairs can’t be remade now.')}` as never)
  }

  const roster = (await listTournamentPlayers(tournament.id)).filter((p) => !p.withdrawn)
  const size = category.discipline === 'doubles' ? 2 : 1
  if (roster.length < size * 2) {
    redirect(`${back}?err=${encodeURIComponent(`You need at least ${size * 2} players first.`)}` as never)
  }

  const ids = roster.map((p) => p.id)
  await setCategoryPlayers(category.id, ids)
  const seed = await pairingSeedFor(category.id)
  const pairs = pairRandomly(ids, seed, size)
  await createTeams(category.id, pairs, new Map(roster.map((p) => [p.id, p.name])))

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'teams.paired_randomly',
    entity: 'category',
    entityId: category.id,
    after: { teams: pairs.length, players: ids.length },
  })
  revalidatePath(`/admin/t/${slug}`, 'layout')
  redirect(back as never)
}
