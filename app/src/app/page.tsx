import Link from 'next/link'
import { Chevron, Notice, StatusPill } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { publicToday } from '@/server/public'
import { publicSessions } from '@/server/daily-public'
import { Masthead } from './t/court-card'

export const dynamic = 'force-dynamic'

/**
 * The front door: a choice, not a dashboard.
 *
 * Tournaments and open play are different things run on different days for
 * different people — a spectator wanting Saturday's bracket and a regular
 * wanting Tuesday's game are never looking for the same list. Each gets its
 * own card here and its own page behind it; neither is folded into the other.
 *
 * Cookie-free, like everything public.
 */
export default async function Home() {
  await ensureReady()
  const [day, games] = await Promise.all([publicToday(), publicSessions()])
  const { today, upcoming } = day
  const anyLive = day.courts.some((c) => c.live)
  const paused = today.filter((t) => t.pauseNote)
  const next = upcoming[0] ?? null

  const tSub = anyLive
    ? `Live now · ${today.map((t) => t.name).join(', ')}`
    : today.length
      ? today.map((t) => t.name).join(', ')
      : next
        ? `Next: ${next.name}, ${venueDate(next.startDate)}`
        : 'Nothing on right now'

  const gSub = games.length
    ? `${games.length} coming up · join with a name and a phone`
    : 'Open play — nothing listed right now'

  const heroSub = anyLive
    ? 'A tournament is live right now.'
    : today.length || games.length
      ? 'Something is on today.'
      : 'Tournaments and open play, one venue.'

  return (
    <div className="min-h-dvh bg-ground pb-16">
      <Masthead title="Welcome" sub={heroSub} />

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 pt-5">
        {paused.map((t) => (
          <Notice key={t.slug} tone="waiting" title="Paused">
            {t.name} — {t.pauseNote}
          </Notice>
        ))}

        <Link
          href="/t"
          className="tap-lg flex items-center gap-3 rounded-card border border-line-key bg-paper px-4 py-3.5 shadow-card"
        >
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-2">
              <span className="text-row font-semibold text-text">Tournaments</span>
              {anyLive ? <StatusPill state="live">Live</StatusPill> : null}
            </span>
            <span className="block text-meta text-text-3">{tSub}</span>
          </span>
          <span aria-hidden className="text-text-3">
            <Chevron className="-rotate-90" />
          </span>
        </Link>

        <Link
          href="/games"
          className="tap-lg flex items-center gap-3 rounded-card border border-line-key bg-paper px-4 py-3.5 shadow-card"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-row font-semibold text-text">Daily games</span>
            <span className="block text-meta text-text-3">{gSub}</span>
          </span>
          <span aria-hidden className="text-text-3">
            <Chevron className="-rotate-90" />
          </span>
        </Link>
      </main>
    </div>
  )
}
