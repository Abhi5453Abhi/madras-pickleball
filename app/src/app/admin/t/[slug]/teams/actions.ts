'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { pairRestRandomly, pairWith, splitTeam } from '@/server/teams'
import { getTournamentBySlug } from '@/server/tournaments'

/**
 * The three things the organiser can do to pairs. Each one checks the
 * schedule has not been made — the server function refuses, and the refusal
 * comes back onto the Teams screen in a sentence.
 */

async function load(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug') ?? '')
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) redirect('/admin')
  const back = `/admin/t/${slug}/teams`
  return { user, slug, tournament, back }
}

function fail(back: string, error: string): never {
  redirect(`${back}?err=${encodeURIComponent(error)}` as never)
}

/** From the picker: pair the person whose page it is with the one tapped. */
export async function pairWithAction(formData: FormData) {
  const { user, slug, tournament, back } = await load(formData)
  const playerA = String(formData.get('player') ?? '')
  const playerB = String(formData.get('partner') ?? '')
  if (!/^ply_[A-Za-z0-9_-]+$/.test(playerA) || !/^ply_[A-Za-z0-9_-]+$/.test(playerB)) {
    fail(back, 'Pick two different people.')
  }

  const res = await pairWith(tournament.id, playerA, playerB)
  if (!res.ok) fail(back, res.error)

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'team.paired',
    entity: 'team',
    entityId: res.teamId,
    after: { players: [playerA, playerB] },
  })
  revalidatePath(`/admin/t/${slug}`, 'layout')
  redirect(back as never)
}

export async function splitTeamAction(formData: FormData) {
  const { user, slug, tournament, back } = await load(formData)
  const teamId = String(formData.get('team') ?? '')
  if (!/^tm_[A-Za-z0-9_-]+$/.test(teamId)) fail(back, 'That pair is already gone.')

  const res = await splitTeam(tournament.id, teamId)
  if (!res.ok) fail(back, res.error)

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'team.split',
    entity: 'team',
    entityId: teamId,
  })
  revalidatePath(`/admin/t/${slug}`, 'layout')
  redirect(back as never)
}

export async function pairRestAction(formData: FormData) {
  const { user, slug, tournament, back } = await load(formData)
  const res = await pairRestRandomly(tournament.id)
  if (!res.ok) fail(back, res.error)

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'teams.paired_randomly',
    entity: 'tournament',
    entityId: tournament.id,
    after: { made: res.made, oddOut: res.oddOut?.id ?? null },
  })
  revalidatePath(`/admin/t/${slug}`, 'layout')
  redirect(back as never)
}
