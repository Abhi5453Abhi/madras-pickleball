/**
 * Seeds the venue, its courts and the starting accounts.
 * Idempotent: re-running only fills in what's missing.
 *   npm run db:seed
 */
import { eq } from 'drizzle-orm'
import { db } from '../src/db'
import { venues, courts, users } from '../src/db/schema'
import { newId } from '../src/lib/ids'
import { hashPassword, hashPin } from '../src/lib/password'

const VENUE_SLUG = 'madras-pickleball'
const COURT_COLOURS = ['blue', 'orange', 'green', 'purple', 'red', 'teal']

export async function seed() {
  let venue = (await db.select().from(venues).where(eq(venues.slug, VENUE_SLUG)).limit(1))[0]
  if (!venue) {
    ;[venue] = await db
      .insert(venues)
      .values({ id: newId('ven'), name: 'Madras Pickleball', slug: VENUE_SLUG })
      .returning()
    console.log('venue      created  Madras Pickleball')
  }

  const existingCourts = await db.select().from(courts).where(eq(courts.venueId, venue.id))
  if (existingCourts.length === 0) {
    await db.insert(courts).values(
      Array.from({ length: 4 }, (_, i) => ({
        id: newId('crt'),
        venueId: venue!.id,
        name: `Court ${i + 1}`,
        sortOrder: i,
        colorKey: COURT_COLOURS[i % COURT_COLOURS.length],
      })),
    )
    console.log('courts     created  Court 1-4')
  }

  const accounts = [
    { username: 'saurabh', name: 'Saurabh', role: 'super_admin' as const, pw: 'change-me-now' },
    { username: 'admin2', name: 'Second Organiser', role: 'admin' as const, pw: 'change-me-too' },
    { username: 'umpire1', name: 'Umpire One', role: 'umpire' as const, pw: 'change-me-also', pin: '4821' },
  ]

  for (const a of accounts) {
    const found = (await db.select().from(users).where(eq(users.username, a.username)).limit(1))[0]
    if (found) continue
    await db.insert(users).values({
      id: newId('usr'),
      name: a.name,
      username: a.username,
      role: a.role,
      passwordHash: await hashPassword(a.pw),
      pinHash: a.pin ? await hashPin(a.pin) : null,
      // Every seeded account must change its password on first login (SPEC A9).
      mustChangePassword: true,
    })
    console.log(
      `account    created  ${a.username.padEnd(9)} ${a.role.padEnd(12)} password: ${a.pw}${a.pin ? `  pin: ${a.pin}` : ''}`,
    )
  }

}
