'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { and, eq, isNull, ne } from 'drizzle-orm'
import { db } from '@/db'
import { courtClosures, matches } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { recordAudit } from '@/lib/audit'
import { newId } from '@/lib/ids'
import { bumpStreamVersion } from '@/lib/stream'
import { clearCourt } from '@/server/board'
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
