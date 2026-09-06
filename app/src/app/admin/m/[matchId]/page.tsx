import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { courts, tournaments } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { getMatchForScoring, projectedState } from '@/server/scoring'
import { AdminEntry } from './entry'
import { useSubmission, voidThisMatch } from './actions'
import Link from 'next/link'
import { Chevron, Confirm, Notice, Panel, SectionHead } from '@/components/ui'
import { SECONDARY_LINK } from '../../_ui'

export const metadata = { title: 'Enter a score · Madras Pickleball' }

export const dynamic = 'force-dynamic'

const STATE_WORDS: Record<string, string> = {
  reported: 'A result is in and waiting to settle',
  disputed: 'The two sides don’t agree',
  final: 'The result is final',
  voided: 'This result was voided',
}

export default async function AdminMatchPage(props: PageProps<'/admin/m/[matchId]'>) {
  await requireUser('admin')
  const { matchId } = await props.params
  const { err } = await props.searchParams

  const loaded = await getMatchForScoring(matchId)
  if (!loaded || !loaded.match.teamAId || !loaded.match.teamBId) notFound()

  const [tournament] = await db
    .select({ slug: tournaments.slug })
    .from(tournaments)
    .where(eq(tournaments.id, loaded.match.tournamentId))
    .limit(1)

  const court = loaded.match.courtId
    ? (await db.select().from(courts).where(eq(courts.id, loaded.match.courtId)).limit(1))[0]
    : null

  const state = projectedState(loaded.match)
  const hasResult = loaded.match.resultState !== 'none'

  const existing = hasResult
    ? {
        scoreLine:
          loaded.games.length > 0
            ? loaded.games.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ')
            : null,
        winnerName:
          loaded.match.winnerTeamId === loaded.match.teamAId
            ? (loaded.nameA ?? null)
            : loaded.match.winnerTeamId === loaded.match.teamBId
              ? (loaded.nameB ?? null)
              : null,
        label: STATE_WORDS[state] ?? 'A result is already in',
      }
    : null

  // Two people entered two different scores. Show both, name who gave each,
  // and make picking one a single tap — SPEC A5.
  const disputePanel =
    state === 'disputed' && loaded.submissions.length > 1 ? (
      <section className="flex flex-col gap-3">
        <SectionHead
          title="Two different scores came in"
          meta="Pick the right one, or enter the real score below. Either way it goes in the log."
        />
        <Panel>
          <ul className="divide-y divide-line">
            {loaded.submissions.map((sub) => {
              const who =
                sub.submittingTeamId === loaded.match.teamAId
                  ? (loaded.nameA ?? 'Side A')
                  : sub.submittingTeamId === loaded.match.teamBId
                    ? (loaded.nameB ?? 'Side B')
                    : 'The court device'
              const gs = (sub.games ?? []) as Array<{ scoreA: number; scoreB: number }>
              const winner =
                sub.winnerTeamId === loaded.match.teamAId
                  ? loaded.nameA
                  : sub.winnerTeamId === loaded.match.teamBId
                    ? loaded.nameB
                    : null
              return (
                <li key={sub.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-[9rem] flex-1">
                    <p className="text-meta text-text-3">{who} says</p>
                    <p className="text-row text-text">{winner ? `${winner} won` : 'No winner given'}</p>
                    <p className="num text-meta text-text-2">
                      {gs.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ') || '—'}
                    </p>
                  </div>
                  <form action={useSubmission} className="ml-auto shrink-0">
                    <input type="hidden" name="matchId" value={matchId} />
                    <input type="hidden" name="submissionId" value={sub.id} />
                    <input type="hidden" name="back" value={`/admin/t/${tournament?.slug ?? ''}/results`} />
                    <button className="tap rounded-control bg-ink px-4 text-[16px] font-bold text-white">
                      Use this one
                    </button>
                  </form>
                </li>
              )
            })}
          </ul>
        </Panel>
      </section>
    ) : null

  // Saving sends you straight back to the venue-wide board — the one screen
  // the organiser looks at while it is all happening.
  const back = '/admin/live'

  return (
    <div className="flex flex-col gap-7">
      <Link
        href={back as never}
        className="tap -mb-4 -ml-2 inline-flex items-center gap-0.5 self-start px-2 text-[16px] font-semibold text-link"
      >
        <Chevron className="rotate-90" />
        Live board
      </Link>
      {/* `voidMatch` refuses by naming the later match that was built off this
          result. Throwing that sentence away is the bug that had to be fixed on
          `sendToCourt`; it is the only thing that tells the organiser what to
          sort out first. */}
      {err ? (
        <Notice tone="alert" title="Not done">
          {String(err)}
        </Notice>
      ) : null}
      {disputePanel}
      <AdminEntry
      matchId={matchId}
      // The court only matters while they are on it; a correction an hour
      // later has no business shouting COURT 1.
      courtName={loaded.match.status === 'live' ? (court?.name ?? null) : null}
      courtColor={court?.colorKey}
      categoryName={loaded.category.name}
      roundName={loaded.match.roundName}
      teamAId={loaded.match.teamAId}
      teamBId={loaded.match.teamBId}
      nameA={loaded.nameA ?? '—'}
      nameB={loaded.nameB ?? '—'}
      rules={loaded.rules}
      existing={existing}
      back={back}
      />

      {/* An organiser arrives here from the escape hatch to LOOK at a score as
          often as to change one, and leaving with the browser button loses the
          scroll position on the page they came from. */}
      <Link href={back as never} className={SECONDARY_LINK}>
        Back to the live board
      </Link>

      {/* Cancelling is not correcting: the match counts for nobody afterwards,
          in no table and no difference column. Organiser only, never while it
          is on court, and never silently — the reason is required. */}
      {loaded.match.status !== 'live' ? (
        <Confirm
          label="Cancel this match"
          question={`${loaded.nameA} v ${loaded.nameB} stops counting for anybody — no winner, no points, and it leaves both pairs' tables.`}
          detail="Use this when a match should never have existed. To fix a wrong score, change the score above instead."
        >
          <form action={voidThisMatch} className="flex flex-col gap-2">
            <input type="hidden" name="matchId" value={matchId} />
            <input type="hidden" name="back" value={back} />
            <input
              name="reason"
              required
              minLength={3}
              placeholder="Why — e.g. entered against the wrong pair"
              aria-label="Why this match is being cancelled"
              className="tap w-full rounded-control border border-line-key bg-paper px-3.5 text-body text-text placeholder:text-text-3"
            />
            <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
              Cancel it
            </button>
          </form>
        </Confirm>
      ) : null}
    </div>
  )
}
