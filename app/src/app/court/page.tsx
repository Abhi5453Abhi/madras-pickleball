import { eq, inArray } from 'drizzle-orm'
import { db } from '@/db'
import { categories, teams } from '@/db/schema'
import { CourtSwatch, NetRule } from '@/components/ui'
import { ensureReady } from '@/server/bootstrap'
import { currentCourtSession, scoreableMatches } from '@/server/court-tokens'
import { rulesFor } from '@/server/scoring'
import { CourtEntry } from './entry'
import { courtAgree, courtDispute } from './actions'

/**
 * What the QR on the net post opens — SPEC A1/A5.
 *
 * Never a dead end: if nothing is on this court it says so and points at what
 * is coming, rather than showing an error to somebody holding a paddle.
 */
export const dynamic = 'force-dynamic'

export default async function CourtPage(props: PageProps<'/court'>) {
  await ensureReady()
  const { bad } = await props.searchParams
  const ctx = await currentCourtSession()

  if (!ctx) {
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-title text-text">
          {bad ? 'That card doesn’t work any more' : 'Scan the card on the net post'}
        </h1>
        <p className="text-body text-text-2">
          {bad
            ? 'The organiser may have printed new cards for today. Ask them for the current one.'
            : 'Each court has its own QR card. Scanning it opens the scoreboard for whatever match is on that court.'}
        </p>
      </main>
    )
  }

  const candidates = await scoreableMatches(ctx)
  const live = candidates.find((m) => m.status === 'live') ?? null
  const awaitingConfirm = candidates.find((m) => m.resultState === 'reported') ?? null
  const target = live ?? candidates[0] ?? null

  const header = (
    <div className="flex items-center gap-2">
      <CourtSwatch colorKey={ctx.colorKey} />
      <span className="font-score text-[40px] leading-none font-bold text-text">
        {ctx.courtName.toUpperCase()}
      </span>
    </div>
  )

  if (!target) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-4 p-4 pt-8">
        {header}
        <NetRule />
        <h1 className="text-title text-text">Nothing on {ctx.courtName} right now</h1>
        <p className="text-body text-text-2">
          When the organiser sends a match here, it shows up on this screen. Keep the card on the
          net post.
        </p>
      </main>
    )
  }

  const sides = await db
    .select({ id: teams.id, name: teams.name })
    .from(teams)
    .where(inArray(teams.id, [target.teamAId, target.teamBId].filter(Boolean) as string[]))
  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, target.categoryId))
    .limit(1)

  const nameA = sides.find((s) => s.id === target.teamAId)?.name ?? '—'
  const nameB = sides.find((s) => s.id === target.teamBId)?.name ?? '—'

  // The hand-the-phone step: one device, five seconds, and it is the actual
  // social protocol of self-refereed pickleball.
  if (awaitingConfirm && awaitingConfirm.id === target.id) {
    return (
      <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-5 p-4 pt-8">
        {header}
        <NetRule />
        <div>
          <h1 className="text-title text-text">Hand the phone over</h1>
          <p className="mt-2 text-body text-text-2">
            {nameA} v {nameB} — the score is in. Whoever hasn’t submitted it should check it.
          </p>
          <p className="num mt-3 text-score text-text">
            {awaitingConfirm.gamesWonA}–{awaitingConfirm.gamesWonB}
          </p>
        </div>
        <div className="flex flex-col gap-3">
          <form action={courtAgree}>
            <input type="hidden" name="matchId" value={awaitingConfirm.id} />
            <button className="tap-xl w-full rounded-control bg-ink text-[20px] font-bold text-white">
              That’s right
            </button>
          </form>
          <form action={courtDispute}>
            <input type="hidden" name="matchId" value={awaitingConfirm.id} />
            <button className="tap-lg w-full rounded-control border border-line-strong bg-paper text-[18px] font-semibold text-text">
              Not right
            </button>
          </form>
          <p className="text-meta text-text-3">
            If they’ve already left, leave it — it goes final on its own in 10 minutes.
          </p>
        </div>
      </main>
    )
  }

  return (
    <main className="mx-auto w-full max-w-md p-4 pt-8">
      <CourtEntry
        matchId={target.id}
        courtName={ctx.courtName}
        courtColor={ctx.colorKey}
        categoryName={category?.name ?? ''}
        roundName={target.roundName}
        teamAId={target.teamAId!}
        teamBId={target.teamBId!}
        nameA={nameA}
        nameB={nameB}
        rules={rulesFor(category!)}
      />
    </main>
  )
}
