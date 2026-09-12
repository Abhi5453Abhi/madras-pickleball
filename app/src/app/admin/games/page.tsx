import Link from 'next/link'
import { Button, EmptyState, Notice, Panel, SectionHead, StatusPill, Tag, type Status } from '@/components/ui'
import { requireUser } from '@/lib/auth'
import { rupees } from '@/lib/display'
import { TICK_STALE_AFTER_MIN } from '@/lib/daily-clock'
import { venueDate, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { schedulerHealth } from '@/server/daily-reconcile'
import { allSessions, countRoster, roster } from '@/server/sessions'
import { Eyebrow } from '../../t/court-card'
import { PRIMARY_LINK, SECONDARY_LINK } from '../_ui'
import { runGateNow } from '../g/[slug]/actions'

/** The host's list of daily games. Drafts included — they are not public yet. */
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Games · Madras Pickleball' }

const WORDS: Record<string, { label: string; tone: Status }> = {
  draft: { label: 'Draft', tone: 'waiting' },
  open: { label: 'Open', tone: 'ready' },
  live: { label: 'On now', tone: 'live' },
  ended: { label: 'Finished', tone: 'done' },
  locked: { label: 'Closed', tone: 'done' },
  cancelled: { label: 'Called off', tone: 'alert' },
}

export default async function AdminGames() {
  await requireUser('admin')
  await ensureReady()
  const now = new Date()
  const sessions = await allSessions()
  const health = await schedulerHealth(now)

  const counts = new Map<string, ReturnType<typeof countRoster>>()

  const upcoming = sessions.filter((s) => s.status === 'draft' || s.status === 'open' || s.status === 'live')
  const past = sessions.filter((s) => !upcoming.includes(s))
  const stale = health.ageMinutes === null || health.ageMinutes > TICK_STALE_AFTER_MIN
  // The gate is venue-wide, so running it by hand needs any game to hang the
  // button off; the soonest one is the one the host is thinking about.
  const next = upcoming[0] ?? null
  // Every row that renders a count gets one — slicing the source list and the
  // rendered list separately left later rows silently missing their numbers.
  for (const s of [...upcoming, ...past.slice(0, 20)]) counts.set(s.id, countRoster(await roster(s.id)))

  return (
    <div className="flex flex-col gap-6">
      <SectionHead title="Daily games" meta="Open play. Players join with a name and a phone." />

      <Link href="/admin/courts/day" className={SECONDARY_LINK}>
        What is on today, and what is free
      </Link>

      <Link href="/admin/games/new" className={PRIMARY_LINK}>
        Put a game up
      </Link>

      {/* The signal an opportunistic page-render trigger would have hidden by
          quietly doing the work on render. Shown only when it is bad news:
          "ran 3 min ago" on every load is noise, and noise is what stops a
          warning being read. */}
      {stale ? (
        <Notice
          tone="alert"
          title="Gate not running"
          detail={
            health.ageMinutes === null
              ? 'It has never run on this database.'
              : `It last ran ${health.ageMinutes} min ago.${health.lastError ? ' The last run reported a problem.' : ''}`
          }
          action={
            next ? (
              <form action={runGateNow}>
                <input type="hidden" name="slug" value={next.slug} />
                <Button type="submit" variant="secondary" className="w-full">
                  Run it now
                </Button>
              </form>
            ) : undefined
          }
        >
          Confirmations, the waitlist and finishing a night are not happening on their own.
        </Notice>
      ) : null}

      {upcoming.length === 0 ? (
        <EmptyState title={sessions.length ? 'Nothing coming up' : 'No games yet'}>
          <p>Put one up and share the link. Players join with two fields and no account.</p>
        </EmptyState>
      ) : (
        <Panel>
          <ul className="divide-y divide-line">
            {upcoming.map((s) => {
              const c = counts.get(s.id)
              const w = WORDS[s.status] ?? WORDS.draft
              return (
                <li key={s.id}>
                  <Link
                    href={`/admin/g/${s.slug}` as never}
                    className="flex min-h-[76px] items-center gap-3 px-4 py-3.5 active:bg-sunken"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="text-row font-semibold text-text">{s.title}</p>
                      <p className="num mt-0.5 text-meta text-text-2">
                        {venueDate(s.startsAt)} · {venueTime(s.startsAt)}–{venueTime(s.endsAt)} ·{' '}
                        {s.pricePaise > 0 ? rupees(s.pricePaise) : 'Free'}
                      </p>
                      {c ? (
                        <p className="mt-1 flex flex-wrap items-center gap-1.5">
                          <Tag tone={c.taken >= s.capacity ? 'waiting' : 'neutral'}>
                            <span className="num">
                              {c.taken}/{s.capacity}
                            </span>{' '}
                            in
                          </Tag>
                          {c.waiting > 0 ? <Tag tone="waiting">{c.waiting} waiting</Tag> : null}
                          {c.unconfirmed > 0 && s.confirmationGate ? (
                            <Tag tone="alert">{c.unconfirmed} not confirmed</Tag>
                          ) : null}
                        </p>
                      ) : null}
                    </div>
                    <StatusPill state={w.tone}>{w.label}</StatusPill>
                  </Link>
                </li>
              )
            })}
          </ul>
        </Panel>
      )}

      {past.length > 0 ? (
        <section>
          <Eyebrow>Finished</Eyebrow>
          <Panel className="mt-2">
            <ul className="divide-y divide-line">
              {past.slice(0, 20).map((s) => {
                const c = counts.get(s.id)
                const w = WORDS[s.status] ?? WORDS.ended
                return (
                  <li key={s.id}>
                    <Link
                      href={`/admin/g/${s.slug}` as never}
                      className="flex min-h-[64px] items-center gap-3 px-4 py-3 active:bg-sunken"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="text-row text-text-2">{s.title}</p>
                        <p className="num mt-0.5 text-meta text-text-3">
                          {venueDate(s.startsAt)}
                          {c ? ` · ${c.here} played` : ''}
                        </p>
                      </div>
                      <StatusPill state={w.tone}>{w.label}</StatusPill>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </Panel>
        </section>
      ) : null}
    </div>
  )
}
