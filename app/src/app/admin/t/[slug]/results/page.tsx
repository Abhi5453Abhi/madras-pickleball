import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { EmptyState, Panel, SectionHead, StatusPill, Tag, TeamName } from '@/components/ui'
import {
  getTournamentBySlug,
  listCategories,
  listMatches,
  teamNameMap,
} from '@/server/tournaments'
import { Confirm, ROW_BUTTON, SECONDARY_LINK } from '../../../_ui'
import { confirmAll, markNoShow } from './actions'

/**
 * The clipboard path — SPEC A5. Realistic court-QR adoption is maybe 60%; the
 * rest of the results arrive on paper, and this is where they go in.
 *
 * Three lists in the order they cost the organiser something: a disagreement
 * blocks the bracket, a provisional score settles itself, and a missing score
 * is the one that needs someone to walk over and ask.
 */
export const dynamic = 'force-dynamic'

export default async function ResultsPage(props: PageProps<'/admin/t/[slug]/results'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) notFound()

  const [all, names, cats] = await Promise.all([
    listMatches(tournament.id),
    teamNameMap(tournament.id),
    listCategories(tournament.id),
  ])
  const catName = new Map(cats.map((c) => [c.id, c.name]))

  const pending = all.filter((m) => m.resultState === 'reported')
  const disputed = all.filter((m) => m.resultState === 'disputed')
  const missing = all.filter(
    (m) => m.resultState === 'none' && m.teamAId && m.teamBId && m.status !== 'pending',
  )
  // A live match can be scored from here too, but it is the one row where the
  // organiser should look up at the court before touching anything.
  const ordered = [...missing].sort(
    (a, b) => Number(b.status === 'live') - Number(a.status === 'live'),
  )

  const where = (m: (typeof all)[number]) =>
    [catName.get(m.categoryId), m.roundName].filter(Boolean).join(' · ')

  return (
    <div className="flex flex-col gap-7">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Results desk</p>
        <h1 className="mt-1">
          <Link href={`/admin/t/${slug}`} className="text-title text-text">
            {tournament.name}
            <span aria-hidden className="text-text-3"> ›</span>
          </Link>
        </h1>
        <p className="num mt-1.5 text-meta text-text-3">
          {disputed.length} under review · {pending.length} not confirmed · {missing.length} with no
          score
        </p>
      </header>

      {disputed.length ? (
        <section className="flex flex-col gap-3">
          <SectionHead
            title="Under review"
            meta="Two sides gave different scores. These block the bracket until they're settled."
          />
          <Panel>
            <ul className="divide-y divide-line">
              {disputed.map((m) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-[9rem] flex-1">
                    <p className="text-meta text-text-3">{where(m)}</p>
                    <TeamName name={names.get(m.teamAId ?? '') ?? null} />
                    <TeamName name={names.get(m.teamBId ?? '') ?? null} />
                  </div>
                  <Link href={`/admin/m/${m.id}`} className={`${ROW_BUTTON} ml-auto shrink-0`}>
                    Settle it
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
          meta={
            pending.length
              ? `${pending.length} entered — each settles on its own ten minutes after it went in`
              : 'Every score that is in is final'
          }
        />
        {pending.length ? (
          <>
            <Panel>
              <ul className="divide-y divide-line">
                {pending.map((m) => (
                  <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-meta text-text-3">{where(m)}</p>
                      <TeamName name={names.get(m.teamAId ?? '') ?? null} />
                      <TeamName name={names.get(m.teamBId ?? '') ?? null} />
                      <span className="mt-1.5 inline-flex">
                        <Tag tone="waiting">One side has said so</Tag>
                      </span>
                    </div>
                    <span className="num shrink-0 text-[22px] font-bold text-text">
                      {m.gamesWonA}–{m.gamesWonB}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
            <Confirm
              label={`Confirm all ${pending.length}`}
              question={`All ${pending.length} of these become final now instead of waiting out their ten minutes. After that only you can change one, and the change goes in the log.`}
            >
              <form action={confirmAll}>
                <input type="hidden" name="slug" value={slug} />
                <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                  Make all {pending.length} final
                </button>
              </form>
            </Confirm>
          </>
        ) : (
          <p className="text-body text-text-2">Nothing waiting.</p>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <SectionHead
          title="No score yet"
          meta={`${missing.length} still to come in`}
        />
        {ordered.length ? (
          <Panel>
            <ul className="divide-y divide-line">
              {ordered.map((m) => {
                const a = names.get(m.teamAId ?? '') ?? '—'
                const b = names.get(m.teamBId ?? '') ?? '—'
                return (
                  <li key={m.id} className="flex flex-col gap-2.5 px-4 py-3.5">
                    <div className="flex items-start gap-2">
                      <p className="min-w-0 flex-1 text-meta text-text-3">{where(m)}</p>
                      {m.status === 'live' ? <StatusPill state="live">On court</StatusPill> : null}
                    </div>
                    <div>
                      <TeamName name={a} />
                      <TeamName name={b} />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <Link
                        href={`/admin/m/${m.id}`}
                        className={`${ROW_BUTTON} flex-1 basis-[8rem]`}
                      >
                        Enter the score
                      </Link>
                      {/* Which side failed to turn up is the whole content of a
                          walkover, and hard-coding one of them handed half the
                          pool matches to the wrong team. Two truncated buttons
                          side by side — "Meera Krishnam…" and "Divya Nataraj…"
                          — could not be told apart at 390px, so the choice is
                          made inside the confirm where the names fit whole. */}
                      <Confirm
                        className="flex-1 basis-[8rem] [&[open]]:basis-full"
                        label="Didn’t come"
                        question="Whoever didn’t turn up loses it as a walkover — never a typed 11-0, which would quietly corrupt the tiebreak. Who was missing?"
                      >
                        <div className="flex flex-col gap-2">
                          {(['A', 'B'] as const).map((side) => (
                            <form action={markNoShow} key={side}>
                              <input type="hidden" name="matchId" value={m.id} />
                              <input type="hidden" name="absent" value={side} />
                              <input type="hidden" name="slug" value={slug} />
                              <button className="tap-lg w-full rounded-control border border-line-strong bg-paper px-4 text-left text-[17px] font-semibold text-text">
                                {side === 'A' ? a : b} didn’t come
                              </button>
                            </form>
                          ))}
                        </div>
                      </Confirm>
                    </div>
                  </li>
                )
              })}
            </ul>
          </Panel>
        ) : (
          <EmptyState title="Everything that could be played has a score">
            <p>
              When the next pair comes off court, their match turns up here whether or not they
              scanned the card.
            </p>
          </EmptyState>
        )}
      </section>

      <Link href={`/admin/t/${slug}/board`} className={SECONDARY_LINK}>
        Back to the court board
      </Link>
    </div>
  )
}
