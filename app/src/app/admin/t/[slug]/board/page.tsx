import { clsx } from 'clsx'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { CourtSwatch, NetRule, Notice, StatusPill } from '@/components/ui'
import { elapsedLabel, formatDuration, venueTime } from '@/lib/time'
import { boardData, type BoardCourt, type BoardMatch } from '@/server/board'
import { getTournamentBySlug } from '@/server/tournaments'
import { placeMatch, takeOffCourt } from './actions'

export const dynamic = 'force-dynamic'

function Sides({ a, b, dim }: { a: string | null; b: string | null; dim?: boolean }) {
  return (
    <div className={clsx('min-w-[9rem] flex-1', dim && 'text-text-2')}>
      <p className="text-row">{a ?? 'To be decided'}</p>
      <p className="text-row">{b ?? 'To be decided'}</p>
    </div>
  )
}

function CourtCard({
  court,
  slug,
  firstPlaceable,
}: {
  court: BoardCourt
  slug: string
  firstPlaceable: BoardMatch | null
}) {
  if (court.closed) {
    return (
      <article data-court className="hatched rounded-card border border-dashed border-line-strong bg-sunken">
        <div className="px-4 py-3">
          <span className="font-score text-eyebrow text-text-3 uppercase">{court.name}</span>
          <p className="mt-1 text-row text-text-2">{court.closedReason}</p>
        </div>
      </article>
    )
  }

  if (court.live) {
    // The common failure is not a wrong score, it is NO score — the pair walked
    // off for water and the court stays occupied in the data (SPEC A4). There
    // is no `completed with no result` state to look for; the signal is a match
    // that has been on far longer than its format takes.
    const stale = court.live.overrunMinutes !== null
    return (
      <article
        data-court
        className={clsx(
          'overflow-hidden rounded-card border border-line-strong bg-paper shadow-card',
          stale ? 'ring-2 ring-waiting/40' : 'ring-2 ring-live/30',
        )}
      >
        <div aria-hidden className={clsx('h-1', stale ? 'bg-waiting' : 'bg-live')} />
        <div className="flex items-center gap-2 px-4 pt-3">
          <CourtSwatch colorKey={court.colorKey} />
          <span className="font-score text-eyebrow text-text-2 uppercase">{court.name}</span>
          {stale ? (
            <StatusPill state="waiting">Finished?</StatusPill>
          ) : (
            <StatusPill state="live">Live</StatusPill>
          )}
          {court.live.startedAt ? (
            <span className="num ml-auto text-meta text-text-3">
              {elapsedLabel(court.live.startedAt)}
            </span>
          ) : null}
        </div>
        <div className="mt-2 px-4">
          <Sides a={court.live.nameA} b={court.live.nameB} />
          <p className="mt-1 text-meta text-text-3">
            {court.live.categoryName}
            {court.live.roundName ? ` · ${court.live.roundName}` : ''}
          </p>
          {stale ? (
            <p className="mt-1.5 text-meta font-semibold text-waiting">
              On for {court.live.overrunMinutes} min — nobody has given a score.
            </p>
          ) : null}
        </div>
        <div className="flex gap-2 p-3 pt-3">
          <Link
            href={`/admin/m/${court.live.id}`}
            className={clsx(
              'tap-lg flex flex-1 items-center justify-center rounded-control text-[18px] font-bold text-white',
              stale ? 'bg-accent shadow-key' : 'bg-ink',
            )}
          >
            {stale ? 'Enter it for them' : 'Enter the score'}
          </Link>
          <form action={takeOffCourt}>
            <input type="hidden" name="matchId" value={court.live.id} />
            <input type="hidden" name="slug" value={slug} />
            <button className="tap-lg rounded-control border border-line-strong bg-paper px-4 text-[17px] font-semibold text-text">
              Off court
            </button>
          </form>
        </div>
      </article>
    )
  }

  // An idle court is daylight burning. This is the only place terracotta
  // becomes a large filled button anywhere in the product.
  return (
    <article data-court className="overflow-hidden rounded-card border border-line-strong bg-paper shadow-card">
      <div aria-hidden className="h-1 bg-line-strong" />
      <div className="flex items-center gap-2 px-4 pt-3">
        <CourtSwatch colorKey={court.colorKey} />
        <span className="font-score text-eyebrow text-text-2 uppercase">{court.name}</span>
        <StatusPill state="done">Free</StatusPill>
        {court.freeSinceMinutes !== null && court.freeSinceMinutes > 0 ? (
          <span className="num ml-auto text-meta font-semibold text-accent">
            empty {court.freeSinceMinutes} min
          </span>
        ) : null}
      </div>

      {firstPlaceable ? (
        <>
          <div className="mt-2 px-4">
            <Sides a={firstPlaceable.nameA} b={firstPlaceable.nameB} />
            <p className="mt-1 text-meta text-text-3">
              {firstPlaceable.categoryName}
              {firstPlaceable.roundName ? ` · ${firstPlaceable.roundName}` : ''}
            </p>
          </div>
          <div className="p-3 pt-3">
            <form action={placeMatch}>
              <input type="hidden" name="matchId" value={firstPlaceable.id} />
              <input type="hidden" name="courtId" value={court.id} />
              <input type="hidden" name="slug" value={slug} />
              <button className="tap-xl w-full rounded-control bg-accent text-[20px] font-bold text-white shadow-key active:translate-y-px active:shadow-none">
                Send to {court.name} →
              </button>
            </form>
          </div>
        </>
      ) : (
        <div className="px-4 pt-2 pb-4">
          <p className="text-body text-text-2">Nothing can start here yet.</p>
        </div>
      )}
    </article>
  )
}

