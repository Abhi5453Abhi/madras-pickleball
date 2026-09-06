import { clsx } from 'clsx'
import { Link, useParams } from 'react-router'
import type { Output } from '@/api/contract'
import { useRpc } from '@/api/use-rpc'
import { Card, Chevron, StatusPill, TeamName } from '@/components/ui'
import { Loading, LoadError, NotFoundCard, useTitle } from '@/lib/page'

type Match = Output<'tournaments.listMatches'>[number]

/**
 * Every match, in play order, grouped by round. The record the hub's "All 16
 * results" button opens. A played match shows its score; one on court says
 * which; the rest say they have not been played yet. Tap any of them to open
 * the score.
 */
export function ResultsPage() {
  const { slug = '' } = useParams()
  const tournament = useRpc('tournaments.getTournamentBySlug', { slug })
  useTitle(
    tournament.state === 'ready' ? `Results · ${tournament.data.name}` : 'Results · Madras Pickleball',
  )

  if (tournament.state === 'loading') return <Loading />
  if (tournament.state === 'missing') return <NotFoundCard />
  if (tournament.state !== 'ready') {
    return <LoadError error={tournament.error} retry={() => void tournament.reload(false)} />
  }
  return <Results slug={slug} tournamentId={tournament.data.id} name={tournament.data.name} />
}

function Results({ slug, tournamentId, name }: { slug: string; tournamentId: string; name: string }) {
  const matches = useRpc('tournaments.listMatches', { tournamentId })
  const teamNames = useRpc('tournaments.teamNameMap', { tournamentId })
  const games = useRpc('tournaments.gamesByMatch', { tournamentId })
  const courts = useRpc('events.myCourts', { tournamentId })

  if (
    matches.state === 'loading' ||
    teamNames.state === 'loading' ||
    games.state === 'loading' ||
    courts.state === 'loading'
  ) {
    return <Loading />
  }
  if (
    matches.state !== 'ready' ||
    teamNames.state !== 'ready' ||
    games.state !== 'ready' ||
    courts.state !== 'ready'
  ) {
    return <LoadError error="That didn’t load." retry={() => void matches.reload(false)} />
  }

  const all = matches.data
  const names = teamNames.data
  const scores = games.data
  const courtName = new Map(courts.data.map((c) => [c.id, c.name]))
  const played = all.filter((m) => m.resultState === 'final').length

  // Grouped by round, in play order.
  const rounds: Array<{ name: string; matches: Match[] }> = []
  for (const m of all) {
    const roundName = m.roundName ?? 'Matches'
    const last = rounds[rounds.length - 1]
    if (last && last.name === roundName) last.matches.push(m)
    else rounds.push({ name: roundName, matches: [m] })
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          to={`/admin/t/${slug}`}
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          {name}
        </Link>
        <h1 className="mt-1 text-title text-text">Results</h1>
        <p className="num mt-1 text-meta text-text-3">
          {all.length ? `${played} of ${all.length} played` : 'no schedule yet'}
        </p>
      </header>

      {all.length === 0 ? (
        <p className="text-body text-text-2">The schedule has not been made yet.</p>
      ) : null}

      {rounds.map((round) => (
        <section key={round.name} className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">{round.name}</h2>
          <Card>
            <ul className="divide-y divide-line">
              {round.matches.map((m) => {
                const nameA = m.teamAId ? (names[m.teamAId] ?? null) : null
                const nameB = m.teamBId ? (names[m.teamBId] ?? null) : null
                const hasScore = m.resultState === 'final'
                const aWon = m.winnerTeamId === m.teamAId
                const gs = scores[m.id] ?? []
                const live = m.status === 'live'
                const inner = (
                  <>
                    <span className="min-w-0 flex-1">
                      <TeamName name={nameA} muted={hasScore && !aWon} />
                      <span aria-hidden className="my-1 block h-px w-8 bg-line-strong" />
                      <TeamName name={nameB} muted={hasScore && aWon} />
                      {m.resultState === 'voided' ? (
                        <span className="mt-1 block text-meta text-text-3">cancelled</span>
                      ) : m.resultType === 'walkover' && hasScore ? (
                        <span className="mt-1 block text-meta text-text-3">walkover</span>
                      ) : null}
                    </span>
                    {hasScore ? (
                      <span className="num shrink-0 text-right">
                        <span className="block text-row text-text">
                          {m.gamesWonA}–{m.gamesWonB}
                        </span>
                        {gs.length > 0 && m.resultType !== 'walkover' ? (
                          <span className="block text-meta text-text-3">
                            {gs.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ')}
                          </span>
                        ) : null}
                      </span>
                    ) : live ? (
                      <StatusPill state="live">
                        {m.courtId ? `on ${courtName.get(m.courtId) ?? 'court'} now` : 'on court now'}
                      </StatusPill>
                    ) : (
                      <span className="shrink-0 text-meta text-text-3">not played yet</span>
                    )}
                  </>
                )
                // Score entry needs both sides. A match still waiting on a
                // semi-final is a row, not a link.
                return (
                  <li key={m.id}>
                    {nameA && nameB && m.resultState !== 'voided' ? (
                      <Link
                        to={`/admin/m/${m.id}`}
                        className={clsx('flex items-center gap-3 px-4 py-3', live && 'bg-live-soft/40')}
                      >
                        {inner}
                      </Link>
                    ) : (
                      <div className="flex items-center gap-3 px-4 py-3">{inner}</div>
                    )}
                  </li>
                )
              })}
            </ul>
          </Card>
        </section>
      ))}
    </div>
  )
}
