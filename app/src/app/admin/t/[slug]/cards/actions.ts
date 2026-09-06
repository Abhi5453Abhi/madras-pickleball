'use server'

import { requireUser } from '@/lib/auth'
import { endOfVenueDay } from '@/lib/time'
import { recordAudit } from '@/lib/audit'
import { issueCourtTokens, revokeAllCourtTokens } from '@/server/court-tokens'
import { getTournamentBySlug } from '@/server/tournaments'
import { db } from '@/db'
import { courts } from '@/db/schema'
import { eq } from 'drizzle-orm'

export type Card = { courtName: string; colorKey: string; raw: string }
export type CardsState = { cards: Card[]; error?: string; revoked?: number }

/**
 * Issuing prints the codes ONCE. Only the SHA-256 is stored, so a lost printout
 * means printing new cards — which is also what retires the lost ones.
 */
export async function makeCards(_prev: CardsState, formData: FormData): Promise<CardsState> {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) return { cards: [], error: 'That tournament no longer exists.' }

  // The card dies at the end of the day AFTER the tournament, in Chennai.
  // setHours() here was the server's midnight, which on a UTC host is 05:29 the
  // next morning at the venue — a printed card that outlives the day it names.
  const dayAfter = new Date(new Date(tournament.endDate).getTime() + 24 * 60 * 60 * 1000)
  const expires = endOfVenueDay(dayAfter)

  const issued = await issueCourtTokens(tournament.id, expires)
  const colours = new Map(
    (await db.select().from(courts).where(eq(courts.active, true))).map((c) => [c.id, c.colorKey]),
  )

  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'court_tokens.issue',
    entity: 'tournament',
    entityId: tournament.id,
    after: { courts: issued.length },
  })

  return {
    cards: issued.map((i) => ({
      courtName: i.courtName,
      colorKey: colours.get(i.courtId) ?? 'blue',
      raw: i.raw,
    })),
  }
}

export async function revokeCards(_prev: CardsState, formData: FormData): Promise<CardsState> {
  const user = await requireUser('admin')
  const slug = String(formData.get('slug'))
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) return { cards: [], error: 'That tournament no longer exists.' }
  const n = await revokeAllCourtTokens(tournament.id)
  await recordAudit({
    userId: user.id,
    actorLabel: user.username,
    action: 'court_tokens.revoke_all',
    entity: 'tournament',
    entityId: tournament.id,
    after: { revoked: n },
  })
  return { cards: [], revoked: n }
}
