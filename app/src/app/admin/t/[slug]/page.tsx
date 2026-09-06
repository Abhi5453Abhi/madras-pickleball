import { clsx } from 'clsx'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Card, Chevron, Notice, Panel, TeamName } from '@/components/ui'
import { venueDate, venueTime } from '@/lib/time'
import { tieNote } from '@/lib/standings'
import { formatWords, hub, type Step } from '@/server/events'
import { settleTeams } from '@/server/teams'
import { gamesByMatch, getTournamentBySlug, listMatches, standingsFor, teamNameMap } from '@/server/tournaments'
import { PRIMARY_LINK, SECONDARY_LINK } from '../../_ui'
import { finishEventAction, startEventAction } from './hub-actions'

/**
 * One tournament's own page — SPEC v4.
 *
 * Before it starts: a checklist of the four steps to the start line, in order,
 * each one tappable. Once it starts: the day — a button to the live board, the
 * table, what has been played. When it is over: the winner on top, the final
 * table, and the page becomes the record.
 */
export async function generateMetadata(props: PageProps<'/admin/t/[slug]'>) {
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  return {
    title: tournament ? `${tournament.name} · Madras Pickleball` : 'Tournament · Madras Pickleball',
  }
}

export const dynamic = 'force-dynamic'

export default async function TournamentHub(props: PageProps<'/admin/t/[slug]'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const { err, courts: courtsErr } = await props.searchParams

  // Mutual pairs are made on the way in, as the Teams and Schedule screens do,
  // so the Teams step does not say "0 of 4 pairs made · 8 still to pair" for
  // a list where two pairs have already named each other.
  const found = await getTournamentBySlug(slug)
  if (!found) notFound()
  if (found.status === 'draft' || found.status === 'registration') await settleTeams(found.id)
  const h = await hub(slug)
  if (!h) notFound()
  const { tournament: t, category } = h
  const base = `/admin/t/${slug}`

  const sub =
    h.phase === 'setup'
      ? `${venueDate(t.startDate)} · ${category.discipline} · ${formatWords(category.finalsStage)}`
      : h.phase === 'running'
        ? `${venueDate(t.startDate)} · ${h.matchesPlayed} of ${h.matchesTotal} played · ${
            h.courts.length ? h.courts.map((c) => c.name).join(', ') : 'no courts'
          }`
        : `${venueDate(t.startDate)} · finished ${venueTime(t.updatedAt)}`

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/admin"
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          Tournaments
        </Link>
        <div className="mt-1 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="text-title text-text">{t.name}</h1>
            <p className="num mt-1 text-meta text-text-3">{sub}</p>
          </div>
          <Link
            href={`/t/${slug}`}
            className="tap -mr-1 inline-flex shrink-0 items-center gap-1 px-2 text-[16px] font-bold text-link"
          >
            Share <span aria-hidden>↗</span>
          </Link>
        </div>
      </header>

      {err ? (
        <Notice tone="alert" title="Not done">
          {String(err)}
        </Notice>
      ) : null}
      {courtsErr ? (
        <Notice
          tone="waiting"
          title="Made, but without its courts"
          action={
            <Link href={`${base}/schedule` as never} className={`${SECONDARY_LINK} w-full`}>
              Pick the courts
            </Link>
          }
        >
          {String(courtsErr)}
        </Notice>
      ) : null}

      {h.phase === 'setup' ? (
        <SetupChecklist
          steps={h.steps}
          slug={slug}
          canStart={h.steps.every((s) => s.key === 'start' || s.state === 'done')}
        />
      ) : (
        <Running
          slug={slug}
          base={base}
          phase={h.phase}
          tournamentId={t.id}
          categoryId={category.id}
          discipline={category.discipline}
          finalsStage={category.finalsStage}
          advance={category.advancePerGroup}
          totalMatches={h.matchesTotal}
        />
      )}

      <Link href={`${base}/more` as never} className="tap flex items-center justify-center px-3 text-[16px] font-semibold text-link">
        More · players, courts, fixes, delete
      </Link>
    </div>
  )
}

// ───────────────────────────── setup ─────────────────────────────

