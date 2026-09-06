import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Button, NetRule, Panel, SectionHead, StatusPill } from '@/components/ui'
import { getTournamentBySlug, listMatches, teamNameMap } from '@/server/tournaments'
import { confirmAll, markNoShow } from './actions'

/**
 * The clipboard path — SPEC A5. Realistic court-QR adoption is maybe 60%; the
 * rest of the results arrive on paper, and this is where they go in.
 */
export const dynamic = 'force-dynamic'

export default async function ResultsPage(props: PageProps<'/admin/t/[slug]/results'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) notFound()

  const [all, names] = await Promise.all([
    listMatches(tournament.id),
    teamNameMap(tournament.id),
  ])

  const pending = all.filter((m) => m.resultState === 'reported')
  const disputed = all.filter((m) => m.resultState === 'disputed')
  const missing = all.filter(
    (m) => m.resultState === 'none' && m.teamAId && m.teamBId && m.status !== 'pending',
  )

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Results</p>
        <h1 className="mt-1 text-title text-text">{tournament.name}</h1>
      </header>

      {disputed.length ? (
        <section className="flex flex-col gap-3">
          <SectionHead title="Under review" meta="these block the bracket until they're settled" />
          <Panel>
            <ul className="divide-y divide-line">
              {disputed.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-row text-text">{names.get(m.teamAId ?? '') ?? '—'}</p>
                    <p className="text-row text-text">{names.get(m.teamBId ?? '') ?? '—'}</p>
                  </div>
                  <Link href={`/admin/m/${m.id}`}>
                    <Button className="tap px-4 text-[16px]">Settle it</Button>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionHead
          title="Waiting to be confirmed"
          meta={`${pending.length} entered, not yet final`}
          action={
            pending.length ? (
              <form action={confirmAll}>
                <input type="hidden" name="slug" value={slug} />
                <Button className="tap px-4 text-[16px]">Confirm all</Button>
              </form>
            ) : undefined
          }
        />
        {pending.length ? (
          <Panel>
            <ul className="divide-y divide-line">
              {pending.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-row text-text">{names.get(m.teamAId ?? '') ?? '—'}</p>
                    <p className="text-row text-text">{names.get(m.teamBId ?? '') ?? '—'}</p>
                  </div>
                  <span className="num text-[22px] font-bold text-text">
                    {m.gamesWonA}–{m.gamesWonB}
                  </span>
                  <StatusPill state="waiting">1 of 2</StatusPill>
                </li>
              ))}
            </ul>
          </Panel>
        ) : (
          <p className="text-body text-text-2">Nothing waiting. Every score is final.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionHead title="No score yet" meta={`${missing.length} still to come in`} />
        <NetRule />
        <Panel>
          <ul className="divide-y divide-line">
            {missing.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-[9rem] flex-1">
                  <p className="text-row text-text">{names.get(m.teamAId ?? '') ?? '—'}</p>
                  <p className="text-row text-text">{names.get(m.teamBId ?? '') ?? '—'}</p>
                  <p className="text-meta text-text-3">{m.roundName}</p>
                </div>
                <div className="ml-auto flex flex-wrap gap-2">
                  <Link href={`/admin/m/${m.id}`}>
                    <Button className="tap px-4 text-[16px]">Enter</Button>
                  </Link>
                  {/* Which side failed to turn up is the whole content of a
                      walkover. Hardcoding one of them handed half the pool
                      matches to the wrong team. */}
                  {(['A', 'B'] as const).map((side) => {
                    const absentName =
                      names.get((side === 'A' ? m.teamAId : m.teamBId) ?? '') ?? '—'
                    return (
                      <form action={markNoShow} key={side}>
                        <input type="hidden" name="matchId" value={m.id} />
                        <input type="hidden" name="absent" value={side} />
                        <input type="hidden" name="slug" value={slug} />
                        <button className="tap max-w-[10rem] truncate rounded-control border border-line-strong bg-paper px-3 text-[15px] font-semibold text-text-2">
                          {absentName} didn’t come
                        </button>
                      </form>
                    )
                  })}
                </div>
              </li>
            ))}
            {missing.length === 0 ? (
              <li className="px-4 py-6 text-center text-body text-text-2">
                Everything that could be played has a score.
              </li>
            ) : null}
          </ul>
        </Panel>
      </section>
    </div>
  )
}
