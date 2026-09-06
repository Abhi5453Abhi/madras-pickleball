import { clsx } from 'clsx'
import { notFound } from 'next/navigation'
import { Card, Notice, Tag, TeamName } from '@/components/ui'
import { venueDate, venueTime } from '@/lib/time'
import { publicTournament, type PublicMatch } from '@/server/public'
import { ensureReady } from '@/server/bootstrap'
import { CourtCard, Eyebrow, Masthead, courtsLabel } from '../court-card'
import { LiveRefresh } from './live-refresh'

/**
 * The share link. Read-only, no login, updates on its own.
 *
 * Courts first — because "where do I go" is the question — then the order of
 * play, the table, and what has been played. When it is over, the winners sit
 * at the top and the page becomes the record.
 *
 * No cookies are read anywhere in this tree, so the CDN keeps caching it.
 */
export const dynamic = 'force-dynamic'

/**
 * WhatsApp is the distribution channel, so the link preview is the front door
 * for most of the venue. Built from data already fetched — nothing else loads.
 */
export async function generateMetadata(props: PageProps<'/t/[slug]'>) {
  const { slug } = await props.params
  const data = await publicTournament(slug)
  const title = data ? `${data.tournament.name} · Madras Pickleball` : 'Madras Pickleball'
  const description = data
    ? `${venueDate(data.tournament.startDate)} — who is on court, the table and every result.`
    : 'Live scores, the order of play and results.'
  return { title, description, openGraph: { title, description, type: 'website' } }
}

const endedAt = (m: PublicMatch) => (m.endedAt ?? m.startedAt)?.getTime() ?? 0

