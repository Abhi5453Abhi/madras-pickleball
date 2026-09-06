'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq } from 'drizzle-orm'
import { db } from '@/db'
import { categories, teams, tournamentPlayers } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import {
  pauseDay,
  reinstateTeam,
  resumeDay,
  shortenFormat,
  substitutePlayer,
  withdrawTeam,
  withdrawalEffect,
} from '@/server/chaos'
import { deleteEvent } from '@/server/events'
import { getCategory, getTournamentBySlug } from '@/server/tournaments'

/**
 * The actions behind More. Every id below arrives on the wire from a form, and
 * a form field is not a typed object. The slug in the URL is the only thing
 * the guard has actually checked, so each id is resolved back to a tournament
 * and compared with it — without this an admin could withdraw a pair from a
 * tournament this URL never mentioned.
 */
async function ownTeam(slug: string, teamId: string) {
  const [tournament, row] = await Promise.all([
    getTournamentBySlug(slug),
    db
      .select({
        id: teams.id,
        name: teams.name,
        categoryId: teams.categoryId,
        categoryName: categories.name,
        tournamentId: categories.tournamentId,
      })
      .from(teams)
      .innerJoin(categories, eq(categories.id, teams.categoryId))
      .where(eq(teams.id, teamId))
      .limit(1)
      .then((r) => r[0]),
  ])
  if (!tournament || !row || row.tournamentId !== tournament.id) return null
  return row
}

/**
 * A refusal with no next step is the stuck organiser this exists to prevent.
 * `fix` names where the thing that is blocking it can be dealt with, so the
 * message arrives with a button rather than as a dead end.
 */
function refuse(slug: string, message: string, fix?: 'board' | 'signups'): never {
  const q = new URLSearchParams({ err: message })
  if (fix) q.set('fix', fix)
  redirect(`/admin/t/${slug}/more?${q}` as never)
}

/** Back to the list, with one sentence saying what just happened. */
function done(slug: string, message: string): never {
  revalidatePath(`/admin/t/${slug}`, 'layout')
  redirect(`/admin/t/${slug}/more?${new URLSearchParams({ done: message })}` as never)
}

export async function withdrawTeamAction(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const teamId = String(formData.get('teamId'))

  const team = await ownTeam(slug, teamId)
  if (!team) return

  // Read the effect BEFORE the write, so the audit row says what actually
  // happened rather than that something happened.
  const effect = await withdrawalEffect(teamId)
  const res = await withdrawTeam(teamId)
  // The one refusal an organiser will actually meet is a match of theirs that
  // went on court between the page rendering and the tap.
  if (!res.ok) refuse(slug, res.error, effect?.blocked.length ? 'board' : undefined)

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'team.withdrawn',
    entity: 'team',
    entityId: teamId,
    reason: `${team.name} pulled out of ${team.categoryName}`,
    after: { played: effect?.played ?? 0, walkovers: res.walkovers },
  })
  // Their walkovers can make a later match ready: this is where
  // `flowTournament(team.tournamentId)` belongs once it exists.
  done(
    slug,
    `${team.name} are out. ${
      res.walkovers
        ? `${res.walkovers} ${res.walkovers === 1 ? 'match becomes a walkover' : 'matches become walkovers'} to the other side.`
        : 'Nothing they had left changes.'
    }`,
  )
}

export async function reinstateTeamAction(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const teamId = String(formData.get('teamId'))

  const team = await ownTeam(slug, teamId)
  if (!team) return

  const res = await reinstateTeam(teamId)
  if (!res.ok) refuse(slug, res.error)

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'team.reinstated',
    entity: 'team',
    entityId: teamId,
    reason: `${team.name} are playing after all`,
    after: { walkoversUndone: res.restored },
  })
  // Undone walkovers go back in the queue: `flowTournament` belongs here too.
  done(
    slug,
    `${team.name} are back in. ${
      res.restored ? `${res.restored} ${res.restored === 1 ? 'walkover is' : 'walkovers are'} undone.` : ''
    }`.trim(),
  )
}

