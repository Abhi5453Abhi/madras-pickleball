import Link from 'next/link'
import { desc, isNotNull, isNull, and } from 'drizzle-orm'
import { db } from '@/db'
import { tournaments } from '@/db/schema'
import { ensureReady } from '@/server/bootstrap'
import { CourtMark, StatusPill, statusWords } from '@/components/ui'
import { venueDate } from '@/lib/time'

export const dynamic = 'force-dynamic'

export default async function Home() {
  await ensureReady()
  const published = await db
    .select()
    .from(tournaments)
    .where(and(isNull(tournaments.deletedAt), isNotNull(tournaments.publishedAt)))
    .orderBy(desc(tournaments.startDate))
    .limit(10)

  const current = published.find((t) => t.status === 'live') ?? published[0] ?? null

  return (
    <main className="min-h-dvh">
      <header className="relative overflow-hidden bg-ink px-4 pt-8 pb-6 text-white">
        <CourtMark className="pointer-events-none absolute -right-8 -bottom-10 w-56 text-white opacity-[0.07]" />
        <div className="mx-auto w-full max-w-3xl">
          <div className="flex items-center gap-2.5">
            <CourtMark className="size-8" />
            <span className="font-score text-[22px] font-bold tracking-[0.02em]">
              Madras Pickleball
            </span>
          </div>
          <h1 className="mt-4 text-hero">
            {current ? current.name : 'Nothing on right now'}
          </h1>
          <p className="mt-1.5 text-body text-on-ink-2">
            {current
              ? venueDate(current.startDate)
              : 'When a tournament is on, every court, every score and your next match show up here.'}
          </p>
        </div>
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-accent-line" />
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 p-4">
        {published.map((t) => {
          const s = statusWords(t.status)
          return (
            <Link key={t.id} href={`/t/${t.slug}`}>
              <article className="flex items-center gap-3 rounded-card border border-line-strong bg-paper p-4 shadow-card">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-section text-text">{t.name}</p>
                  <p className="num mt-0.5 text-meta text-text-3">{venueDate(t.startDate)}</p>
                </div>
                <StatusPill state={s.state}>{s.label}</StatusPill>
              </article>
            </Link>
          )
        })}

        <Link
          href="/login"
          className="tap mt-2 flex items-center justify-center rounded-control border border-line-strong bg-paper text-[17px] font-semibold text-text"
        >
          Organiser sign in
        </Link>
        <p className="text-center text-meta text-text-3">
          Scorers don’t need an account — scan the QR on the net post.
        </p>
      </div>
    </main>
  )
}
