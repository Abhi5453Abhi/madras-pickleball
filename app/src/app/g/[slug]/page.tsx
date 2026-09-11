import { notFound } from 'next/navigation'
import { Card, EmptyState, Meter, Notice, Panel, StatusPill, Tag } from '@/components/ui'
import { rupees } from '@/lib/display'
import { venueDate, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { publicSession, publicSessionVersion } from '@/server/daily-public'
import { Masthead } from '../../t/court-card'
import { GamesRefresh } from '../../games/refresh'
import { JoinForm, MySpot } from './join-form'
import { ShareGame } from './share'

/**
 * One game, for anybody with the link.
 *
 * First name and last initial, spots taken, the price, and two fields to join.
 * No login and no cookies — the link gets forwarded into WhatsApp groups and
 * has to work for whoever opens it.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata(props: PageProps<'/g/[slug]'>) {
  const { slug } = await props.params
  const s = await publicSession(slug)
  const title = s ? `${s.title} · Madras Pickleball` : 'Madras Pickleball'
  const description = s
    ? `${venueDate(s.startsAt)}, ${venueTime(s.startsAt)}–${venueTime(s.endsAt)} · ${s.taken}/${s.capacity} in · ${s.pricePaise > 0 ? rupees(s.pricePaise) : 'free'}`
    : 'Open play at Madras Pickleball.'
  return { title, description, openGraph: { title, description, type: 'website' } }
}

export default async function GamePage(props: PageProps<'/g/[slug]'>) {
  await ensureReady()
  const { slug } = await props.params
  const now = new Date()
  const s = await publicSession(slug, now)
  if (!s) notFound()
  const version = await publicSessionVersion(slug)

  const over = s.status === 'ended' || s.status === 'locked' || s.status === 'cancelled'
  const closed = over || now >= s.startsAt
  const left = Math.max(0, s.capacity - s.taken)

  const shareText = `${s.title} — ${venueDate(s.startsAt)} ${venueTime(s.startsAt)}–${venueTime(s.endsAt)}, ${s.courtCount === 1 ? '1 court' : `${s.courtCount} courts`}, ${s.pricePaise > 0 ? rupees(s.pricePaise) : 'free'}. ${s.taken}/${s.capacity} in.`

  return (
    <main id="main" className="min-h-dvh bg-ground pb-16">
      <GamesRefresh
        endpoint={`/api/public/g/${slug}/version`}
        version={version ?? 0}
        mode={over ? 'off' : s.status === 'live' ? 'live' : 'idle'}
      />
      <Masthead
        title={s.title}
        sub={`${venueDate(s.startsAt)} · ${venueTime(s.startsAt)}–${venueTime(s.endsAt)}`}
      />

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-7 px-4 pt-6">
        <p className="sr-only" role="status">
          {s.taken} of {s.capacity} spots taken{s.waiting > 0 ? `, ${s.waiting} waiting` : ''}.
        </p>

        {s.status === 'cancelled' ? (
          <Notice tone="alert" title="Called off">
            This game isn’t happening. Nobody is charged for it.
          </Notice>
        ) : null}

        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="num text-score font-score text-ink">
                {s.taken}
                <span className="text-text-3">/{s.capacity}</span>
              </p>
              <p className="text-meta text-text-2">
                {s.status === 'cancelled'
                  ? 'Called off'
                  : over
                  ? 'Finished'
                  : s.full
                    ? s.waiting > 0
                      ? `Full · ${s.waiting} waiting`
                      : 'Full'
                    : `${left} spot${left === 1 ? '' : 's'} left`}
              </p>
            </div>
            <div className="text-right">
              <p className="num text-section text-text">
                {s.pricePaise > 0 ? rupees(s.pricePaise) : 'Free'}
              </p>
              <p className="text-meta text-text-3">
                {s.courtCount === 1 ? '1 court' : `${s.courtCount} courts`}
              </p>
            </div>
          </div>
          <Meter
            className="mt-3"
            done={s.taken}
            total={s.capacity}
            label={`${s.taken} of ${s.capacity} spots taken`}
          />
          {s.notes ? <p className="mt-3 text-body text-text-2">{s.notes}</p> : null}
          {s.pricePaise > 0 && !over ? (
            <p className="mt-3 text-meta text-text-3">
              Nothing to pay now. The host settles up after you’ve played.
            </p>
          ) : null}
        </Card>

        {/* The spot page survives the game: it is where a player looks to see
            what they owe once billing is switched on. */}
        <section className="flex flex-col gap-3">
          <MySpot slug={slug} />
        </section>

        {!over ? (
          <section className="flex flex-col gap-3">
            {closed ? (
              <Notice tone="waiting" title="Sign-ups closed">
                This game has started. Ask the host to put you on if there’s room.
              </Notice>
            ) : (
              <JoinForm slug={slug} full={s.full} closed={closed} />
            )}
          </section>
        ) : null}

        <section>
          <h2 className="font-score text-eyebrow text-text-2 uppercase">
            Who’s in
            <small className="num ml-1.5 font-normal normal-case text-text-3">{s.taken}</small>
          </h2>
          {s.spots.length === 0 && s.hidden === 0 ? (
            <div className="mt-2">
              <EmptyState title="Nobody yet">
                <p>Be the first — the rest usually follow within the hour.</p>
              </EmptyState>
            </div>
          ) : (
            <Panel className="mt-2">
              <ul className="divide-y divide-line">
                {s.spots.map((p, i) => (
                  <li key={`${p.name}-${i}`} className="flex items-center gap-3 px-4 py-3">
                    <span className="num w-6 shrink-0 text-meta text-text-3">{i + 1}</span>
                    <span className="min-w-0 flex-1 text-row text-text">{p.name}</span>
                    {p.here ? <StatusPill state="live">Here</StatusPill> : null}
                  </li>
                ))}
                {s.hidden > 0 ? (
                  <li className="px-4 py-3 text-meta text-text-3">
                    and {s.hidden} {s.hidden === 1 ? 'person who’s' : 'people who are'} keeping their
                    name off the list
                  </li>
                ) : null}
              </ul>
            </Panel>
          )}
        </section>

        {s.waitingList.length > 0 ? (
          <section>
            <h2 className="font-score text-eyebrow text-text-2 uppercase">
              Waiting
              <small className="num ml-1.5 font-normal normal-case text-text-3">{s.waiting}</small>
            </h2>
            <Panel className="mt-2">
              <ul className="divide-y divide-line">
                {s.waitingList.map((p, i) => (
                  <li key={`${p.name}-${i}`} className="flex items-center gap-3 px-4 py-3">
                    <span className="num w-6 shrink-0 text-meta text-text-3">{i + 1}</span>
                    <span className="min-w-0 flex-1 text-row text-text-2">{p.name}</span>
                    <Tag tone="waiting">Waiting</Tag>
                  </li>
                ))}
              </ul>
            </Panel>
          </section>
        ) : null}

        {!over ? (
          <section>
            <h2 className="font-score text-eyebrow text-text-2 uppercase">Short of players?</h2>
            <div className="mt-2">
              <ShareGame text={shareText} />
            </div>
          </section>
        ) : null}
      </div>
    </main>
  )
}
