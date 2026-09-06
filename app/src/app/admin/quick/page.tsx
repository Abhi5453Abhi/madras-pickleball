import Link from 'next/link'
import { isNull } from 'drizzle-orm'
import { db } from '@/db'
import { tournaments } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { venueDate } from '@/lib/time'
import { getVenue, listCourts } from '@/server/tournaments'
import { ensureReady } from '@/server/bootstrap'
import { QuickForm } from './quick-form'
import { SECONDARY_LINK } from '../_ui'

export const metadata = { title: 'Start a tournament · Madras Pickleball' }

export default async function QuickPage() {
  // Deep-linking here without going through /admin first would otherwise hit
  // getVenue's "not seeded" throw on a fresh install.
  await ensureReady()
  await requireUser('admin')

  // The court count is what turns "29 matches" into "finishing about 17:20",
  // and that sentence is the whole reason the format picker exists (SPEC A3).
  const venue = await getVenue()
  const courts = await listCourts(venue.id)
  const [existing] = await db
    .select({ id: tournaments.id })
    .from(tournaments)
    .where(isNull(tournaments.deletedAt))
    .limit(1)
  const hasTournaments = !!existing

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Quick play</p>
        <h1 className="mt-1 text-title text-text">Start a tournament</h1>
        <p className="mt-1.5 text-body text-text-2">
          A name, one tap and a paste. It pairs everyone, makes the draw and goes live — and all of
          it stays editable afterwards.
        </p>
      </header>

      <QuickForm
        defaultName={`Social — ${venueDate(new Date())}`}
        courts={Math.max(1, courts.length)}
      />

      {/* Only when there IS something to go back to. On a fresh install
          /admin is one big "Start a tournament" button, so "Not now" led
          straight back to the same offer and read as a control that did
          nothing. */}
      {hasTournaments ? (
        <Link href="/admin" className={SECONDARY_LINK}>
          Not now — back to your tournaments
        </Link>
      ) : null}
    </div>
  )
}
