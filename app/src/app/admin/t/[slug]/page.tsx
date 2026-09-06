import { clsx } from 'clsx'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Panel, SectionHead, StatusPill, statusWords } from '@/components/ui'
import { MatchRow } from '@/components/match-row'
import { venueDate } from '@/lib/time'
import { tiebreakNote } from '@/lib/standings'
import {
  gamesByMatch,
  getTournamentBySlug,
  listCategories,
  listMatches,
  listTournamentPlayers,
  standingsFor,
  teamNameMap,
} from '@/server/tournaments'

export default async function TournamentPage(props: PageProps<'/admin/t/[slug]'>) {
  await requireUser('umpire')
  const { slug } = await props.params

  const tournament = await getTournamentBySlug(slug)
  if (!tournament) notFound()

  const [cats, roster, allMatches, names, scores] = await Promise.all([
    listCategories(tournament.id),
    listTournamentPlayers(tournament.id),
    listMatches(tournament.id),
    teamNameMap(tournament.id),
    gamesByMatch(tournament.id),
  ])
  const tables = await Promise.all(cats.map((c) => standingsFor(c.id)))
  const status = statusWords(tournament.status)

  return (
    <div className="flex flex-col gap-8">
      <header>
        <div className="flex items-center gap-2">
          <StatusPill state={status.state}>{status.label}</StatusPill>
        </div>
        <h1 className="mt-2 text-title text-text">{tournament.name}</h1>
        <p className="num mt-1 text-meta text-text-3">
          {venueDate(tournament.startDate)} · {roster.length} players · {allMatches.length} matches
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={`/admin/t/${tournament.slug}/board`}
            className="tap inline-flex items-center rounded-control bg-ink px-4 text-[17px] font-bold text-white"
          >
            Court board
          </Link>
          <Link
            href={`/admin/t/${tournament.slug}/results`}
            className="tap inline-flex items-center rounded-control border border-line-strong bg-paper px-4 text-[17px] font-semibold text-text"
          >
            Results
          </Link>
          <Link
            href={`/admin/t/${tournament.slug}/cards`}
            className="tap inline-flex items-center rounded-control border border-line-strong bg-paper px-4 text-[17px] font-semibold text-text"
          >
            Court cards
          </Link>
          <Link
            href={`/t/${tournament.slug}`}
            className="tap inline-flex items-center rounded-control border border-line-strong bg-paper px-4 text-[17px] font-semibold text-text"
          >
            Public page
          </Link>
        </div>
      </header>

      {cats.map((category, i) => {
        const table = tables[i]
        const catMatches = allMatches.filter((m) => m.categoryId === category.id)
        const rounds = [...new Set(catMatches.map((m) => m.roundName ?? ''))]
        const qualify = category.finalsStage === 'none' ? 0 : category.advancePerGroup

        return (
          <section key={category.id} className="flex flex-col gap-4">
            <SectionHead
              title={category.name}
              meta={`${table.rows.length} teams · ${catMatches.length} matches`}
            />

            <Panel>
              <div className="font-score grid grid-cols-[22px_1fr_30px_30px_38px] items-center gap-2 bg-sunken px-4 py-2.5 text-eyebrow text-text-2 uppercase">
                <span className="text-right">#</span>
                <span>Team</span>
                <span className="text-right">Pld</span>
                <span className="text-right">Won</span>
                <span className="text-right">Pts</span>
              </div>
              <ul className="divide-y divide-line">
                {table.rows.map((row, idx) => (
                  <li
                    key={row.teamId}
                    className={clsx(
                      'relative grid min-h-[60px] grid-cols-[22px_1fr_30px_30px_38px] items-center gap-2 px-4 py-3',
                      idx < qualify &&
                        'before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-accent-line',
                    )}
                  >
                    <span className="num text-right text-[20px] font-bold text-text">
                      {idx + 1}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-row text-text">
                        {names.get(row.teamId) ?? '—'}
                      </span>
                      {row.provisional ? (
                        <span className="block text-meta text-waiting">
                          Provisional — a result is still to be confirmed
                        </span>
                      ) : row.reason && row.played > 0 ? (
                        <span className="block truncate text-meta text-text-3">{row.reason}</span>
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
                {tiebreakNote(table.rule)}
              </p>
            </Panel>

            <Panel>
              {rounds.map((roundName, ri) => (
                <div key={roundName}>
                  <div
                    className={clsx(
                      'font-score bg-sunken px-4 py-2 text-eyebrow text-text-2 uppercase',
                      ri > 0 && 'border-t border-line-strong',
                    )}
                  >
                    {roundName}
                  </div>
                  <ul className="divide-y divide-line">
                    {catMatches
                      .filter((m) => (m.roundName ?? '') === roundName)
                      .map((m) => {
                        const hasScore =
                          m.resultState === 'final' || m.resultState === 'reported'
                        const gs = scores.get(m.id) ?? []
                        return (
                          <li key={m.id}>
                            <MatchRow
                              nameA={m.teamAId ? (names.get(m.teamAId) ?? null) : null}
                              nameB={m.teamBId ? (names.get(m.teamBId) ?? null) : null}
                              gamesWonA={m.gamesWonA}
                              gamesWonB={m.gamesWonB}
                              winnerSide={
                                m.winnerTeamId === m.teamAId
                                  ? 'A'
                                  : m.winnerTeamId === m.teamBId
                                    ? 'B'
                                    : null
                              }
                              hasScore={hasScore}
                              state={
                                m.status === 'live'
                                  ? 'live'
                                  : m.resultState === 'disputed'
                                    ? 'alert'
                                    : hasScore
                                      ? 'done'
                                      : m.status === 'ready'
                                        ? 'ready'
                                        : 'waiting'
                              }
                              stateLabel={m.status === 'ready' ? 'Ready' : 'Waiting'}
                              meta={
                                gs.length
                                  ? gs.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ')
                                  : undefined
                              }
                            />
                          </li>
                        )
                      })}
                  </ul>
                </div>
              ))}
            </Panel>
          </section>
        )
      })}

      <section className="flex flex-col gap-4">
        <SectionHead title="Players" meta={`${roster.length} registered`} />
        <Panel>
          <ul className="grid grid-cols-2 divide-y divide-line">
            {roster.map((p) => (
              <li key={p.id} className="flex min-h-[56px] items-center px-4 text-row text-text">
                <span className="truncate">{p.name}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </section>
    </div>
  )
}
