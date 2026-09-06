import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { Chevron } from '@/components/ui'
import { venueDayKey } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { courtCalendar } from '@/server/events'
import { NewForm } from './new-form'

export const metadata = { title: 'New tournament · Madras Pickleball' }

export const dynamic = 'force-dynamic'

export default async function NewTournamentPage() {
  await ensureReady()
  await requireUser('admin')
  const calendar = await courtCalendar()

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/admin"
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          Tournaments
        </Link>
        <h1 className="mt-1 text-title text-text">New tournament</h1>
      </header>
      <NewForm calendar={calendar} todayKey={venueDayKey(new Date())} />
    </div>
  )
}
