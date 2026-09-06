import Link from 'next/link'
import { desc, isNotNull, isNull, and } from 'drizzle-orm'
import { db } from '@/db'
import { tournaments } from '@/db/schema'
import { ensureReady } from '@/server/bootstrap'
import {
  CourtMark,
  EmptyState,
  NetRule,
  SkipLink,
  StatusPill,
  statusWords,
  Wordmark,
} from '@/components/ui'
import { venueDate } from '@/lib/time'

export const dynamic = 'force-dynamic'

/**
 * The front door. Almost everyone arriving here has followed a link from the
 * WhatsApp group and wants today's tournament, so today's tournament is a
 * single full-width target, not the first row of a list.
 */
export default async function Home() {
  await ensureReady()
  const published = await db
    .select()
    .from(tournaments)
    .where(and(isNull(tournaments.deletedAt), isNotNull(tournaments.publishedAt)))
    .orderBy(desc(tournaments.startDate))
    .limit(10)

  const current = published.find((t) => t.status === 'live') ?? published[0] ?? null
  const rest = published.filter((t) => t.id !== current?.id)

  return (
    <div className="min-h-dvh bg-ground pb-16">
      <SkipLink>Skip to the tournaments</SkipLink>
      <header className="masthead relative overflow-hidden bg-ink px-4 pt-8 pb-7 text-white">
        <CourtMark className="pointer-events-none absolute -right-8 -bottom-12 w-56 text-white opacity-[0.07] print:hidden" />
        <div className="mx-auto w-full max-w-3xl">
          <Wordmark />
          <h1 className="mt-4 text-hero sm:text-[38px] sm:leading-[42px]">
            {current ? current.name : 'Nothing on right now'}
          </h1>
          <p className="mt-1.5 text-body text-on-ink-2">
            {current
              ? venueDate(current.startDate)
              : 'When a tournament is on, every court, every score and your next match show up here.'}
          </p>
        </div>
        <NetRule className="absolute inset-x-0 bottom-0" />
      </header>

      <main id="main" className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        {current ? (
          <Link
            href={`/t/${current.slug}`}
            className="tap-xl flex items-center gap-3 rounded-card border border-line-key bg-paper px-4 shadow-card"
          >
            <span className="min-w-0 flex-1">
              <span className="block text-section text-text">
                {current.status === 'live' ? 'Live scores and my next match' : 'Scores and results'}
              </span>
              <span className="block text-meta text-text-3">{current.name}</span>
            </span>
            <StatusPill state={statusWords(current.status).state}>
              {statusWords(current.status).label}
            </StatusPill>
          </Link>
        ) : (
          <EmptyState title="No tournament published">
            <p>Nothing is live yet. Check the WhatsApp group for the next Sunday.</p>
          </EmptyState>
        )}

        {rest.length ? (
          <section className="mt-2 flex flex-col gap-2">
            <h2 className="font-score text-eyebrow text-text-2 uppercase">Earlier</h2>
            <ul className="flex flex-col gap-2">
              {rest.map((t) => {
                const s = statusWords(t.status)
                return (
                  <li key={t.id}>
                    <Link
                      href={`/t/${t.slug}`}
                      className="tap flex items-center gap-3 rounded-card border border-line-key bg-paper px-4 shadow-card"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-row text-text">{t.name}</span>
                        <span className="num block text-meta text-text-3">
                          {venueDate(t.startDate)}
                        </span>
                      </span>
                      <StatusPill state={s.state}>{s.label}</StatusPill>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}

        <div className="mt-4 border-t border-line pt-4">
          <Link
            href="/login"
            className="tap flex items-center justify-center rounded-control border border-line-key bg-paper text-[17px] font-semibold text-text"
          >
            Organiser sign in
          </Link>
          <p className="mt-2 text-center text-meta text-text-3">
            Scorers don’t need an account — scan the QR on the net post.
          </p>
        </div>
      </main>
    </div>
  )
}
