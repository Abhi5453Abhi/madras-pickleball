import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import {
  Confirm,
  Disclosure,
  EmptyState,
  Panel,
  SectionHead,
  StatusPill,
  Tag,
} from '@/components/ui'
import {
  getTournamentBySlug,
  listCategories,
  listMatches,
  teamNameMap,
} from '@/server/tournaments'
import { ROW_BUTTON, SECONDARY_LINK } from '../../../_ui'
import { confirmAll, markNoShow } from './actions'

/**
 * The clipboard path — SPEC A5. Realistic court-QR adoption is maybe 60%; the
 * rest of the results arrive on paper, and this is where they go in.
 *
 * Four lists, in the order they cost the organiser something: a disagreement
 * blocks the bracket, a provisional score settles itself, a match that has been
 * played with no score needs somebody to walk over and ask — and a match that
 * was never sent out is not a missing score at all. Lumping that last group in
 * had the page asking the organiser to chase six matches when two needed it.
 */

/** The screen's own word first: a tab label truncates from the right. */
export async function generateMetadata(props: PageProps<'/admin/t/[slug]/results'>) {
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  return { title: tournament ? `Results desk · ${tournament.name}` : 'Results desk · Madras Pickleball' }
}

export const dynamic = 'force-dynamic'

/**
 * Two sides, one line each. The slash is the separator a player already reads,
 * and stacking all four names turned "Lakshmi Narayanan / Sowmya Balaji v
 * Kavitha Selvam / Meera Krishnamurthy" into one block of four names with
 * nothing saying where one pair ended. Same treatment as the board and the
 * public queue; the stacked form belongs on a single match in focus.
 */
function Pair({ a, b }: { a: string; b: string }) {
  return (
    <div className="min-w-0">
      <p className="text-row text-text">{a}</p>
      <p className="text-row text-text">{b}</p>
    </div>
  )
}

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
  // A match on a court, or one that has come off it, has been played and owes a
  // score. One that is only `ready` has not been sent out yet — it is in the
  // queue, and asking about it is asking about nothing.
  const owed = missing.filter((m) => m.status === 'live' || m.status === 'completed')
  const notOut = missing.filter((m) => m.status !== 'live' && m.status !== 'completed')

  const where = (m: (typeof all)[number]) =>
    [catName.get(m.categoryId), m.roundName].filter(Boolean).join(' · ')

  /** One unscored match: who, and the two ways a score gets in. */
  const scoreRow = (m: (typeof all)[number]) => {
    const a = names.get(m.teamAId ?? '') ?? '—'
    const b = names.get(m.teamBId ?? '') ?? '—'
    return (
      <li key={m.id} className="flex flex-col gap-2.5 px-4 py-3.5">
        <div className="flex items-start gap-2">
          <p className="min-w-0 flex-1 text-meta text-text-3">{where(m)}</p>
          {m.status === 'live' ? <StatusPill state="live">On court</StatusPill> : null}
        </div>
        <Pair a={a} b={b} />
        <div className="flex flex-wrap gap-2">
          <Link href={`/admin/m/${m.id}`} className={`${ROW_BUTTON} flex-1 basis-[8rem]`}>
            Enter the score
          </Link>
          {/* Which side failed to turn up is the whole content of a walkover,
              and hard-coding one of them handed half the pool matches to the
              wrong team. Two truncated buttons side by side — "Meera
              Krishnam…" and "Divya Nataraj…" — could not be told apart at
              390px, so the choice is made inside the confirm, where the names
              fit whole. */}
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
                  <button className="tap-lg w-full rounded-control border border-line-key bg-paper px-4 text-left text-[17px] font-semibold text-text">
                    {side === 'A' ? a : b} didn’t come
                  </button>
                </form>
              ))}
            </div>
          </Confirm>
        </div>
      </li>
    )
  }

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
          {disputed.length} under review · {pending.length} not confirmed · {owed.length} played
          with no score
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
                    <Pair
                      a={names.get(m.teamAId ?? '') ?? '—'}
                      b={names.get(m.teamBId ?? '') ?? '—'}
                    />
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

      {pending.length ? (
        <section className="flex flex-col gap-3">
          <SectionHead
            title="Waiting to be confirmed"
            meta={`${pending.length} entered — each settles on its own ten minutes after it went in`}
          />
          <Panel>
            <ul className="divide-y divide-line">
              {pending.map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-meta text-text-3">{where(m)}</p>
                    <Pair
                      a={names.get(m.teamAId ?? '') ?? '—'}
                      b={names.get(m.teamBId ?? '') ?? '—'}
                    />
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
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionHead
          title="No score yet"
          meta={
            owed.length
              ? 'Played, or being played, and nobody has given a score'
              : 'Everything that has been played has a score'
          }
        />
        {owed.length ? (
          <Panel>
            <ul className="divide-y divide-line">{owed.map(scoreRow)}</ul>
          </Panel>
        ) : (
          <EmptyState title="Nothing to chase">
            <p>
              When the next pair comes off court, their match turns up here whether or not they
              scanned the card.
            </p>
          </EmptyState>
        )}

        {/* Never hidden, never listed as a chase-up: these are matches still in
            the queue. They are here for the one case that needs them — an
            organiser holding a paper score for a match the board never sent
            out. */}
        {notOut.length ? (
          <Disclosure
            summary={`${notOut.length} not sent out yet`}
            meta="Only if you have a score for one on paper"
          >
            <Panel>
              <ul className="divide-y divide-line">{notOut.map(scoreRow)}</ul>
            </Panel>
          </Disclosure>
        ) : null}
      </section>

      <Link href={`/admin/t/${slug}/board`} className={SECONDARY_LINK}>
        Back to the court board
      </Link>
    </div>
  )
}
