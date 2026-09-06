import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { courts } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { getMatchForScoring, projectedState } from '@/server/scoring'
import { AdminEntry } from './entry'
import { voidThisMatch } from './actions'
import Link from 'next/link'
import { Chevron, Confirm, Notice } from '@/components/ui'
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
