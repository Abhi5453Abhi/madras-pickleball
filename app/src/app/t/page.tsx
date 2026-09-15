import Link from 'next/link'
import { Card, Chevron, Notice } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { publicToday } from '@/server/public'
import { CourtCard, Masthead } from './court-card'
import { LiveRefresh } from './[slug]/live-refresh'

export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Tournaments · Madras Pickleball',
  description: 'Every court at Madras Pickleball, who holds it today, and a link to each tournament.',
}

/**
 * Every court regardless of which tournament it belongs to, then a link to
 * each tournament's own page — today's, and what's coming up next.
 *
 * Cookie-free, like everything public.
 */
export default async function Tournaments() {
  await ensureReady()
  const day = await publicToday()
  const { today, upcoming } = day
  const anyLive = day.courts.some((c) => c.live)
  const paused = today.filter((t) => t.pauseNote)
  const next = upcoming[0] ?? null

  const sub = today.length
    ? [venueDate(new Date()), ...today.map((t) => t.name)].join(' · ')
    : next
      ? `Nothing on today · next is ${next.name}, ${venueDate(next.startDate)}`
      : 'Nothing on today'

  return (
    <div className="min-h-dvh bg-ground pb-16">
      <LiveRefresh
        endpoint="/api/public/today/version"
        version={day.version}
        mode={anyLive ? 'live' : 'idle'}
      />
      <Masthead title="Tournaments" sub={sub} />

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-5">
        {paused.map((t) => (
          <Notice key={t.slug} tone="waiting" title="Paused">
            {t.name} — {t.pauseNote}
          </Notice>
        ))}

        {today.length ? (
          <div className="flex flex-col gap-2">
            {day.courts.map((c) => (
              <CourtCard
                key={c.id}
                name={c.name}
                colorKey={c.colorKey}
                label={c.tournament?.name ?? ''}
                live={c.live}
              />
            ))}
          </div>
        ) : null}

        {today.length || upcoming.length ? (
          <Card>
            <ul className="divide-y divide-line">
              {today.map((t) => (
                <li key={t.slug}>
                  <Link href={`/t/${t.slug}`} className="tap-lg flex items-center gap-3 px-4">
                    <span className="min-w-0 flex-1 text-row text-text">
                      {t.name} —{' '}
                      {t.status === 'completed'
                        ? 'final table & results'
                        : t.status === 'live'
                          ? 'table & results'
                          : t.registrationOpen
                            ? 'sign-ups open'
                            : 'not started yet'}
                    </span>
                    <span aria-hidden className="text-text-3">
                      <Chevron className="-rotate-90" />
                    </span>
                  </Link>
                </li>
              ))}
              {upcoming.map((t) => (
                <li key={t.slug}>
                  <Link href={`/t/${t.slug}`} className="tap-lg flex items-center gap-3 px-4">
                    <span className="min-w-0 flex-1">
                      <span className="block text-row text-text">{t.name}</span>
                      <span className="num block text-meta text-text-3">
                        {venueDate(t.startDate)}
                        {t.registrationOpen ? ' — sign-ups open' : ''}
                      </span>
                    </span>
                    <span aria-hidden className="text-text-3">
                      <Chevron className="-rotate-90" />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : (
          <p className="text-body text-text-2">
            Nothing on yet. When a tournament is on, every court and every score shows up here.
          </p>
        )}
      </main>
    </div>
  )
}