export default async function PublicTournament(props: PageProps<'/t/[slug]'>) {
  await ensureReady()
  const { slug } = await props.params
  const data = await publicTournament(slug)
  if (!data) notFound()
  const { tournament: t, table, cut } = data

  const phase = t.status === 'completed' ? 'finished' : t.status === 'live' ? 'running' : 'setup'
  const unit = data.discipline === 'doubles' ? 'Pair' : 'Player'
  const signupsOpen = t.status === 'registration' && !t.registrationClosedAt

  const courtOrder = new Map(data.courts.map((c, i) => [c.id, i]))
  const live = data.matches
    .filter((m) => m.status === 'live')
    .sort((a, b) => (courtOrder.get(a.courtId ?? '') ?? 99) - (courtOrder.get(b.courtId ?? '') ?? 99))
  const playedCount = data.matches.filter((m) => m.state === 'final' || m.state === 'reported').length
  // A bye is a row in the ledger, not something anybody scrolls a list to read.
  const played = data.matches
    .filter((m) => (m.state === 'final' || m.state === 'reported') && m.resultType !== 'bye')
    .sort((a, b) => endedAt(b) - endedAt(a))
  // The next two in the order of play with both sides known. A pair on court
  // right now can be next again — that is what the order says, and the free
  // court simply waits for them.
  const upNext = data.matches
    .filter((m) => m.state === 'none' && m.status === 'ready' && m.teamAId && m.teamBId)
    .slice(0, 2)

  // The final: the last knockout match in play order that has a winner. With
  // no finals stage, the top of the table once everything is played.
  const finalMatch = [...data.matches].reverse().find((m) => m.stage === 'knockout' && m.winnerSide)
  const winner = finalMatch
    ? finalMatch.winnerSide === 'A'
      ? { name: finalMatch.nameA, players: finalMatch.playersA }
      : { name: finalMatch.nameB, players: finalMatch.playersB }
    : phase === 'finished' && data.finalsStage === 'none' && table[0]
      ? { name: table[0].name, players: table[0].players }
      : null
  const runnerUp = finalMatch ? (finalMatch.winnerSide === 'A' ? finalMatch.nameB : finalMatch.nameA) : null

  const sub =
    phase === 'finished'
      ? `${venueDate(t.startDate)} · finished ${venueTime(t.updatedAt)}`
      : phase === 'running'
        ? `${venueDate(t.startDate)} · ${playedCount} of ${data.matches.length} played · ${courtsLabel(
            data.courts.map((c) => c.name),
          )}`
        : signupsOpen
          ? `${venueDate(t.startDate)} · Sign-ups open · ${data.players.length} ${
              data.players.length === 1 ? 'player' : 'players'
            }`
          : `Starts ${venueDate(t.startDate)} · ${data.players.length} ${
              data.players.length === 1 ? 'player' : 'players'
            }`

  return (
    <div className="min-h-dvh bg-ground pb-16">
      <LiveRefresh
        endpoint={`/api/public/t/${slug}/version`}
        version={data.streamVersion}
        mode={live.length ? 'live' : phase === 'finished' ? 'off' : 'idle'}
      />

      {/* The page rewrites itself every few seconds and said nothing while it
          did. This is the one sentence that changes when anything material
          does; an identical re-render announces nothing. */}
      <p role="status" className="sr-only">
        {live.length === 0
          ? 'No match on court.'
          : live.length === 1
            ? '1 match on court.'
            : `${live.length} matches on court.`}{' '}
        {playedCount} of {data.matches.length} played.
      </p>

      <Masthead title={t.name} sub={sub} />

      <main className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-5">
        {/* Everybody's phone says this, so nobody is staring at a board that
            has not moved for twenty minutes wondering why. */}
        {t.pauseNote ? (
          <Notice tone="waiting" title="The day is stopped">
            {t.pauseNote}
          </Notice>
        ) : null}

        {phase === 'setup' ? (
          <section className="flex flex-col gap-3">
            <Eyebrow count={data.players.length || undefined}>Players</Eyebrow>
            {data.players.length ? (
              <Card>
                <ul className="grid grid-cols-2 divide-y divide-line sm:grid-cols-3">
                  {data.players.map((p, i) => (
                    <li key={`${p}-${i}`} className="flex min-h-[48px] items-center px-4 text-row text-text">
                      <span className="truncate">{p}</span>
                    </li>
                  ))}
                </ul>
              </Card>
            ) : (
              <p className="text-body text-text-2">Nobody has signed up yet.</p>
            )}
          </section>
        ) : null}

        {phase === 'finished' && winner ? (
          <div className="rounded-card border-2 border-ink bg-paper p-5 text-center shadow-card">
            <p className="font-score text-eyebrow text-accent uppercase">
              {data.discipline === 'doubles' ? 'Winners' : 'Winner'}
            </p>
            <div className="mt-2 flex justify-center">
              <TeamName name={winner.name} players={winner.players} size="section" className="text-center" />
            </div>
            {runnerUp ? (
              <p className="mt-2 text-body text-text-2">
                beat {runnerUp} in the {finalMatch?.roundName?.toLowerCase() ?? 'final'}
              </p>
            ) : null}
            {finalMatch?.scoreLine ? (
              <p className="num mt-1 text-row text-text">{finalMatch.scoreLine}</p>
            ) : null}
          </div>
        ) : null}

        {live.length ? (
          <section className="flex flex-col gap-3">
            <Eyebrow live>On court now</Eyebrow>
            <div className="flex flex-col gap-2">
              {live.map((m) => (
                <CourtCard
                  key={m.id}
                  name={m.courtName ?? 'On court'}
                  colorKey={m.courtColor ?? 'blue'}
                  label={m.roundName ?? ''}
                  live={{ nameA: m.nameA, playersA: m.playersA, nameB: m.nameB, playersB: m.playersB }}
                />
              ))}
            </div>
          </section>
        ) : null}

        {phase === 'running' && upNext.length ? (
          <section className="flex flex-col gap-3">
            <Eyebrow>Up next</Eyebrow>
            <Card>
              <ul className="divide-y divide-line">
                {upNext.map((m, i) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1">
                      <TeamName name={m.nameA} players={m.playersA} />
                      <span className="my-1 flex items-center gap-2">
                        <span aria-hidden className="h-px w-6 bg-line-strong" />
                        <span className="font-score text-[14px] leading-none font-bold text-text-3">v</span>
                        <span className="sr-only">versus</span>
                      </span>
                      <TeamName name={m.nameB} players={m.playersB} />
                      {m.roundName ? (
                        <span className="mt-1 block text-meta text-text-3">{m.roundName}</span>
                      ) : null}
                    </span>
                    <Tag tone={i === 0 ? 'accent' : 'neutral'}>{i === 0 ? 'Next' : 'Then'}</Tag>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        ) : null}

        {phase !== 'setup' && table.length ? (
          <section className="flex flex-col gap-3">
            <Eyebrow>{phase === 'finished' ? 'Final table' : 'Table'}</Eyebrow>
            <Card className="overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="text-left text-meta text-text-3">
                    <th className="w-8 py-2 pl-4 font-semibold" scope="col">
                      <span className="sr-only">Position</span>
                    </th>
                    <th className="py-2 font-semibold" scope="col">
                      {unit}
                    </th>
                    <th className="py-2 pl-3 text-right font-semibold" scope="col">
                      Won
                    </th>
                    <th className="py-2 pr-4 pl-3 text-right font-semibold" scope="col">
                      Points
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {table.map((r, i) => {
                    const through = cut > 0 && i < cut && phase !== 'finished'
                    return (
                      <RowWithCut key={r.teamId} index={i} cut={cut} finished={phase === 'finished'}>
                        <td
                          className={clsx(
                            'num py-2.5 pl-4 text-meta',
                            through ? 'font-bold text-accent' : 'text-text-3',
                          )}
                        >
                          {i + 1}
                        </td>
                        <td className={clsx('py-2.5 text-row', r.withdrawn ? 'text-text-3' : 'text-text')}>
                          {r.name}
                          {r.withdrawn ? (
                            <span className="block text-meta font-normal text-text-3">pulled out</span>
                          ) : null}
                        </td>
                        <td className="num py-2.5 pl-3 text-right text-row text-text">{r.won}</td>
                        <td className="num py-2.5 pr-4 pl-3 text-right text-row text-text">{r.pointsFor}</td>
                      </RowWithCut>
                    )
                  })}
                </tbody>
              </table>
            </Card>
            {phase === 'running' ? (
              <p className="text-meta text-text-3">Level on wins? Most points scored goes through.</p>
            ) : null}
          </section>
        ) : null}

        {played.length ? (
          <section className="flex flex-col gap-3">
            <Eyebrow count={played.length}>Played</Eyebrow>
            <Card>
              <ul className="divide-y divide-line">
                {played.map((m) => {
                  const aWon = m.winnerSide === 'A'
                  const w = aWon ? m.nameA : m.nameB
                  const l = aWon ? m.nameB : m.nameA
                  const walkover = m.resultType === 'walkover'
                  return (
                    <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                      <span className="min-w-0 flex-1">
                        <span className="block text-row font-bold text-text">{w ?? '—'}</span>
                        <span className="block text-meta text-text-3">
                          {walkover ? 'walkover against' : 'beat'} {l ?? '—'}
                          {m.roundName ? ` · ${m.roundName}` : ''}
                        </span>
                      </span>
                      <span className="num shrink-0 text-right">
                        {walkover ? (
                          <span className="block text-meta text-text-3">Walkover</span>
                        ) : (
                          <>
                            <span className="block text-row text-text">
                              {aWon ? m.gamesWonA : m.gamesWonB}–{aWon ? m.gamesWonB : m.gamesWonA}
                            </span>
                            {m.scoreLine ? (
                              <span className="block text-meta text-text-3">{m.scoreLine}</span>
                            ) : null}
                          </>
                        )}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </Card>
          </section>
        ) : phase === 'running' ? (
          <p className="text-meta text-text-3">Nothing played yet. Results land here the moment they are entered.</p>
        ) : null}

        <p className="border-t border-line pt-4 text-meta text-text-3">
          {phase === 'finished'
            ? 'That was the day.'
            : phase === 'setup'
              ? 'Who is on court, the table and every score appear here on the day.'
              : 'This page updates itself — leave it open.'}
        </p>
      </main>
    </div>
  )
}

function RowWithCut({
  index,
  cut,
  finished,
  children,
}: {
  index: number
  cut: number
  finished: boolean
  children: React.ReactNode
}) {
  const through = cut > 0 && index < cut
  return (
    <>
      <tr className={clsx('border-t border-line', through && !finished && 'bg-accent-soft/60')}>{children}</tr>
      {cut > 0 && !finished && index === cut - 1 ? (
        <tr>
          <td
            colSpan={4}
            className="border-t border-dashed border-line-key py-1.5 text-center font-score text-eyebrow text-accent uppercase"
          >
            Top {cut} {cut === 2 ? 'play the final' : 'go through'}
          </td>
        </tr>
      ) : null}
    </>
  )
}
