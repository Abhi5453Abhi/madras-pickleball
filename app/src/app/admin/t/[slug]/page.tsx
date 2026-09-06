import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Card, StatusDot } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { tiebreakNote } from '@/lib/standings'
import {
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

  const [cats, roster, allMatches, names] = await Promise.all([
    listCategories(tournament.id),
    listTournamentPlayers(tournament.id),
    listMatches(tournament.id),
    teamNameMap(tournament.id),
  ])

  const tables = await Promise.all(cats.map((c) => standingsFor(c.id)))

  return (
    <div className="flex flex-col gap-5">
      <header>
        <div className="flex items-center gap-2">
          <StatusDot state={tournament.status === 'live' ? 'live' : tournament.status === 'completed' ? 'done' : 'waiting'} />
          <span className="text-xs font-semibold tracking-wider text-muted uppercase">
            {tournament.status === 'live' ? 'Live' : tournament.status}
          </span>
        </div>
        <h1 className="mt-1 text-2xl font-bold text-ink">{tournament.name}</h1>
        <p className="text-sm text-muted">
          {venueDate(tournament.startDate)} · {roster.length} players · {allMatches.length} matches
        </p>
      </header>

      {cats.map((category, i) => {
        const table = tables[i]
        const catMatches = allMatches.filter((m) => m.categoryId === category.id)
        const rounds = [...new Set(catMatches.map((m) => m.roundName ?? ''))]

        return (
          <section key={category.id} className="flex flex-col gap-3">
            <h2 className="text-lg font-bold text-ink">{category.name}</h2>

            <Card className="p-0">
              <div className="border-b border-line px-4 py-3">
                <h3 className="text-sm font-bold text-ink">Table</h3>
              </div>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-muted">
                    <th className="py-2 pl-4 font-semibold">#</th>
                    <th className="py-2 font-semibold">Team</th>
                    <th className="py-2 text-right font-semibold">P</th>
                    <th className="py-2 text-right font-semibold">W</th>
                    <th className="py-2 pr-4 text-right font-semibold">Pts</th>
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, idx) => (
                    <tr key={row.teamId} className="border-t border-line">
                      <td className="py-2.5 pl-4 text-muted">{idx + 1}</td>
                      <td className="py-2.5 pr-2 font-medium text-ink">
                        {names.get(row.teamId) ?? '—'}
                        {row.provisional ? (
                          <span className="ml-2 text-xs text-muted italic">provisional</span>
                        ) : null}
                      </td>
                      <td className="num py-2.5 text-right text-muted">{row.played}</td>
                      <td className="num py-2.5 text-right font-semibold text-ink">{row.won}</td>
                      <td className="num py-2.5 pr-4 text-right text-muted">{row.pointsFor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="border-t border-line px-4 py-3 text-xs text-muted">
                {tiebreakNote(table.rule)}
              </p>
            </Card>

            {rounds.map((roundName) => (
              <Card key={roundName} className="p-0">
                <div className="border-b border-line px-4 py-3">
                  <h3 className="text-sm font-bold text-ink">{roundName}</h3>
                </div>
                <ul>
                  {catMatches
                    .filter((m) => (m.roundName ?? '') === roundName)
                    .map((m) => (
                      <li
                        key={m.id}
                        className="flex items-center gap-3 border-t border-line px-4 py-3 first:border-t-0"
                      >
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-ink">
                            {m.teamAId ? (names.get(m.teamAId) ?? '—') : 'To be decided'}
                          </p>
                          <p className="truncate text-sm font-medium text-ink">
                            {m.teamBId ? (names.get(m.teamBId) ?? '—') : 'To be decided'}
                          </p>
                        </div>
                        <span className="shrink-0 text-xs font-semibold text-muted uppercase">
                          {m.resultState === 'final' || m.resultState === 'reported'
                            ? `${m.gamesWonA}–${m.gamesWonB}`
                            : m.status === 'ready'
                              ? 'Ready'
                              : 'Waiting'}
                        </span>
                      </li>
                    ))}
                </ul>
              </Card>
            ))}
          </section>
        )
      })}

      <Card>
        <h3 className="text-sm font-bold text-ink">Players</h3>
        <p className="mt-2 text-sm text-muted">{roster.map((p) => p.name).join(' · ')}</p>
      </Card>

      <p className="px-1 text-xs text-muted">
        Scoring, the court board and the public page are next. Nothing here is shared publicly yet.
      </p>
    </div>
  )
}
