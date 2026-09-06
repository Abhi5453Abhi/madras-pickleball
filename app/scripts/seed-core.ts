/**
 * Seeds the venue, its courts and the starting accounts.
 * Idempotent: re-running only fills in what's missing.
 *   npm run db:seed
 */
import { eq } from 'drizzle-orm'
import { db } from '../src/db'
import { venues, courts, users } from '../src/db/schema'
import { newId } from '../src/lib/ids'
import { hashPin } from '../src/lib/password'
import { ensureOrganiserPins, TEMP_PINS } from '../src/server/organisers'

const VENUE_SLUG = 'madras-pickleball'
// The keys the swatches know — see COURT_COLORS in components/ui.tsx.
const COURT_COLOURS = ['blue', 'orange', 'teal', 'violet', 'clay', 'indigo']

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

  const existingUsers = await db.select().from(users).limit(1)
  if (existingUsers.length === 0) {
    const pin = process.env.MPB_SEED_PIN ?? TEMP_PINS[0]
    const digest = await hashPin(pin)
    await db.insert(users).values({
      id: newId('usr'),
      name: 'Organiser',
      username: 'organiser',
      role: 'super_admin',
      passwordHash: digest,
      pinHash: digest,
      // A seeded PIN must be replaced on first sign-in (SPEC A9).
      mustChangePassword: !process.env.MPB_SEED_PIN,
    })
    console.log(`account    created  organiser    PIN: ${pin}  (change it on first sign-in)`)
  }

  // Accounts from before PIN sign-in get a temporary PIN; umpire accounts
  // are switched off.
  for (const issued of await ensureOrganiserPins()) {
    console.log(`account    pin set  ${issued.username.padEnd(12)} PIN: ${issued.pin}  (temporary — change it on first sign-in)`)
  }
}
