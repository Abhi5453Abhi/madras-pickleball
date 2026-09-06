'use server'

import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { tournaments } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { parsePlayerList } from '@/lib/parse-players'
import { newId } from '@/lib/ids'
import { recordAudit } from '@/lib/audit'
import {
  createCategory,
  createTeams,
  createTournament,
  generateDrawForCategory,
  importPlayers,
  listTournamentPlayers,
  pairingSeedFor,
  pairRandomly,
  setCategoryPlayers,
} from '@/server/tournaments'

export type QuickState = { error?: string }

const SHAPES = {
  mens_doubles: { name: "Men's Doubles", discipline: 'doubles', gender: 'mens', size: 2 },
  womens_doubles: { name: "Women's Doubles", discipline: 'doubles', gender: 'womens', size: 2 },
  open_doubles: { name: 'Doubles', discipline: 'doubles', gender: 'any', size: 2 },
  singles: { name: 'Singles', discipline: 'singles', gender: 'any', size: 1 },
} as const

type ShapeKey = keyof typeof SHAPES

/**
 * Quick Play — SPEC A2. Name, a pasted list, one category, Start. The app picks
 * the format, pairs randomly, creates the matches and goes live. Everything is
 * editable afterwards; this is the path that has to stay under 90 seconds.
 */
export async function quickStart(_prev: QuickState, formData: FormData): Promise<QuickState> {
  const user = await requireUser('admin')

  const name = String(formData.get('name') ?? '').trim()
  const paste = String(formData.get('players') ?? '')
  const shapeKey = String(formData.get('shape') ?? 'open_doubles') as ShapeKey
  const shape = SHAPES[shapeKey] ?? SHAPES.open_doubles

  if (!name) return { error: 'Give it a name — you can change it later.' }

  const parsed = parsePlayerList(paste).filter((r) => r.name)
  if (parsed.length < shape.size * 2) {
    return {
      error: `Paste at least ${shape.size * 2} players — there are ${parsed.length} here.`,
    }
  }

  const tournament = await createTournament({ name, startDate: new Date() })

  await importPlayers(
    tournament.id,
    parsed.map((r) => ({ name: r.name, phone: r.phone })),
  )

  const roster = await listTournamentPlayers(tournament.id)
  const categoryId = await createCategory({
    tournamentId: tournament.id,
    name: shape.name,
    discipline: shape.discipline,
    gender: shape.gender,
    finalsStage: 'final_only',
  })

  const playerIds = roster.map((p) => p.id)
  await setCategoryPlayers(categoryId, playerIds)

  // The category's own stored seed, so re-pairing later reproduces this draw
  // rather than inventing a different one.
  const seed = await pairingSeedFor(categoryId)
  const pairs = pairRandomly(playerIds, seed, shape.size)
  await createTeams(categoryId, pairs, new Map(roster.map((p) => [p.id, p.name])))

  await generateDrawForCategory(categoryId)

  await db
    .update(tournaments)
    .set({ status: 'live', publishedAt: new Date() })
    .where(eq(tournaments.id, tournament.id))

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'tournament.quick_start',
    entity: 'tournament',
    entityId: tournament.id,
    after: { name, category: shape.name, players: playerIds.length, teams: pairs.length },
  })

  redirect(`/admin/t/${tournament.slug}`)
}
