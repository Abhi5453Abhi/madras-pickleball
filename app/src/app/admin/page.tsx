import Link from 'next/link'
import { desc, inArray, isNull, sql } from 'drizzle-orm'
import { db } from '@/db'
import { matches, tournamentPlayers, tournaments } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { Card, CourtMark, Notice, StatusPill, statusWords } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { PRIMARY_LINK, SECONDARY_LINK } from './_ui'

/**
 * The organiser's front door. Most days it holds one row, and the useful thing
 * about that row is not its name — it is whether anything is on court and how
 * much of the day is left. So the live tournament gets the day's numbers and a
 * button straight to the board; everything else is a line in a list.
 */
export const metadata = { title: 'Tournaments · Madras Pickleball' }

export default async function AdminHome(props: PageProps<'/admin'>) {
  await ensureReady()
  await requireUser('admin')
  const { denied } = await props.searchParams

  const list = await db
    .select()
    .from(tournaments)
    .where(isNull(tournaments.deletedAt))
    .orderBy(desc(tournaments.startDate))
    .limit(20)

  const ids = list.map((t) => t.id)
  const [matchCounts, playerCounts] = ids.length
    ? await Promise.all([
        db
          .select({
            tournamentId: matches.tournamentId,
            total: sql<number>`cast(count(*) as int)`,
            live: sql<number>`cast(count(*) filter (where ${matches.status} = 'live') as int)`,
            unplayed: sql<number>`cast(count(*) filter (where ${matches.resultState} = 'none') as int)`,
          })
          .from(matches)
          .where(inArray(matches.tournamentId, ids))
          .groupBy(matches.tournamentId),
        db
          .select({
            tournamentId: tournamentPlayers.tournamentId,
            n: sql<number>`cast(count(*) as int)`,
          })
          .from(tournamentPlayers)
          .where(inArray(tournamentPlayers.tournamentId, ids))
          .groupBy(tournamentPlayers.tournamentId),
      ])
    : [[], []]

  const byId = new Map(matchCounts.map((r) => [r.tournamentId, r]))
  const players = new Map(playerCounts.map((r) => [r.tournamentId, r.n]))

  if (list.length === 0) {
    return (
      <div className="flex flex-col gap-5">
        {denied ? (
          <Notice tone="info">
            That part of the app is for the venue owner. Everything else is yours.
          </Notice>
        ) : null}
        <div className="relative overflow-hidden rounded-card border border-line-strong bg-paper p-6 shadow-card">
          <CourtMark className="pointer-events-none absolute -right-6 -bottom-8 size-40 text-ink opacity-[0.05]" />
          <h1 className="text-title text-text">Nothing on yet</h1>
          <p className="mt-2 max-w-sm text-body text-text-2">
            Start one and you get a share link, a court board, and a QR card for every court. It
            takes about ninety seconds and everything stays editable afterwards.
          </p>
          <Link href="/admin/quick" className={`${PRIMARY_LINK} mt-5 max-w-[18rem]`}>
            Start a tournament
          </Link>
        </div>
      </div>
    )
  }

  const [latest, ...rest] = list
  const latestCounts = byId.get(latest.id)
  const latestStatus = statusWords(latest.status)
  const running = latest.status === 'live'

  return (
    <div className="flex flex-col gap-6">
      {denied ? (
        <Notice tone="info">
          That part of the app is for the venue owner. Everything else is yours.
        </Notice>
      ) : null}

      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Organiser</p>
        <h1 className="mt-1 text-title text-text">Tournaments</h1>
      </header>

      {/* The one that is on, or the one that was on last. Either way it is the
          row the organiser came here to tap. */}
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <StatusPill state={latestStatus.state}>{latestStatus.label}</StatusPill>
          <span className="num text-meta text-text-3">{venueDate(latest.startDate)}</span>
        </div>
        <h2 className="mt-2 text-section text-text">{latest.name}</h2>
        <p className="num mt-1 text-meta text-text-2">
          {players.get(latest.id) ?? 0} players · {latestCounts?.total ?? 0} matches
          {latestCounts?.live ? ` · ${latestCounts.live} on court` : ''}
          {latestCounts && latestCounts.total > 0 ? ` · ${latestCounts.unplayed} to play` : ''}
        </p>
        <div className="mt-4 flex flex-col gap-2">
          <Link
            href={running ? `/admin/t/${latest.slug}/board` : `/admin/t/${latest.slug}`}
            className={PRIMARY_LINK}
          >
            {running ? 'Court board' : 'Open it'}
          </Link>
          {running ? (
            <Link href={`/admin/t/${latest.slug}`} className={SECONDARY_LINK}>
              Everything else
            </Link>
          ) : null}
        </div>
      </Card>

      <Link href="/admin/quick" className={SECONDARY_LINK}>
        Start another tournament
      </Link>

      {rest.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">Earlier</h2>
          <ul className="flex flex-col gap-2">
            {rest.map((t) => {
              const s = statusWords(t.status)
              const c = byId.get(t.id)
              return (
                <li key={t.id}>
                  <Link href={`/admin/t/${t.slug}`}>
                    <Card className="flex items-center gap-3 p-4">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-row text-text">{t.name}</p>
                        <p className="num mt-0.5 text-meta text-text-3">
                          {venueDate(t.startDate)}
                          {c ? ` · ${c.total} matches` : ''}
                        </p>
                      </div>
                      <StatusPill state={s.state}>{s.label}</StatusPill>
                    </Card>
                  </Link>
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
