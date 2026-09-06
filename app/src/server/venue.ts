import 'server-only'
import { and, asc, eq, gte, sql } from 'drizzle-orm'
import { db } from '@/db'
import { courts, matches, tournamentCourts, tournaments } from '@/db/schema'
import { newId } from '@/lib/ids'
import { venueDayKey } from '@/lib/time'
import { getVenue } from './tournaments'

/**
 * The venue's courts — the one piece of furniture the organiser owns. Four
 * were seeded; a venue with three, or with a fifth built over the summer,
 * changes them here and nowhere else.
 */

/** The swatch keys `CourtSwatch` knows, in the order new courts take them. */
const COLOUR_KEYS = ['blue', 'orange', 'teal', 'violet', 'clay', 'indigo']

export async function venueCourts() {
  const venue = await getVenue()
  const todayKey = venueDayKey(new Date())
  const [rows, held] = await Promise.all([
    db
      .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey, active: courts.active })
      .from(courts)
      .where(and(eq(courts.venueId, venue.id), eq(courts.active, true)))
      .orderBy(asc(courts.sortOrder)),
    // Who holds each court from today on, so removing one can say who loses it.
    db
      .select({ courtId: tournamentCourts.courtId, name: tournaments.name, dayKey: tournamentCourts.dayKey })
      .from(tournamentCourts)
      .innerJoin(tournaments, eq(tournaments.id, tournamentCourts.tournamentId))
      .where(
        and(
          gte(tournamentCourts.dayKey, todayKey),
          sql`${tournaments.deletedAt} is null`,
          sql`${tournaments.status} not in ('completed', 'archived')`,
        ),
      ),
  ])
  const holders = new Map<string, string[]>()
  for (const h of held) holders.set(h.courtId, [...(holders.get(h.courtId) ?? []), h.name])
  return rows.map((c) => ({ ...c, heldBy: holders.get(c.id) ?? [] }))
}

function cleanName(raw: unknown) {
  return String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

export async function addCourt(rawName: unknown) {
  const name = cleanName(rawName)
  if (!name) return { ok: false as const, error: 'Give the court a name — "Court 5", or whatever it is called.' }
  const venue = await getVenue()
  const existing = await db
    .select({ id: courts.id, name: courts.name, sortOrder: courts.sortOrder, active: courts.active })
    .from(courts)
    .where(eq(courts.venueId, venue.id))
    .orderBy(asc(courts.sortOrder))
  const same = existing.find((c) => c.name.toLowerCase() === name.toLowerCase())
  if (same?.active) return { ok: false as const, error: `There is already a ${same.name}.` }
  if (same) {
    // A court that was removed and is now wanted back keeps its history.
    await db.update(courts).set({ active: true, name }).where(eq(courts.id, same.id))
    return { ok: true as const }
  }
  const activeCount = existing.filter((c) => c.active).length
  await db.insert(courts).values({
    id: newId('crt'),
    venueId: venue.id,
    name,
    sortOrder: (existing.at(-1)?.sortOrder ?? -1) + 1,
    colorKey: COLOUR_KEYS[activeCount % COLOUR_KEYS.length],
  })
  return { ok: true as const }
}

export async function renameCourt(courtId: string, rawName: unknown) {
  const name = cleanName(rawName)
  if (!name) return { ok: false as const, error: 'A court needs a name.' }
  const venue = await getVenue()
  const [clash] = await db
    .select({ id: courts.id })
    .from(courts)
    .where(and(eq(courts.venueId, venue.id), sql`lower(${courts.name}) = lower(${name})`, sql`${courts.id} <> ${courtId}`))
    .limit(1)
  if (clash) return { ok: false as const, error: `There is already a ${name}.` }
  await db.update(courts).set({ name }).where(and(eq(courts.id, courtId), eq(courts.venueId, venue.id)))
  return { ok: true as const }
}

/**
 * Take a court out of the venue. Not while a match is on it, and not while a
 * tournament from today on is counting on it — the organiser takes it off
 * that tournament first, so nothing loses a court by surprise.
 */
export async function removeCourt(courtId: string) {
  const venue = await getVenue()
  const [live] = await db
    .select({ id: matches.id })
    .from(matches)
    .where(and(eq(matches.courtId, courtId), eq(matches.status, 'live')))
    .limit(1)
  if (live) return { ok: false as const, error: 'There is a match on it right now.' }
  const [c] = (await venueCourts()).filter((x) => x.id === courtId)
  if (!c) return { ok: false as const, error: 'That court is not at this venue.' }
  if (c.heldBy.length) {
    return {
      ok: false as const,
      error: `${c.name} belongs to ${c.heldBy.join(' and ')}. Take it off there first, under Schedule & courts.`,
    }
  }
  const remaining = (await venueCourts()).filter((x) => x.id !== courtId).length
  if (remaining === 0) return { ok: false as const, error: 'A venue needs at least one court.' }
  await db.update(courts).set({ active: false }).where(and(eq(courts.id, courtId), eq(courts.venueId, venue.id)))
  return { ok: true as const }
}
