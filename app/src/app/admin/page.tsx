import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import {
  Card,
  CourtMark,
  CourtSwatch,
  Meter,
  Notice,
  StatusPill,
} from '@/components/ui'
import { venueDate } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { dashboard, formatWords, type DashboardRow } from '@/server/events'
import { PRIMARY_LINK } from './_ui'

/**
 * The front door once you are in. Everything on today at the top with its
 * courts and progress, then what is coming, then what is done. One button to
 * make a new one.
 */
export const metadata = { title: 'Tournaments · Madras Pickleball' }

export const dynamic = 'force-dynamic'

export default async function AdminHome(props: PageProps<'/admin'>) {
  await ensureReady()
  await requireUser('admin')
  const { denied } = await props.searchParams

  const { today, upcoming, finished } = await dashboard()
  const nothing = today.length + upcoming.length + finished.length === 0
  const anyLive = today.some((t) => t.status === 'live')

  return (
    <div className="flex flex-col gap-7">
      {denied ? (
        <Notice tone="info">That part of the app is for the venue owner. Everything else is yours.</Notice>
      ) : null}

      <header className="flex items-end justify-between gap-3">
        <div>
          <p className="font-score text-eyebrow text-accent uppercase">Organiser</p>
          <h1 className="mt-1 text-title text-text">Tournaments</h1>
        </div>
        {nothing ? null : (
          <Link
            href="/admin/new"
            className="tap -mr-1 inline-flex shrink-0 items-center gap-1 px-2 text-[17px] font-bold text-link"
          >
            <span aria-hidden>+</span> New
          </Link>
        )}
      </header>

      {/* Daily games are the other half of the venue's week and have their own
          list; tournaments and open play never share a screen. */}
      <Link
        href="/admin/games"
        className="tap flex items-center justify-between gap-3 rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text"
      >
        Daily games
        <span aria-hidden className="text-text-3">
          &rsaquo;
        </span>
      </Link>

      {/* What came in, split by how it came in, and who is still short. */}
      <Link
        href="/admin/money"
        className="tap flex items-center justify-between gap-3 rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text"
      >
        The day’s money
        <span aria-hidden className="text-text-3">
          &rsaquo;
        </span>
      </Link>

      {nothing ? (
        <div className="relative overflow-hidden rounded-card border border-line-strong bg-paper p-6 shadow-card">
          <CourtMark className="pointer-events-none absolute -right-6 -bottom-8 size-40 text-ink opacity-[0.05]" />
          <h2 className="text-section text-text">Nothing on yet</h2>
          <p className="mt-2 max-w-sm text-body text-text-2">
            Make a tournament and you get a sign-up link, a court board and a public page for it.
          </p>
          <Link href="/admin/new" className={`${PRIMARY_LINK} mt-5 max-w-[18rem]`}>
            Make a tournament
          </Link>
        </div>
      ) : null}

      {today.length ? (
        <section className="flex flex-col gap-3">
          <Eyebrow live={anyLive}>
            On today <small className="num ml-1 font-normal normal-case text-text-3">{venueDate(new Date())}</small>
          </Eyebrow>
          <ul className="flex flex-col gap-3">
            {today.map((t) => (
              <li key={t.id}>
                <TodayCard row={t} />
              </li>
            ))}
          </ul>
          {anyLive ? (
            <Link href="/admin/live" className={PRIMARY_LINK}>
              Open the live board
            </Link>
          ) : null}
        </section>
      ) : null}

      {upcoming.length ? (
        <section className="flex flex-col gap-3">
          <Eyebrow>Coming up</Eyebrow>
          <ul className="flex flex-col gap-3">
            {upcoming.map((t) => (
              <li key={t.id}>
                <UpcomingCard row={t} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {finished.length ? (
        <section className="flex flex-col gap-3">
          <Eyebrow>Finished</Eyebrow>
          <Card>
            <ul className="divide-y divide-line">
              {finished.map((t) => (
                <li key={t.id}>
                  <Link href={`/admin/t/${t.slug}`} className="tap-lg flex items-center gap-3 px-4">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-row text-text">{t.name}</span>
                      <span className="num block text-meta text-text-3">
                        {venueDate(t.startDate)}
                        {t.winnerName ? ` · won by ${t.winnerName}` : ''}
                      </span>
                    </span>
                    <StatusPill state="done">Done</StatusPill>
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      ) : null}

      {nothing ? (
        <p className="text-meta text-text-3">
          Players sign up from a link you send them. You enter every score.
        </p>
      ) : null}
    </div>
  )
}

function Eyebrow({ children, live }: { children: React.ReactNode; live?: boolean }) {
  return (
    <h2 className={`font-score text-eyebrow uppercase ${live ? 'text-live-text' : 'text-text-2'}`}>
      {children}
    </h2>
  )
}

function sizeLine(t: DashboardRow) {
  const unit = t.discipline === 'doubles' ? 'pairs' : 'players'
  const teams = t.teams ? ` · ${t.teams} ${t.teams === 1 ? unit.slice(0, -1) : unit}` : ''
  return `${t.players} ${t.players === 1 ? 'player' : 'players'}${
    t.discipline === 'doubles' ? teams : ''
  } · ${formatWords(t.format)}`
}

/** "Men's Doubles · 12 players" says the name twice when the name IS the category. */
function categoryPrefix(t: DashboardRow) {
  return t.name.includes(t.category) ? '' : `${t.category} · `
}

function CourtChips({ courts }: { courts: DashboardRow['courts'] }) {
  if (!courts.length) return <p className="text-meta text-waiting">No courts picked yet</p>
  return (
    <ul className="flex flex-wrap gap-1.5">
      {courts.map((c) => (
        <li
          key={c.id}
          className="inline-flex items-center gap-1.5 rounded-full border border-line-strong bg-sunken px-2 py-0.5 text-meta font-semibold text-text-2"
        >
          <CourtSwatch colorKey={c.colorKey} />
          {c.name}
        </li>
      ))}
    </ul>
  )
}

function TodayCard({ row: t }: { row: DashboardRow }) {
  const live = t.status === 'live'
  const done = t.status === 'completed'
  return (
    <Link href={`/admin/t/${t.slug}`} className="block">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-section text-text">{t.name}</h3>
          {live ? (
            <StatusPill state="live">Live</StatusPill>
          ) : done ? (
            <StatusPill state="done">Done</StatusPill>
          ) : (
            <StatusPill state="waiting">Setting up</StatusPill>
          )}
        </div>
        <p className="num mt-1 text-meta text-text-2">
          {categoryPrefix(t)}
          {sizeLine(t)}
        </p>
        <div className="mt-2.5">
          <CourtChips courts={t.courts} />
        </div>
        {t.matchesTotal > 0 ? (
          <>
            <Meter
              className="mt-3"
              done={t.matchesPlayed}
              total={t.matchesTotal}
              label={`${t.matchesPlayed} of ${t.matchesTotal} matches played`}
            />
            <p className="num mt-1.5 text-meta text-text-3">
              {t.matchesPlayed} of {t.matchesTotal} played
              {t.matchesLive ? ` · ${t.matchesLive} on court` : ''}
            </p>
          </>
        ) : (
          <p className="mt-3 text-meta text-text-3">
            {t.registrationOpen ? 'Sign-ups open' : 'Sign-ups closed'} · schedule not made yet
          </p>
        )}
      </Card>
    </Link>
  )
}

function UpcomingCard({ row: t }: { row: DashboardRow }) {
  return (
    <Link href={`/admin/t/${t.slug}`} className="block">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-section text-text">{t.name}</h3>
          <StatusPill state="waiting">{venueDate(t.startDate)}</StatusPill>
        </div>
        <p className="num mt-1 text-meta text-text-2">
          {categoryPrefix(t)}
          {t.players} registered · {formatWords(t.format)}
        </p>
        <p className="mt-1 text-meta text-text-3">
          {t.registrationOpen ? 'Sign-ups open' : 'Sign-ups closed'}
          {t.pendingSignups ? ` · ${t.pendingSignups} possible ${t.pendingSignups === 1 ? 'duplicate' : 'duplicates'}` : ''}
          {' · '}
          {t.courts.length
            ? t.courts.map((c) => c.name).join(', ')
            : 'no courts assigned yet'}
        </p>
      </Card>
    </Link>
  )
}