export default async function BoardPage(props: PageProps<'/admin/t/[slug]/board'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) notFound()

  const { err } = await props.searchParams
  const data = await boardData(tournament.id)
  const placeable = data.queue.filter((m) => m.ready && !m.blockedBy)
  const blocked = data.queue.filter((m) => m.ready && m.blockedBy)
  const freeCourts = data.courts.filter((c) => !c.closed && !c.live)

  // Each free court is offered a DIFFERENT match — and never one that shares a
  // player with a match already offered somewhere else. Handing court 1 and
  // court 2 two matches that both contain Ravi meant the organiser tapped both
  // and the second was refused, which is the exact collision the board exists
  // to prevent.
  const suggestion = new Map<string, (typeof placeable)[number]>()
  const chosen = new Set<string>()
  const spokenFor = new Set<string>()
  for (const c of freeCourts) {
    const pick = placeable.find(
      (m) => !chosen.has(m.id) && !m.playerIds.some((p) => spokenFor.has(p)),
    )
    if (!pick) continue
    suggestion.set(c.id, pick)
    chosen.add(pick.id)
    for (const p of pick.playerIds) spokenFor.add(p)
  }
  const suggestedIds = chosen

  return (
    <div className="flex flex-col gap-6 pb-24">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Court board</p>
        <h1 className="mt-1 text-title text-text">{tournament.name}</h1>
      </header>

      {err ? <Notice>{String(err)}</Notice> : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {data.courts.map((court) => (
          <CourtCard
            key={court.id}
            court={court}
            slug={slug}
            firstPlaceable={suggestion.get(court.id) ?? null}
          />
        ))}
      </div>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">Up next</h2>
          <span className="num text-meta text-text-3">{data.remaining} to play</span>
        </div>
        <NetRule className="mt-2" />
        <ul className="mt-3 flex flex-col gap-2">
          {placeable.filter((m) => !suggestedIds.has(m.id)).slice(0, 6).map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-3 rounded-card border border-line-strong bg-paper px-4 py-3 shadow-card"
            >
              <Sides a={m.nameA} b={m.nameB} />
              <form action={placeMatch} className="ml-auto shrink-0">
                <input type="hidden" name="matchId" value={m.id} />
                <input type="hidden" name="courtId" value={freeCourts[0]?.id ?? ''} />
                <input type="hidden" name="slug" value={slug} />
                <button
                  disabled={!freeCourts[0]}
                  className="tap rounded-control bg-ink px-4 text-[16px] font-bold text-white disabled:opacity-50"
                >
                  {freeCourts[0] ? `Send to ${freeCourts[0].name}` : 'No free court'}
                </button>
              </form>
            </li>
          ))}

          {blocked.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-3 rounded-card border border-line-strong bg-sunken px-4 py-3"
            >
              <Sides a={m.nameA} b={m.nameB} dim />
              {/* The reason is the affordance, not a separate error line. */}
              <span className="ml-auto shrink-0 text-right text-meta font-semibold text-text-2">
                {m.blockedBy}
              </span>
            </li>
          ))}

          {/* Never hidden: a match the board knows about but doesn't list is a
              header that says 7 to play above a list of 4. */}
          {data.waiting.map((m) => (
            <li
              key={m.id}
              className="flex flex-wrap items-center gap-3 rounded-card border border-dashed border-line-strong bg-sunken px-4 py-3"
            >
              <Sides a={m.nameA} b={m.nameB} dim />
              <span className="ml-auto shrink-0 text-right text-meta text-text-3">
                {m.roundName ? `${m.roundName} · ` : ''}
                {m.waitingOn}
              </span>
            </li>
          ))}

          {placeable.length === 0 && blocked.length === 0 && data.waiting.length === 0 ? (
            <li className="rounded-card border border-line-strong bg-paper px-4 py-6 text-center text-body text-text-2">
              Every match has been played.
            </li>
          ) : null}
        </ul>
      </section>

      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line-strong bg-paper px-4 py-3 shadow-dock">
        <div className="mx-auto flex max-w-3xl items-center gap-2">
          <p className="num text-meta text-text-2">
            {data.openCourts} courts · {data.liveCount} live · {data.remaining} to play
          </p>
          <p
            className={clsx(
              'num ml-auto text-meta font-bold',
              data.pastSunset ? 'text-alert' : 'text-text',
            )}
          >
            {data.remaining === 0
              ? 'Done'
              : `finishing about ${data.finishAt ? venueTime(data.finishAt) : formatDuration(data.finishEstimateMinutes)}`}
          </p>
        </div>
      </div>
    </div>
  )
}