/**
 * The outgoing player carries their team with them — one `<select>` rather than
 * two that can disagree, because "Ravi, from a pair Ravi is not in" is a state
 * a no-JavaScript form can otherwise reach.
 */
export async function substituteAction(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const [teamId = '', outPlayerId = ''] = String(formData.get('out') ?? '').split(':')
  const inPlayerId = String(formData.get('in') ?? '')

  if (!teamId || !outPlayerId || !inPlayerId) {
    refuse(slug, 'Pick who is coming out and who is going in.')
  }

  const team = await ownTeam(slug, teamId)
  if (!team) return

  // The select only offers this tournament's roster, but a select is a wire
  // format. Somebody who has never been entered has to go on the roster first.
  const [entered] = await db
    .select({ playerId: tournamentPlayers.playerId })
    .from(tournamentPlayers)
    .where(
      and(
        eq(tournamentPlayers.tournamentId, team.tournamentId),
        eq(tournamentPlayers.playerId, inPlayerId),
      ),
    )
    .limit(1)
  if (!entered) {
    refuse(slug, 'Whoever is stepping in has to be on the roster first.', 'signups')
  }

  const res = await substitutePlayer({ teamId, outPlayerId, inPlayerId })
  if (!res.ok) refuse(slug, res.error)

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'team.substitution',
    entity: 'team',
    entityId: teamId,
    reason: `${res.incoming} came in for somebody in ${team.name}`,
    before: { name: team.name },
    after: { name: res.name, category: team.categoryName },
  })
  done(slug, `${team.name} are now ${res.name}. Their results and their place in the table stand.`)
}

export async function pauseDayAction(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const note = String(formData.get('note') ?? '').trim()

  const tournament = await getTournamentBySlug(slug)
  if (!tournament) return

  await pauseDay(tournament.id, note)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.paused',
    entity: 'tournament',
    entityId: tournament.id,
    reason: note || 'Paused',
  })
  done(slug, 'The day is stopped. The public page says so.')
}

export async function resumeDayAction(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))

  const tournament = await getTournamentBySlug(slug)
  if (!tournament) return

  await resumeDay(tournament.id)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.resumed',
    entity: 'tournament',
    entityId: tournament.id,
  })
  // Courts that stood empty through the stop take the next matches now:
  // `flowTournament(tournament.id)` belongs here once it exists.
  done(slug, 'The day is going again.')
}

/**
 * Shorten what is left — the most-used emergency tool there is. The numbers on
 * the button are computed on the page from `estimateDay`; this only writes.
 */
export async function shortenFormatAction(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const categoryId = String(formData.get('categoryId'))
  const bestOf = Number(formData.get('bestOf'))
  const pointsToWin = Number(formData.get('pointsToWin'))

  const [tournament, category] = await Promise.all([
    getTournamentBySlug(slug),
    getCategory(categoryId),
  ])
  if (!tournament || !category || category.tournamentId !== tournament.id) return

  const before = { bestOf: category.bestOf, pointsToWin: category.pointsToWin }
  const res = await shortenFormat(categoryId, { bestOf, pointsToWin })
  if (!res.ok) refuse(slug, res.error, 'board')

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'category.format_shortened',
    entity: 'category',
    entityId: categoryId,
    reason: `${category.name} shortened to finish before dark`,
    before,
    after: { bestOf, pointsToWin },
  })
  done(
    slug,
    `What is left is now ${bestOf === 1 ? `one game to ${pointsToWin}` : `best of ${bestOf} to ${pointsToWin}`}.`,
  )
}

/** Gone from every list, courts freed. The row stays for the record. */
export async function deleteEventAction(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))

  const tournament = await getTournamentBySlug(slug)
  if (!tournament) return

  const res = await deleteEvent(tournament.id)
  if (!res.ok) refuse(slug, res.error, 'board')

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.deleted',
    entity: 'tournament',
    entityId: tournament.id,
    reason: `${tournament.name} deleted`,
  })
  revalidatePath('/admin', 'layout')
  redirect('/admin')
}
