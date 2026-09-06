import Link from 'next/link'
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

      <Link href="/admin" className={SECONDARY_LINK}>
        Not now
      </Link>
    </div>
  )
}
