'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { db } from '@/db'
import { categories, courtClosures, matches, teams, tournamentPlayers } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { newId } from '@/lib/ids'
import { bumpStreamVersion } from '@/lib/stream'
import { clearCourt } from '@/server/board'
import {
  pauseDay,
  reinstateTeam,
  resumeDay,
  shortenFormat,
  substitutePlayer,
  withdrawTeam,
  withdrawalEffect,
} from '@/server/chaos'
import { generateDrawForCategory, getCategory, getTournamentBySlug } from '@/server/tournaments'

/**
 * A category added at 10am has teams and no matches, and until now there was no
 * screen anywhere that could give it a draw — Quick Play was the only caller of
 * `generateDrawForCategory`. That is a dead end on the one page the organiser
 * is standing on when it happens.
 *
 * `persistDraw` DELETES the category's matches and writes new ones, so this
 * refuses the moment anything real has happened in it. SPEC A7: a draw is free
 * to revise while zero results exist; after that it is targeted surgery, which
 * is the match editor, not this button.
 */
export async function makeDraw(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const categoryId = String(formData.get('categoryId'))

  const [tournament, category] = await Promise.all([
    getTournamentBySlug(slug),
    getCategory(categoryId),
  ])
  if (!tournament || !category) return
  // The slug in the form is a wire value, not proof of anything: without this
  // an admin could redraw a category in a tournament the URL never mentioned.
  if (category.tournamentId !== tournament.id) return

  const started = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.categoryId, categoryId), ne(matches.resultState, 'none')))
    .limit(1)

  if (started.length > 0) {
    redirect(
      `/admin/t/${slug}?err=${encodeURIComponent(
        `${category.name} already has results — a new draw would delete them. Change the matches one at a time instead.`,
      )}` as never,
    )
  }

  try {
    await generateDrawForCategory(categoryId)
  } catch {
    // The only two ways this throws are a category that vanished and one with
    // fewer than two teams, and the second is the one an organiser hits.
    redirect(
      `/admin/t/${slug}?err=${encodeURIComponent(
        `${category.name} needs at least two pairs before there is a draw to make.`,
      )}` as never,
    )
  }

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'draw.generated',
    entity: 'category',
    entityId: categoryId,
    after: { category: category.name },
  })
  revalidatePath(`/admin/t/${slug}`, 'layout')
}

/**
 * Court out of action — SPEC A7. The board filters, the queue skips it, and the
 * finish estimate recomputes off one fewer court, which is the number that
 * decides whether the day gets shortened.
 *
 * A duplicate of the one in `results/actions.ts` only in shape: that one is
 * reached from nowhere in the UI. This is the one wired to a screen, and it
 * revalidates the tournament page as well as the board, because the tournament
 * page is where the closure is shown.
 */
export async function setCourtClosed(formData: FormData) {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const courtId = String(formData.get('courtId'))
  const close = String(formData.get('close')) === '1'
  const reason = String(formData.get('reason') ?? '').trim() || 'Out of action'

  const tournament = await getTournamentBySlug(slug)
  if (!tournament) return

  const [active] = await db
    .select({ id: courtClosures.id })
    .from(courtClosures)
    .where(
      and(
        eq(courtClosures.courtId, courtId),
        eq(courtClosures.tournamentId, tournament.id),
        isNull(courtClosures.until),
      ),
    )
    .limit(1)

  if (close) {
    if (!active) {
      await db
        .insert(courtClosures)
        .values({ id: newId('cc'), courtId, tournamentId: tournament.id, reason })

      // Only THIS tournament's live match comes off, and only a live one:
      // clearing court_id on every row that had ever been on this court erases
      // which court each finished match was played on.
      const [live] = await db
        .select({ id: matches.id })
        .from(matches)
        .where(
          and(
            eq(matches.courtId, courtId),
            eq(matches.tournamentId, tournament.id),
            eq(matches.status, 'live'),
          ),
        )
        .limit(1)
      if (live) await clearCourt(live.id)
    }
  } else if (active) {
    await db.update(courtClosures).set({ until: new Date() }).where(eq(courtClosures.id, active.id))
  }

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: close ? 'court.close' : 'court.reopen',
    entity: 'court',
    entityId: courtId,
    reason: close ? reason : 'back in action',
  })
  await bumpStreamVersion(tournament.id)
  revalidatePath(`/admin/t/${slug}`, 'layout')
}

// ─────────────────────────  when things go wrong (SPEC A7)  ─────────────────

/**
 * Every id below arrives on the wire from a form, and a form field is not a
 * typed object. The slug in the URL is the only thing the guard has actually
 * checked, so each id is resolved back to a tournament and compared with it —
 * without this an admin could withdraw a pair from a tournament this URL never
 * mentioned.
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
  redirect(`/admin/t/${slug}?${q}` as never)
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
  revalidatePath(`/admin/t/${slug}`, 'layout')
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
  revalidatePath(`/admin/t/${slug}`, 'layout')
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
  // format. Somebody who has never been entered has to go on the roster first —
  // that is also what puts their name on the public page and in Find my match,
  // which is the half of a substitution players actually notice.
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
    refuse(
      slug,
      'Whoever is stepping in has to be on the roster first.',
      'signups',
    )
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
  revalidatePath(`/admin/t/${slug}`, 'layout')
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
  revalidatePath(`/admin/t/${slug}`, 'layout')
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
  revalidatePath(`/admin/t/${slug}`, 'layout')
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
  revalidatePath(`/admin/t/${slug}`, 'layout')
}
