import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { courts, tournaments } from '@/db/schema'
import { atLeast, requireUser } from '@/lib/auth'
import { getMatchForScoring, projectedState } from '@/server/scoring'
import { AdminEntry } from './entry'
import { useSubmission } from './actions'
import Link from 'next/link'
import { Notice, Panel, SectionHead, TeamName } from '@/components/ui'
import { SECONDARY_LINK } from '../../_ui'

export const dynamic = 'force-dynamic'

const STATE_WORDS: Record<string, string> = {
  reported: 'A result is in and waiting to settle',
  disputed: 'The two sides don’t agree',
  final: 'The result is final',
  voided: 'This result was voided',
}

export default async function AdminMatchPage(props: PageProps<'/admin/m/[matchId]'>) {
  const user = await requireUser('umpire')
  const { matchId } = await props.params

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

  // An umpire scores; an organiser corrects. Showing an umpire a form that will
  // be refused on submit is worse than not showing it.
  if (hasResult && !atLeast(user, 'admin')) {
    return (
      <div className="flex flex-col gap-4">
        <p className="font-score text-eyebrow text-accent uppercase">
          {loaded.category.name}
          {loaded.match.roundName ? ` · ${loaded.match.roundName}` : ''}
        </p>
        <h1>
          <TeamName name={loaded.nameA} size="section" />
          <span className="block text-meta text-text-3">v</span>
          <TeamName name={loaded.nameB} size="section" />
        </h1>
        <Notice tone="info">
          {STATE_WORDS[state] ?? 'A result is already in'}. Ask the organiser if it needs changing.
        </Notice>
        <Link href="/umpire" className={SECONDARY_LINK}>
          Back to your matches
        </Link>
      </div>
    )
  }

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

  const back = atLeast(user, 'admin') ? `/admin/t/${tournament?.slug ?? ''}/board` : '/umpire'

  return (
    <div className="flex flex-col gap-7">
      {disputePanel}
      <AdminEntry
      matchId={matchId}
      courtName={court?.name ?? null}
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
        {atLeast(user, 'admin') ? 'Back to the court board' : 'Back to your matches'}
      </Link>
    </div>
  )
}
