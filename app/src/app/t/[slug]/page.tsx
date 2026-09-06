import { notFound } from 'next/navigation'
import {
  CourtMark,
  CourtSwatch,
  Disclosure,
  EmptyState,
  NetRule,
  Notice,
  Panel,
  SectionHead,
  SkipLink,
  Tag,
  TeamName,
  Wordmark,
} from '@/components/ui'
import { MatchRow } from '@/components/match-row'
import { FindMyMatch } from './find-my-match'
import { LiveRefresh } from './live-refresh'
import { Elapsed } from './elapsed'
import { Results } from './results'
import { Tables, type CategoryTable } from './tables'
import { minutesBetween, venueDate } from '@/lib/time'
import { tiebreakNote } from '@/lib/standings'
import { publicPlayers, publicTournament } from '@/server/public'
import { ensureReady } from '@/server/bootstrap'

/**
 * The public page — SPEC A8.
 *
 * It answers four questions, in the order people actually have them:
 *
 *   1. When do I play, and where?   → Find my match, first, one line, big.
 *   2. What's on right now?          → the live courts.
 *   3. Did we go through?            → one table at a time, with the cut line.
 *   4. What was that score?          → findable, not poured out.
 *
 * It used to be 14,600px tall on a 390px phone — forty screens — because it
 * printed three full pool tables, thirty-nine results in one flat list, the
 * same forty-word tiebreak paragraph three times, and then every player's name
 * again at the bottom. Everything below is a consequence of cutting that down
 * without hiding anything a player needs.
 *
 * Still server-rendered. The only client islands are the poll and the name
 * picker; the category switcher is a radio group and CSS, so it works before
 * any JavaScript arrives. No cookies are read anywhere in this tree, so the
 * CDN keeps caching it.
 */
export const dynamic = 'force-dynamic'

/**
 * WhatsApp is the distribution channel, so the link preview is the front door
 * for most of the venue. It is built from data already fetched — no image host
 * and nothing else to load.
 */
