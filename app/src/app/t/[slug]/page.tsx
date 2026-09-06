import { clsx } from 'clsx'
import { notFound } from 'next/navigation'
import { CourtMark, NetRule, Panel, SectionHead, StatusPill } from '@/components/ui'
import { MatchRow } from '@/components/match-row'
import { FindMyMatch } from './find-my-match'
import { LiveRefresh } from './live-refresh'
import { venueDate } from '@/lib/time'
import { tiebreakNote } from '@/lib/standings'
import { publicPlayers, publicTournament } from '@/server/public'
import { ensureReady } from '@/server/bootstrap'

/**
 * The public page — SPEC A8. One scrolling page, not six tabs: tabs on a 390px
 * screen make a visitor pick a category before they get an answer.
 *
 * No cookies are read anywhere in this tree, so the CDN keeps caching it.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata(props: PageProps<'/t/[slug]'>) {
  const { slug } = await props.params
  const data = await publicTournament(slug)
  return {
    title: data ? `${data.tournament.name} · Madras Pickleball` : 'Madras Pickleball',
    description: 'Live scores, the order of play and results.',
  }
}

export default async function PublicTournament(props: PageProps<'/t/[slug]'>) {
  await ensureReady()
  const { slug } = await props.params
  const data = await publicTournament(slug)
  if (!data) notFound()

  const roster = await publicPlayers(data.tournament.id)
  const isLive = data.live.length > 0

  return (
    <div className="min-h-dvh bg-ground pb-16">
      <LiveRefresh slug={slug} version={data.streamVersion} active={isLive} />

      <header className="relative overflow-hidden bg-ink px-4 pt-6 pb-5 text-white">
        <CourtMark className="pointer-events-none absolute -right-8 -bottom-10 w-56 text-white opacity-[0.07]" />
        <p className="font-score text-eyebrow text-accent-line uppercase">Madras Pickleball</p>
        <h1 className="mt-1 text-hero">{data.tournament.name}</h1>
        <p className="num mt-1.5 text-body text-on-ink-2">
          {venueDate(data.tournament.startDate)} · {roster.length} players ·{' '}
          {data.matches.length} matches
        </p>
        {isLive ? (
          <p className="mt-4 inline-flex items-center gap-2 rounded-control bg-white/15 px-4 py-2 text-[17px] font-semibold">
            <span aria-hidden className="size-2.5 rounded-full bg-live" />
            {data.live.length} live now
          </p>
        ) : null}
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-accent-line" />
      </header>

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 pt-6">
        {data.live.length ? (
          <section>
            <div className="flex items-baseline gap-2">
              <span aria-hidden className="size-2.5 self-center rounded-full bg-live" />
              <h2 className="font-score text-eyebrow text-live-text uppercase">Live now</h2>
            </div>
            <div className="mt-3 flex flex-col gap-3">
              {data.live.map((m) => (
                <article
                  key={m.id}
                  className="overflow-hidden rounded-card border border-line-strong bg-paper shadow-card"
                >
                  <div aria-hidden className="h-1 bg-live" />
                  <div className="flex items-center gap-2 px-4 pt-3">
                    <span className="font-score text-eyebrow text-text-2 uppercase">
                      {m.courtName ?? 'On court'}
                    </span>
                    <span className="ml-auto text-meta text-text-3">{m.categoryName}</span>
                  </div>
                  <div className="px-4 pt-2 pb-4">
                    <p className="truncate text-row text-text">{m.nameA}</p>
                    <p className="truncate text-row text-text">{m.nameB}</p>
                  </div>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <FindMyMatch
          players={roster.map((p) => ({ id: p.id, name: p.name, teamIds: p.teamIds }))}
          matches={data.matches.map((m, i) => ({
            id: m.id,
            teamAId: null,
            teamBId: null,
            nameA: m.nameA,
            nameB: m.nameB,
            playersA: m.playersA,
            playersB: m.playersB,
            courtName: m.courtName,
            status: m.status,
            state: m.state,
            categoryName: m.categoryName,
            roundName: m.roundName,
            queuePosition: i,
            scoreLine: m.scoreLine,
            winnerSide: m.winnerSide,
          }))}
        />

        {data.upNext.length ? (
          <section className="flex flex-col gap-4">
            <SectionHead title="Up next" meta="in the order they'll be called" />
            <Panel>
              <ul className="divide-y divide-line">
                {data.upNext.map((m, i) => (
                  <li key={m.id}>
                    <MatchRow
                      nameA={m.nameA}
                      nameB={m.nameB}
                      gamesWonA={0}
                      gamesWonB={0}
                      winnerSide={null}
                      hasScore={false}
                      state={i === 0 ? 'ready' : 'waiting'}
                      stateLabel={i === 0 ? 'Next' : `${i + 1}${i === 1 ? 'nd' : i === 2 ? 'rd' : 'th'}`}
                      meta={`${m.categoryName}${m.roundName ? ` · ${m.roundName}` : ''}`}
                    />
                  </li>
                ))}
              </ul>
            </Panel>
          </section>
        ) : null}

        {data.tables.map((t) => (
          <section key={t.category.id} className="flex flex-col gap-4">
            <SectionHead title={t.category.name} meta={`${t.rows.length} teams`} />
            <Panel>
              <div className="font-score grid grid-cols-[22px_1fr_30px_30px_38px] items-center gap-2 bg-sunken px-4 py-2.5 text-eyebrow text-text-2 uppercase">
                <span className="text-right">#</span>
                <span>Team</span>
                <span className="text-right">Pld</span>
                <span className="text-right">Won</span>
                <span className="text-right">Pts</span>
              </div>
              <ul className="divide-y divide-line">
                {t.rows.map((row, idx) => (
                  <li
                    key={row.teamId}
                    className={clsx(
                      'relative grid min-h-[60px] grid-cols-[22px_1fr_30px_30px_38px] items-center gap-2 px-4 py-3',
                      idx < t.advance &&
                        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent-line',
                    )}
                  >
                    <span className="num text-right text-[20px] font-bold text-text">{idx + 1}</span>
                    <span className="min-w-0">
                      <span className="block text-row text-text">
                        {data.teamName.get(row.teamId) ?? '—'}
                      </span>
                      {row.provisional ? (
                        <span className="block text-meta text-waiting">
                          Provisional — a result is still to be confirmed
                        </span>
                      ) : null}
                    </span>
                    <span className="num text-right text-num font-semibold text-text-3">
                      {row.played}
                    </span>
                    <span className="num text-right text-num text-text">{row.won}</span>
                    <span className="num text-right text-num font-semibold text-text-2">
                      {row.pointsFor}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="border-t border-line bg-sunken px-4 py-3 text-meta text-text-2">
                {tiebreakNote(t.category.tiebreakRule)}
              </p>
            </Panel>
          </section>
        ))}

        {data.results.length ? (
          <section className="flex flex-col gap-4">
            <SectionHead title="Results" meta={`${data.results.length} played`} />
            <Panel>
              <ul className="divide-y divide-line">
                {data.results.map((m) => (
                  <li key={m.id}>
                    <MatchRow
                      nameA={m.nameA}
                      nameB={m.nameB}
                      gamesWonA={m.gamesWonA}
                      gamesWonB={m.gamesWonB}
                      winnerSide={m.winnerSide}
                      hasScore
                      state={m.provisional ? 'waiting' : 'done'}
                      stateLabel="Final"
                      meta={
                        m.scoreLine
                          ? `${m.scoreLine}${m.provisional ? ' · unconfirmed' : ''}`
                          : undefined
                      }
                    />
                  </li>
                ))}
              </ul>
            </Panel>
          </section>
        ) : null}

        {data.matches.some((m) => m.state === 'disputed') ? (
          <p className="rounded-control bg-alert-soft px-4 py-3 text-body text-alert">
            One result is under review. An organiser is sorting it out.
          </p>
        ) : null}

        <section className="flex flex-col gap-4">
          <SectionHead title="Teams" meta={`${data.teamName.size} in total`} />
          <Panel>
            <ul className="divide-y divide-line">
              {[...data.teamName.entries()].map(([id, name]) => (
                <li key={id} className="flex min-h-[56px] items-center px-4 text-row text-text">
                  <span className="truncate">{name}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </section>

        <NetRule />
        <p className="text-meta text-text-3">
          Scores go final 10 minutes after they’re entered unless someone disputes them.
        </p>
      </div>
    </div>
  )
}
