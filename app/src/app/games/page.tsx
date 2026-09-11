import Link from 'next/link'
import { EmptyState, Panel, StatusPill, Tag } from '@/components/ui'
import { rupees } from '@/lib/display'
import { venueDate, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { publicSessions, publicSessionsVersion, type PublicSession } from '@/server/daily-public'
import { Eyebrow, Masthead } from '../t/court-card'
import { GamesRefresh } from './refresh'

/**
 * The games list. One list, no login, no nav bar.
 *
 * Date, time, price, how many spots are left and who is already in — which is
 * the whole of what somebody deciding whether to come out on a Tuesday needs.
 * No cookies are read anywhere in this tree, so the version route it polls
 * keeps its CDN cache.
 */
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Games · Madras Pickleball',
  description: 'Open play at Madras Pickleball — what’s on, what it costs, and how many spots are left.',
}

function spotsWord(s: PublicSession) {
  if (s.status === 'cancelled') return 'Not happening'
  if (s.status === 'live') return 'On now'
  if (s.full) return s.waiting > 0 ? `Full · ${s.waiting} waiting` : 'Full — join the waitlist'
  const left = s.capacity - s.taken
  return `${left} spot${left === 1 ? '' : 's'} left`
}

export default async function GamesPage() {
  await ensureReady()
  const now = new Date()
  const [sessions, version] = await Promise.all([publicSessions(now), publicSessionsVersion(now)])

  const live = sessions.filter((s) => s.status !== 'cancelled')
  const anyLive = sessions.some((s) => s.status === 'live')
  const byDay = new Map<string, PublicSession[]>()
  for (const s of sessions) {
    const key = venueDate(s.startsAt)
    const list = byDay.get(key) ?? []
    list.push(s)
    byDay.set(key, list)
  }

  return (
    <main id="main" className="min-h-dvh bg-ground pb-16">
      <GamesRefresh endpoint="/api/public/games/version" version={version} mode={anyLive ? 'live' : 'idle'} />
      <Masthead
        title="Games"
        sub={live.length ? `${live.length} coming up` : 'Nothing on today'}
      />

      <div className="mx-auto w-full max-w-3xl px-4 pt-6">
        {sessions.length === 0 ? (
          <EmptyState title="Nothing on the list yet">
            <p>
              When the host puts a game up it appears here. It is worth keeping this page open — the
              spots count updates on its own.
            </p>
          </EmptyState>
        ) : (
          <div className="flex flex-col gap-7">
            {[...byDay.entries()].map(([day, list]) => (
              <section key={day}>
                <Eyebrow>{day}</Eyebrow>
                <Panel className="mt-2">
                  <ul className="divide-y divide-line">
                    {list.map((s) => (
                      <li key={s.slug}>
                        <Link
                          href={`/g/${s.slug}` as never}
                          className="flex min-h-[76px] items-center gap-3 px-4 py-3.5 active:bg-sunken"
                        >
                          <div className="min-w-0 flex-1">
                            <p
                              className={
                                s.status === 'cancelled'
                                  ? 'text-row font-semibold text-text-3 line-through'
                                  : 'text-row font-semibold text-text'
                              }
                            >
                              {s.title}
                            </p>
                            <p className="num mt-0.5 text-meta text-text-2">
                              {venueTime(s.startsAt)}–{venueTime(s.endsAt)} ·{' '}
                              {s.courtCount === 1 ? '1 court' : `${s.courtCount} courts`} ·{' '}
                              {s.pricePaise > 0 ? rupees(s.pricePaise) : 'Free'}
                            </p>
                            <p className="mt-1 flex flex-wrap items-center gap-1.5">
                              {s.status === 'cancelled' ? (
                                <Tag tone="alert">Called off</Tag>
                              ) : (
                                <Tag tone={s.full ? 'waiting' : 'neutral'}>
                                  <span className="num">
                                    {s.taken}/{s.capacity}
                                  </span>{' '}
                                  in
                                </Tag>
                              )}
                              <span className="text-meta text-text-3">{spotsWord(s)}</span>
                            </p>
                          </div>
                          {s.status === 'live' ? <StatusPill state="live">On</StatusPill> : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </Panel>
              </section>
            ))}
          </div>
        )}
      </div>
    </main>
  )
}