export async function generateMetadata(props: PageProps<'/t/[slug]'>) {
  const { slug } = await props.params
  const data = await publicTournament(slug)
  const title = data ? `${data.tournament.name} · Madras Pickleball` : 'Madras Pickleball'
  const description = data
    ? `${venueDate(data.tournament.startDate)} — live scores, the order of play and your next match.`
    : 'Live scores, the order of play and results.'
  return {
    title,
    description,
    openGraph: { title, description, type: 'website' },
  }
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th']
const ordinal = (i: number) => ORDINALS[i] ?? `${i + 1}th`

export default async function PublicTournament(props: PageProps<'/t/[slug]'>) {
  await ensureReady()
  const { slug } = await props.params
  const data = await publicTournament(slug)
  if (!data) notFound()

  const roster = await publicPlayers(data.tournament.id)

  const live = data.live
  const underReview = data.matches.filter((m) => m.state === 'disputed')
  // A cancelled match is not waiting for anybody, and counting it would leave
  // "3 to play" on the page for the rest of the day.
  const toPlay = data.matches.filter(
    (m) => m.state === 'none' && m.status !== 'live' && m.status !== 'cancelled',
  )
  const upNext = data.upNext.slice(0, 4)
  // A bye is a row in the ledger, not something anybody scrolls a results list
  // to read. The player who sat out is told in Find my match, where it matters.
  const results = data.results.filter((m) => m.resultType !== 'bye')
  const started = results.length > 0 || live.length > 0 || underReview.length > 0
  const finished = data.matches.length > 0 && toPlay.length === 0 && live.length === 0
  // A finished day still moves: a provisional result settles ten minutes later
  // and a dispute is resolved by hand. Stopping the poll before either has
  // happened leaves "not confirmed yet" on every phone in the venue for good.
  const settling = underReview.length > 0 || results.some((m) => m.provisional)

  /** Which category table each team sits in, so "see my table" can open it. */
  const tableFor: Record<string, { index: number; name: string }> = {}
  data.tables.forEach((t, index) => {
    for (const row of t.rows) tableFor[row.teamId] = { index, name: t.category.name }
  })

  const tables: CategoryTable[] = data.tables.map((t) => ({
    id: t.category.id,
    name: t.category.name,
    advance: t.advance,
    finalsStage: t.category.finalsStage,
    tiebreakNote: tiebreakNote(t.category.tiebreakRule),
    rows: t.rows.map((r) => ({
      teamId: r.teamId,
      name: data.teamName.get(r.teamId) ?? '—',
      players: data.membersByTeam.get(r.teamId) ?? [],
      played: r.played,
      won: r.won,
      pointsFor: r.pointsFor,
      reason: r.reason,
      provisional: r.provisional,
      disputed: r.disputed,
      withdrawn: r.withdrawn,
    })),
  }))

  const dayLine = finished
    ? `all ${data.matches.length} matches played`
    : started
      ? `${results.length} played · ${toPlay.length} to play`
      : `${data.matches.length} matches to play`

  return (
    <div className="min-h-dvh bg-ground pb-16">
      <LiveRefresh
        slug={slug}
        version={data.streamVersion}
        mode={live.length ? 'live' : finished && !settling ? 'off' : 'idle'}
      />

      <SkipLink>Skip to the day&rsquo;s play</SkipLink>

      {/*
        The page rewrites itself every few seconds and said nothing while it
        did. This is the one sentence that changes when anything material
        does — a match goes on, a score lands, the queue shortens — and
        because it is server-rendered text, React only touches the DOM when
        the numbers actually move. An identical re-render announces nothing,
        which is the difference between a status and a nag.
      */}
      <p role="status" className="sr-only">
        {live.length === 0
          ? 'No match on court.'
          : live.length === 1
            ? '1 match on court.'
            : `${live.length} matches on court.`}{' '}
        {results.length} played, {toPlay.length} to play.
      </p>

      <header className="masthead relative overflow-hidden bg-ink px-4 pt-6 pb-6 text-white">
        <CourtMark className="pointer-events-none absolute -right-8 -bottom-12 w-56 text-white opacity-[0.07] print:hidden" />
        <div className="mx-auto w-full max-w-5xl xl:max-w-6xl">
          <Wordmark />
          {/* The tournament name is the headline of the band, so it scales with
              it: 32px is right above a 390px column and thin across 1120px. */}
          <h1 className="mt-2 text-hero sm:text-[38px] sm:leading-[42px] lg:text-[44px] lg:leading-[48px]">
            {data.tournament.name}
          </h1>
          <p className="num mt-1.5 text-body text-on-ink-2">
            {venueDate(data.tournament.startDate)} · {roster.length} players · {dayLine}
          </p>
          {live.length ? (
            <p className="mt-4 inline-flex items-center gap-2 rounded-control bg-white/15 px-4 py-2 text-[17px] font-semibold print:hidden">
              <span aria-hidden className="size-2.5 rounded-full bg-live" />
              {live.length === 1 ? '1 match live now' : `${live.length} matches live now`}
            </p>
          ) : null}
          {/* Paper cannot say when it stopped being true, so it says so. */}
          <p className="hidden text-meta print:mt-3 print:block">
            Printed from the live page. Scores change during the day — the screen is always right.
          </p>
        </div>
        <NetRule className="absolute inset-x-0 bottom-0" />
      </header>

      <main id="main" className="mx-auto w-full max-w-5xl px-4 pt-6 xl:max-w-6xl">
        {/*
          Two columns from `lg`. The sidebar holds the two things a reader keeps
          coming back to — who they are playing and who is next — and the main
          column holds the long stuff. The sidebar's second row is sticky
          because it is short and its neighbour is three thousand pixels of
          tables: without it, two thirds of a 1280px page is a column of
          nothing beside the standings.
        */}
        <div className="page-grid flex flex-col gap-8 lg:grid lg:grid-cols-[minmax(0,1fr)_20rem] lg:items-start lg:gap-x-8 xl:grid-cols-[minmax(0,1fr)_22rem]">
          {/* 1 — the answer to the only question most people came with. It is a
              name picker and a remembered id: on paper it is a blank box. */}
          <div className="lg:col-start-2 lg:row-start-1 print:hidden">
            <FindMyMatch
              players={roster.map((p) => ({ id: p.id, name: p.name, teamIds: p.teamIds }))}
              courtsInPlay={data.courtsInPlay}
              tableFor={tableFor}
              matches={data.matches.map((m, i) => ({
                id: m.id,
                teamAId: m.teamAId,
                teamBId: m.teamBId,
                nameA: m.nameA,
                nameB: m.nameB,
                courtName: m.courtName,
                status: m.status,
                state: m.state,
                categoryName: m.categoryName,
                roundName: m.roundName,
                queuePosition: i,
                scoreLine: m.scoreLine,
                winnerSide: m.winnerSide,
                resultType: m.resultType,
              }))}
            />
          </div>

          {/* 2 — what is happening right now, and the two states where nothing is. */}
          <section className="lg:col-start-1 lg:row-start-1" aria-labelledby="oncourt">
            <div>
              <h2 id="oncourt" className="flex items-center gap-2.5 text-section text-text">
                {live.length ? (
                  <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-live" />
                ) : null}
                On court now
              </h2>
              <div aria-hidden className="mt-1.5 h-[3px] w-10 rounded-full bg-accent-line" />
              {live.length ? (
                <p className="mt-1.5 text-meta text-text-3 print:hidden">
                  <span className="font-semibold text-live-text">Live</span> — this page updates by
                  itself
                </p>
              ) : null}
            </div>

            <div className="mt-4 flex flex-col gap-3">
              {live.length ? (
                live.map((m) => (
                  <article
                    key={m.id}
                    className="overflow-hidden rounded-card border border-line-strong bg-paper shadow-card"
                  >
                    <div aria-hidden className="h-1 bg-live" />
                    <div className="flex items-center gap-2 px-4 pt-3">
                      {m.courtColor ? <CourtSwatch colorKey={m.courtColor} /> : null}
                      <span className="font-score text-eyebrow text-text uppercase">
                        {m.courtName ?? 'On court'}
                      </span>
                      <span className="ml-auto truncate text-meta text-text-3">
                        {m.categoryName}
                      </span>
                    </div>
                    <div className="px-4 pt-2.5 pb-3">
                      <TeamName name={m.nameA} players={m.playersA} size="section" />
                      {/* Two names above two names is four entries at a glance.
                          The net rule with its post at one third, and a "v"
                          standing in the gap, is the one mark that says these
                          are two sides of one match. */}
                      <div className="my-2.5 flex items-center gap-2.5">
                        <span aria-hidden className="h-[3px] shrink-0 basis-[28%] bg-accent-line" />
                        <span className="font-score text-[17px] leading-none font-bold text-text-2">
                          v
                        </span>
                        <span aria-hidden className="h-[3px] flex-1 bg-accent-line" />
                      </div>
                      <TeamName name={m.nameB} players={m.playersB} size="section" />
                    </div>
                    {/* Explicitly off: the number reticks every 30 seconds and
                        is worth nothing spoken. Saying so here also stops it
                        being swallowed by a live region added above it later. */}
                    <p
                      aria-live="off"
                      className="num border-t border-line bg-sunken px-4 py-2 text-meta text-text-2"
                    >
                      {m.startedAt ? (
                        <Elapsed
                          startedAt={m.startedAt.getTime()}
                          serverMinutes={minutesBetween(m.startedAt, new Date())}
                        />
                      ) : (
                        'Just gone on'
                      )}
                    </p>
                  </article>
                ))
              ) : finished ? (
                <EmptyState title="That's the day" tone="accent">
                  <p>Every match has been played. Final tables below.</p>
                </EmptyState>
              ) : started ? (
                <EmptyState title="No match on court">
                  <p>The next pair is being called. {toPlay.length} still to play.</p>
                </EmptyState>
              ) : (
                <EmptyState title="Nothing has started yet" tone="accent">
                  <p>
                    {data.matches.length} matches across{' '}
                    {data.categories.length === 1
                      ? '1 category'
                      : `${data.categories.length} categories`}
                    .{' '}
                    {upNext.length
                      ? 'The first pairs are listed just below.'
                      : 'The order of play goes up when the organiser opens the courts.'}
                  </p>
                </EmptyState>
              )}
            </div>
          </section>

          {/* 3 — the queue. */}
          <section className="page-sticky flex flex-col gap-4 lg:sticky lg:top-6 lg:col-start-2 lg:row-start-2">
            <SectionHead
              title={started ? 'Up next' : 'First up'}
              meta={upNext.length ? "in the order they'll be called" : undefined}
            />
            {upNext.length ? (
              <Panel>
                <ul className="divide-y divide-line">
                  {upNext.map((m, i) => (
                    <li key={m.id}>
                      <MatchRow
                        nameA={m.nameA}
                        nameB={m.nameB}
                        gamesWonA={0}
                        gamesWonB={0}
                        winnerSide={null}
                        hasScore={false}
                        state={i === 0 ? 'ready' : 'waiting'}
                        stateLabel={i === 0 ? 'Next' : ordinal(i)}
                        sub={`${m.categoryName}${m.roundName ? ` · ${m.roundName}` : ''}`}
                      />
                    </li>
                  ))}
                </ul>
                {toPlay.length > upNext.length ? (
                  <p className="border-t border-line bg-sunken px-4 py-2.5 text-meta text-text-2">
                    and {toPlay.length - upNext.length} more after these
                  </p>
                ) : null}
              </Panel>
            ) : (
              <EmptyState title="Nothing waiting">
                <p>
                  {finished
                    ? 'Every match has been played.'
                    : started
                      ? 'Every match that can start is on a court.'
                      : 'The order of play appears here once the organiser opens the courts.'}
                </p>
              </EmptyState>
            )}
          </section>

          {/* 4 — tables, results, and the small print. */}
          <div className="flex flex-col gap-8 lg:col-start-1 lg:row-start-2">
            {underReview.length ? (
              <section className="flex flex-col gap-3">
                <Notice tone="alert">
                  {underReview.length === 1
                    ? 'One result is under review.'
                    : `${underReview.length} results are under review.`}{' '}
                  The two sides entered different scores. An organiser is sorting it out, and the
                  score stays off this page until they have.
                </Notice>
                <Panel>
                  <ul className="divide-y divide-line">
                    {underReview.map((m) => (
                      <li key={m.id}>
                        <MatchRow
                          nameA={m.nameA}
                          nameB={m.nameB}
                          gamesWonA={0}
                          gamesWonB={0}
                          winnerSide={null}
                          hasScore={false}
                          state="alert"
                          stateLabel="Review"
                          sub={`${m.categoryName}${m.roundName ? ` · ${m.roundName}` : ''}`}
                        />
                      </li>
                    ))}
                  </ul>
                </Panel>
              </section>
            ) : null}

            {finished ? <DayFinished tables={tables} categories={data.categories} /> : null}

            <Tables tables={tables} />

            {results.length ? (
              <Results
                results={results.map((m) => ({
                  id: m.id,
                  categoryName: m.categoryName,
                  roundName: m.roundName,
                  nameA: m.nameA,
                  nameB: m.nameB,
                  gamesWonA: m.gamesWonA,
                  gamesWonB: m.gamesWonB,
                  winnerSide: m.winnerSide,
                  scoreLine: m.scoreLine,
                  provisional: m.provisional,
                  startedAt: m.startedAt,
                  endedAt: m.endedAt,
                  resultType: m.resultType,
                }))}
                categoryOrder={data.categories.map((c) => c.name)}
              />
            ) : (
              <section className="flex flex-col gap-4">
                <SectionHead title="Results" />
                <EmptyState title="No results yet">
                  <p>Scores appear here within seconds of a pair entering them on court.</p>
                </EmptyState>
              </section>
            )}

            <Disclosure
              summary="Everyone playing today"
              meta={`${roster.length} players · ${data.teamName.size} pairs`}
            >
              <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
                <ul className="columns-2 gap-4 sm:columns-3 lg:columns-4">
                  {roster.map((p) => (
                    <li key={p.id} className="break-inside-avoid py-1 text-body text-text">
                      {p.name}
                    </li>
                  ))}
                </ul>
              </div>
            </Disclosure>

            <div className="border-t border-line pt-4 print:hidden">
              <p className="text-meta text-text-3">
                This page updates itself — leave it open. Scores go final ten minutes after they are
                entered, unless someone disputes them.
              </p>
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}

/**
 * The end state. Most visits to a tournament page happen after it is over, and
 * "no matches waiting" is not what someone opening it that evening came for.
 */
function DayFinished({
  tables,
  categories,
}: {
  tables: CategoryTable[]
  categories: Array<{ id: string; name: string; winnerTeamId: string | null }>
}) {
  const rows = tables
    .map((t) => {
      const top = t.rows[0]
      if (!top) return null
      const declared = categories.find((c) => c.id === t.id)?.winnerTeamId
      return { table: t, top, won: declared === top.teamId }
    })
    .filter((r): r is { table: CategoryTable; top: CategoryTable['rows'][number]; won: boolean } =>
      Boolean(r),
    )

  if (!rows.length) return null

  return (
    <section className="flex flex-col gap-4">
      <SectionHead title="How it finished" meta="the day is done" />
      <Panel>
        <ul className="divide-y divide-line">
          {rows.map(({ table, top, won }) => (
            <li key={table.id} className="flex items-center gap-3 px-4 py-3.5">
              <span className="min-w-0 flex-1">
                <span className="block text-meta text-text-3">{table.name}</span>
                <TeamName name={top.name} players={top.players} />
              </span>
              <Tag tone="accent">{won ? 'Winner' : 'Top of the table'}</Tag>
            </li>
          ))}
        </ul>
      </Panel>
    </section>
  )
}
