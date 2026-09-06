import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { useParams } from 'react-router'
import type { Output } from '@/api/contract'
import { useRpc } from '@/api/use-rpc'
import { useVersionPoll } from '@/api/use-version'
import { Card, Notice, Tag, TeamName } from '@/components/ui'
import { venueDate, venueTime } from '@/lib/time'
import { courtsLabel, cutWords, poolTables } from '@/lib/words'
import { PublicLoading, useTitle } from '@/lib/page'
import { CourtCard, Eyebrow, Masthead } from './court-card'
import { NotFound } from './not-found'

type PublicMatch = Output<'public.publicTournament'>['matches'][number]

const endedAt = (m: PublicMatch) => new Date(m.endedAt ?? m.startedAt ?? 0).getTime()

/**
 * The share link. Read-only, no login, updates on its own.
 *
 * Courts first — because "where do I go" is the question — then the order of
 * play, the table, and what has been played. When it is over, the winners sit
 * at the top and the page becomes the record.
 *
 * No cookies are read anywhere in this tree.
 */
export function PublicTournamentPage() {
  const { slug = '' } = useParams()
  const loaded = useRpc('public.publicTournament', { slug })
  const data = loaded.state === 'ready' ? loaded.data : null

  useTitle(data ? `${data.tournament.name} · Madras Pickleball` : 'Madras Pickleball')

  const t = data?.tournament
  const phase = !t ? 'setup' : t.status === 'completed' ? 'finished' : t.status === 'live' ? 'running' : 'setup'
  const courtOrder = new Map((data?.courts ?? []).map((c, i) => [c.id, i]))
  const live = (data?.matches ?? [])
    .filter((m) => m.status === 'live')
    .sort((a, b) => (courtOrder.get(a.courtId ?? '') ?? 99) - (courtOrder.get(b.courtId ?? '') ?? 99))

  // 5s while anything is on court, 30s when nothing is, never once it is over.
  useVersionPoll(
    `t/${slug}`,
    data?.version,
    live.length ? 'live' : phase === 'finished' ? 'off' : 'idle',
    () => void loaded.reload(true),
  )

  if (loaded.state === 'loading') return <PublicLoading />
  if (!data || !t) return <NotFound message={loaded.state === 'missing' ? undefined : loaded.error} />

  const { table, cut } = data
  const unit = data.discipline === 'doubles' ? 'Pair' : 'Player'
  // Eight pairs or more are drawn into pools, and `cut` go through from EACH
  // pool — so there is a table, and a cut line, per pool. A league comes back
  // as one unnamed table and renders as it always did.
  const pools = poolTables(table)
  // A pair who pulled out keeps its row for the record but takes no place in
  // the knockout — the draw is built without them, so the cut line has to be
  // drawn without them too, or the page promises a final to a pair who have
  // gone home.
  const goesThrough = new Set<string>()
  const lastThrough = new Set<string>()
  for (const pool of pools) {
    const through = pool.rows.filter((r) => !r.withdrawn).slice(0, cut)
    for (const r of through) goesThrough.add(r.teamId)
    const last = through[through.length - 1]
    if (last) lastThrough.add(last.teamId)
  }
  const signupsOpen = t.status === 'setup' && !t.registrationClosedAt

  const playedCount = data.matches.filter((m) => m.state === 'final').length
  // A bye is a row in the ledger, not something anybody scrolls a list to read.
  const played = data.matches
    .filter((m) => m.state === 'final' && m.resultType !== 'bye')
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
      ? `${venueDate(t.day)} · finished ${venueTime(t.updatedAt)}`
      : phase === 'running'
        ? `${venueDate(t.day)} · ${playedCount} of ${data.matches.length} played · ${courtsLabel(
            data.courts.map((c) => c.name),
          )}`
        : signupsOpen
          ? `${venueDate(t.day)} · Sign-ups open · ${data.players.length} ${
              data.players.length === 1 ? 'player' : 'players'
            }`
          : `Starts ${venueDate(t.day)} · ${data.players.length} ${
              data.players.length === 1 ? 'player' : 'players'
            }`

  return (
    <div className="min-h-dvh bg-ground pb-16">
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
          <Notice tone="waiting" title="Paused">
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
            {pools.map((pool) => (
              <div key={pool.name ?? 'league'} className="flex flex-col gap-2">
                {/* Only a pooled draw is named: one league is just "the table". */}
                {pool.name ? (
                  <h3 className="font-score text-eyebrow text-text-2 uppercase">{pool.name}</h3>
                ) : null}
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
                      {pool.rows.map((r, i) => {
                        const through = goesThrough.has(r.teamId) && phase !== 'finished'
                        return (
                          <RowWithCut
                            key={r.teamId}
                            through={through}
                            divider={phase !== 'finished' && lastThrough.has(r.teamId)}
                            label={cutWords(cut, pools.length)}
                          >
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
                              ) : r.note ? (
                                <span className="block text-meta font-normal text-text-3">{r.note}</span>
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
              </div>
            ))}
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
                          {m.resultType === 'retired' ? ' · retired' : ''}
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
          <p className="text-meta text-text-3">
            Nothing played yet. Results land here the moment they are entered.
          </p>
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
  through,
  divider,
  label,
  children,
}: {
  through: boolean
  /** The cut line sits under this row. */
  divider: boolean
  /** What the cut line says — "Top 2 play the final", "Top 2 go through". */
  label: string
  children: ReactNode
}) {
  return (
    <>
      <tr className={clsx('border-t border-line', through && 'bg-accent-soft/60')}>{children}</tr>
      {divider ? (
        <tr>
          <td
            colSpan={4}
            className="border-t border-dashed border-line-key py-1.5 text-center font-score text-eyebrow text-accent uppercase"
          >
            {label}
          </td>
        </tr>
      ) : null}
    </>
  )
}