function SetupChecklist({
  steps,
  slug,
  canStart,
}: {
  steps: Step[]
  slug: string
  canStart: boolean
}) {
  return (
    <Card>
      <ol className="divide-y divide-line">
        {steps.map((s, i) => {
          const isStart = s.key === 'start'
          const inner = (
            <>
              <span
                aria-hidden
                className={clsx(
                  'font-score grid size-8 shrink-0 place-items-center rounded-full text-[15px] font-bold',
                  s.state === 'done'
                    ? 'bg-live-soft text-live-text'
                    : s.state === 'current'
                      ? 'bg-ink text-white'
                      : 'border border-line-strong text-text-3',
                )}
              >
                {s.state === 'done' ? '✓' : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={clsx('block text-row', s.state === 'todo' && !isStart ? 'text-text-2' : 'text-text')}>
                  {s.title}
                  <span className="sr-only">
                    {s.state === 'done' ? ' — done' : s.state === 'current' ? ' — next' : ''}
                  </span>
                </span>
                <span className="block text-meta text-text-3">{s.detail}</span>
              </span>
              {!isStart ? (
                <span aria-hidden className="text-text-3">
                  <Chevron className="-rotate-90" />
                </span>
              ) : null}
            </>
          )
          if (isStart) {
            return (
              <li key={s.key} className="flex flex-col gap-3 px-4 py-3.5">
                <div className="flex items-center gap-3">{inner}</div>
                {canStart ? (
                  <form action={startEventAction}>
                    <input type="hidden" name="slug" value={slug} />
                    <button className={`${PRIMARY_LINK} w-full`}>Start the tournament</button>
                  </form>
                ) : null}
              </li>
            )
          }
          return (
            <li key={s.key}>
              <Link href={s.href as never} className="tap-lg flex items-center gap-3 px-4 py-2">
                {inner}
              </Link>
            </li>
          )
        })}
      </ol>
    </Card>
  )
}

// ──────────────────────────── running / finished ────────────────────────────

async function Running({
  slug,
  base,
  phase,
  tournamentId,
  categoryId,
  discipline,
  finalsStage,
  advance,
  totalMatches,
}: {
  slug: string
  base: string
  phase: 'running' | 'finished'
  tournamentId: string
  categoryId: string
  discipline: 'singles' | 'doubles'
  finalsStage: string
  advance: number
  totalMatches: number
}) {
  const [table, all, names, scores] = await Promise.all([
    standingsFor(categoryId),
    listMatches(tournamentId),
    teamNameMap(tournamentId),
    gamesByMatch(tournamentId),
  ])

  const unit = discipline === 'doubles' ? 'Pair' : 'Player'
  const cut = finalsStage === 'none' ? 0 : advance
  // A pair who pulled out keeps its row for the record but takes no place in
  // the knockout, so the cut line is drawn around them — as the public page
  // draws it, and as the draw is actually built.
  const withdrawn = new Set(table.teams.filter((x) => x.status === 'withdrawn').map((x) => x.id))
  const goesThrough = new Set(
    table.rows
      .filter((r) => !withdrawn.has(r.teamId))
      .slice(0, finalMatchDecided(all) ? 0 : cut)
      .map((r) => r.teamId),
  )
  const lastThrough = [...goesThrough].pop() ?? null
  const played = all
    .filter((m) => m.resultState === 'final' || m.resultState === 'reported')
    .sort((x, y) => {
      const tx = x.startedAt ? new Date(x.startedAt).getTime() : 0
      const ty = y.startedAt ? new Date(y.startedAt).getTime() : 0
      return ty - tx
    })
  const remaining = all.filter((m) => m.resultState === 'none' && m.status !== 'cancelled').length
  const leagueDone = !all.some(
    (m) => m.stage === 'group' && m.resultState === 'none' && m.status !== 'cancelled',
  )

  // The final: the knockout match with the highest round, once decided.
  const finalMatch = [...all]
    .filter((m) => m.stage === 'knockout' && m.winnerTeamId)
    .sort((a, b) => b.roundIndex - a.roundIndex)[0]
  const leader = table.rows[0]
  const winnerId =
    finalMatch?.winnerTeamId ?? (finalsStage === 'none' && remaining === 0 ? leader?.teamId : null)
  const winnerName = winnerId ? (names.get(winnerId) ?? null) : null
  const runnerUp = finalMatch
    ? names.get(finalMatch.winnerTeamId === finalMatch.teamAId ? (finalMatch.teamBId ?? '') : (finalMatch.teamAId ?? ''))
    : null
  const finalScore = finalMatch
    ? (scores.get(finalMatch.id) ?? [])
        .map((g) => (finalMatch.winnerTeamId === finalMatch.teamAId ? `${g.scoreA}–${g.scoreB}` : `${g.scoreB}–${g.scoreA}`))
        .join(', ')
    : ''

  return (
    <>
      {phase === 'running' ? (
        <Link href="/admin/live" className={PRIMARY_LINK}>
          Live board
        </Link>
      ) : winnerName ? (
        <div className="rounded-card border-2 border-ink bg-paper p-5 text-center shadow-card">
          <p className="font-score text-eyebrow text-accent uppercase">
            {discipline === 'doubles' ? 'Winners' : 'Winner'}
          </p>
          <div className="mt-2 flex justify-center">
            <TeamName name={winnerName} size="section" className="text-center" />
          </div>
          {runnerUp ? (
            <p className="mt-2 text-body text-text-2">
              beat {runnerUp} in the {finalMatch?.roundName?.toLowerCase() ?? 'final'}
            </p>
          ) : null}
          {finalScore ? <p className="num mt-1 text-row text-text">{finalScore}</p> : null}
        </div>
      ) : null}

      {phase === 'running' && remaining === 0 && totalMatches > 0 ? (
        <Notice
          tone="info"
          title="Everything has been played"
          action={
            <form action={finishEventAction}>
              <input type="hidden" name="slug" value={slug} />
              <button className={`${PRIMARY_LINK} w-full`}>Finish the tournament</button>
            </form>
          }
        >
          Finishing puts the winner on top of the public page and frees the courts for whatever is
          next.
        </Notice>
      ) : null}

      {table.rows.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">
            {phase === 'finished' ? 'Final table' : 'Table'}
          </h2>
          <Panel>
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
                {table.rows.map((r, i) => (
                  <RowWithCut
                    key={r.teamId}
                    through={goesThrough.has(r.teamId) && phase !== 'finished'}
                    divider={phase !== 'finished' && r.teamId === lastThrough}
                    cut={cut}
                  >
                    <td className="num py-2.5 pl-4 text-meta text-text-3">{i + 1}</td>
                    <td className={clsx('py-2.5 text-row', withdrawn.has(r.teamId) ? 'text-text-3' : 'text-text')}>
                      {names.get(r.teamId) ?? '—'}
                      {withdrawn.has(r.teamId) ? (
                        <span className="block text-meta font-normal text-text-3">pulled out</span>
                      ) : tieNote(r.reason, leagueDone) ? (
                        <span className="block text-meta font-normal text-text-3">
                          {tieNote(r.reason, leagueDone)}
                        </span>
                      ) : null}
                    </td>
                    <td className="num py-2.5 pl-3 text-right text-row text-text">{r.won}</td>
                    <td className="num py-2.5 pr-4 pl-3 text-right text-row text-text">{r.pointsFor}</td>
                  </RowWithCut>
                ))}
              </tbody>
            </table>
          </Panel>
          {phase === 'running' ? (
            <p className="text-meta text-text-3">Level on wins? Most points scored goes through.</p>
          ) : null}
        </section>
      ) : null}

      {played.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">
            Played <small className="num ml-1 font-normal normal-case text-text-3">{played.length}</small>
          </h2>
          <Panel>
            <ul className="divide-y divide-line">
              {played.slice(0, phase === 'finished' ? 5 : 8).map((m) => {
                const aWon = m.winnerTeamId === m.teamAId
                const w = names.get((aWon ? m.teamAId : m.teamBId) ?? '') ?? '—'
                const l = names.get((aWon ? m.teamBId : m.teamAId) ?? '') ?? '—'
                const gs = scores.get(m.id) ?? []
                const line = gs.map((g) => (aWon ? `${g.scoreA}–${g.scoreB}` : `${g.scoreB}–${g.scoreA}`)).join(', ')
                return (
                  <li key={m.id}>
                    <Link href={`/admin/m/${m.id}`} className="flex items-center gap-3 px-4 py-3">
                      <span className="min-w-0 flex-1">
                        <span className="block text-row text-text">{w}</span>
                        <span className="block text-meta text-text-3">
                          {m.resultType === 'walkover' ? 'walkover over' : 'beat'} {l}
                          {m.roundName ? ` · ${m.roundName}` : ''}
                        </span>
                      </span>
                      <span className="num shrink-0 text-right">
                        {/* A walkover's 11–0, 11–0 is generated for the ledger, not
                            played. The public page and the results list say the
                            word; printing the numbers here read as a thrashing. */}
                        {m.resultType === 'walkover' ? (
                          <span className="block text-meta text-text-3">Walkover</span>
                        ) : (
                          <>
                            <span className="block text-row text-text">
                              {aWon ? m.gamesWonA : m.gamesWonB}–{aWon ? m.gamesWonB : m.gamesWonA}
                            </span>
                            {line ? <span className="block text-meta text-text-3">{line}</span> : null}
                          </>
                        )}
                      </span>
                    </Link>
                  </li>
                )
              })}
            </ul>
          </Panel>
          <Link href={`${base}/results` as never} className={SECONDARY_LINK}>
            All {played.length} result{played.length === 1 ? '' : 's'}
          </Link>
        </section>
      ) : null}
    </>
  )
}

/** Once the final has been played the cut line has done its job. */
function finalMatchDecided(all: Array<{ stage: string; winnerTeamId: string | null }>) {
  return all.some((m) => m.stage === 'knockout' && !!m.winnerTeamId)
}

function RowWithCut({
  through,
  divider,
  cut,
  children,
}: {
  through: boolean
  /** The cut line sits under this row. */
  divider: boolean
  cut: number
  children: React.ReactNode
}) {
  return (
    <>
      <tr className={clsx('border-t border-line', through && 'bg-accent-soft/60')}>{children}</tr>
      {divider ? (
        <tr>
          <td colSpan={4} className="border-t border-dashed border-line-key py-1.5 text-center font-score text-eyebrow text-accent uppercase">
            Top {cut} {cut === 2 ? 'play the final' : 'go through'}
          </td>
        </tr>
      ) : null}
    </>
  )
}
