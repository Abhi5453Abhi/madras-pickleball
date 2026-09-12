import { clsx } from 'clsx'
import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { Chevron, CourtSwatch, Notice, StatusPill, TeamName, splitTeam } from '@/components/ui'
import { venueDate, venueTime } from '@/lib/time'
import {
  venueBoard,
  venueVersion,
  type BoardMatch,
  type VenueBoard,
  type VenueCourt,
  type VenueTournament,
} from '@/server/board'
import { addCourtFromBoard, giveCourtBack, putOnCourt, resumeFromBoard } from './actions'
import { BoardRefresh } from './refresh'
import { finishEventAction } from '../t/[slug]/hub-actions'
import { PRIMARY_LINK, SECONDARY_LINK } from '../_ui'

/**
 * The one screen you look at while it's all happening — every court in the
 * venue, one card each, with the match on it and the match after. It covers
 * every tournament running today at once, so you never switch between them.
 * One tap into the score. Matches go on by themselves.
 */
export const metadata = { title: 'Live board · Madras Pickleball' }

export const dynamic = 'force-dynamic'

/** "Round 3" → "R3"; "Semi-final" and "Final" stay as they are. */
function roundShort(roundName: string | null) {
  if (!roundName) return null
  return roundName.replace(/\bRound (\d+)/, 'R$1')
}

/** "Karthik Subramanian / Sathish Kumar" → "Karthik / Sathish": the next line has one line. */
function shortPair(name: string | null) {
  const parts = splitTeam(name)
  if (!parts.length) return 'To be decided'
  return parts.map((p) => p.split(/\s+/)[0]).join(' / ')
}

function pairLine(m: BoardMatch) {
  return `${shortPair(m.nameA)} v ${shortPair(m.nameB)}`
}

const CARD = 'overflow-hidden rounded-card border border-line-strong bg-paper shadow-card'
const HEAD = 'flex items-center gap-2 px-4 pt-3'
const EYEBROW = 'font-score text-eyebrow text-text-2 uppercase'
const QUIET_BUTTON =
  'tap flex items-center justify-center rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text'

export default async function LiveBoardPage(props: PageProps<'/admin/live'>) {
  await requireUser('admin')
  const { err, note } = await props.searchParams
  const [board, version] = await Promise.all([venueBoard(), venueVersion()])
  const running = board.tournaments.filter((t) => t.running)

  return (
    <div className="flex flex-col gap-6">
      <BoardRefresh version={version} />

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
            <h1 className="text-title text-text">Live board</h1>
            <p className="num mt-1 text-meta text-text-3">
              {venueDate(board.now)} ·{' '}
              {running.length === 0
                ? 'nothing running'
                : `${running.length} ${running.length === 1 ? 'tournament' : 'tournaments'} running`}
            </p>
          </div>
          <StatusPill state={board.liveCount ? 'live' : 'done'}>{board.liveCount} on court</StatusPill>
        </div>
      </header>

      {err ? (
        <Notice tone="alert" title="Not done">
          {String(err)}
        </Notice>
      ) : null}
      {note ? <Notice tone="done">{String(note)}</Notice> : null}

      {running.length ? <Strip tournaments={running} /> : null}

      {/* A stopped tournament is said once, above its courts, with the way
          to start it again — not on every one of its cards. */}
      {running
        .filter((t) => t.paused)
        .map((t) => (
          <Notice
            key={t.id}
            tone="waiting"
            title={`${t.name} is paused`}
            action={
              <form action={resumeFromBoard}>
                <input type="hidden" name="tournamentId" value={t.id} />
                <button className={`${PRIMARY_LINK} w-full`}>Start again</button>
              </form>
            }
          >
            {t.paused}. Nothing goes on its courts until you start again — the public page says so.
          </Notice>
        ))}

      {/* Everything played: finishing is the one thing left to do, so it is
          the first thing on the board, not a text link inside a court card. */}
      {running
        .filter((t) => t.total > 0 && t.played === t.total)
        .map((t) => (
          <form key={t.id} action={finishEventAction}>
            <input type="hidden" name="slug" value={t.slug} />
            <button className={PRIMARY_LINK}>Finish {t.name}</button>
            <p className="mt-2 text-center text-meta text-text-2">
              All {t.total} played. The winners go on top of the public page and its courts come free.
            </p>
          </form>
        ))}

      {/* A games-only night is a real night. Saying "nothing on court" above
          two cards that name a game on two courts is simply false. */}
      {running.length === 0 && !board.courts.some((c) => c.heldBy) ? (
        <Notice tone="info" title="Nothing on court yet">
          Start a tournament from its page and its first matches go straight onto its courts.
        </Notice>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        {board.courts.map((court) => (
          <CourtCard key={court.id} court={court} board={board} />
        ))}
      </div>

      <Link href="/admin/courts/day" className={SECONDARY_LINK}>
        What is on today, and what is free
      </Link>

      <MoreLinks tournaments={running} />
    </div>
  )
}

/** "Men's 7 of 16 · about 17:40 · Mixed paused" — the day in one line. */
function Strip({ tournaments }: { tournaments: VenueTournament[] }) {
  return (
    <ul className="num flex flex-wrap gap-x-5 gap-y-1 text-meta text-text-2">
      {tournaments.map((t) => (
        <li key={t.id}>
          <b className="font-semibold text-text">{t.shortName}</b>{' '}
          {t.paused
            ? 'paused'
            : t.total === 0
              ? 'no schedule'
              : t.played === t.total
                ? 'all played'
                : `${t.played} of ${t.total}${t.finishAt ? ` · about ${venueTime(t.finishAt)}` : ''}`}
        </li>
      ))}
    </ul>
  )
}

function CourtCard({ court, board }: { court: VenueCourt; board: VenueBoard }) {
  const t = court.tournament
  // A court is not one tournament's for a whole day any more, so "not assigned"
  // stopped being the only other state. A game or a coaching batch has it, and
  // the card says so and says until when.
  if (!t && court.heldBy) return <HeldCard court={court} held={court.heldBy} />
  if (!t) return <UnassignedCard court={court} board={board} />
  if (!t.running) return <NotStartedCard court={court} tournament={t} />

  const live = court.live
  const stale = !!live && live.overrunMinutes !== null

  return (
    <article
      data-court
      className={clsx(CARD, live && (stale ? 'ring-2 ring-waiting/40' : 'ring-2 ring-live/30'))}
    >
      {/* The common failure is not a wrong score, it is NO score — the pair
          walked off for water and the court stays occupied. The signal is a
          match that has been on far longer than its format takes. */}
      {stale ? (
        <p className="bg-waiting-soft px-4 py-2 text-meta font-semibold text-waiting">
          On for {live.overrunMinutes} min and no score — did they finish?
        </p>
      ) : null}

      {/* Not "out of action": the reason a court is unavailable is now most
          often that the tournament's own hours have not started or have ended,
          and "out of action — Yours from 6:00 pm" is a sentence about a court
          in perfect condition. The reason says it all by itself. */}
      {court.closedReason ? (
        <p className="bg-sunken px-4 py-2 text-meta font-semibold text-text-2">{court.closedReason}</p>
      ) : null}

      <div className={HEAD}>
        <CourtSwatch colorKey={court.colorKey} size="md" />
        <span className={EYEBROW}>{court.name}</span>
        <span className="ml-auto text-right text-meta text-text-3">
          {t.categoryName}
          {live?.roundName ? ` · ${roundShort(live.roundName)}` : ''}
        </span>
      </div>

      {live ? (
        <>
          <div className="mt-2 px-4">
            <TeamName name={live.nameA} />
            <span className="my-1 block text-meta text-text-3">against</span>
            <TeamName name={live.nameB} />
          </div>
          {/* gap-3, not gap-2: the brief's floor is that nothing important
              sits within 8px of another target, and these are the two a wet
              thumb reaches for. */}
          <div className="flex gap-3 p-3">
            <Link
              href={`/admin/m/${live.id}`}
              className={clsx(
                'tap flex flex-1 items-center justify-center rounded-control text-[17px] font-bold text-white',
                stale ? 'bg-accent shadow-key' : 'bg-ink',
              )}
            >
              {stale ? 'Enter it for them' : 'Enter the score'}
            </Link>
            <Link href={`/admin/live/move/${live.id}` as never} className={QUIET_BUTTON}>
              Move
            </Link>
          </div>
        </>
      ) : (
        <div className="mt-2 px-4 pb-3">
          <p className="text-row text-text-3">Nothing on court</p>
          {court.idleReason ? (
            <p className="mt-1 text-meta text-text-2">
              {court.idleReason}
              {t.board && t.board.remaining === 0 ? (
                <>
                  .{' '}
                  <span>Finish it with the button at the top</span>
                </>
              ) : null}
            </p>
          ) : null}
          {court.offer ? (
            // The flow should have put this on. It did not — a court came free
            // by a door the flow does not watch — so the board offers it, in
            // the only terracotta button on the screen.
            <form action={putOnCourt} className="mt-3">
              <input type="hidden" name="matchId" value={court.offer.id} />
              <input type="hidden" name="courtId" value={court.id} />
              <input type="hidden" name="tournamentId" value={t.id} />
              <button className="tap w-full rounded-control bg-accent px-4 text-[17px] font-bold text-white shadow-key active:translate-y-px active:shadow-none">
                Put {pairLine(court.offer)} on {court.name}
              </button>
            </form>
          ) : null}
        </div>
      )}

      <NextLine court={court} />
    </article>
  )
}

/** "Next here: Arun / Manoj v Deepak / Bala" — or what it is waiting on. */
function NextLine({ court }: { court: VenueCourt }) {
  if (court.offer) return null
  if (court.next) {
    return (
      <p className="border-t border-line px-4 py-2.5 text-meta text-text-2">
        Next here: <b className="font-semibold text-text">{pairLine(court.next)}</b>
      </p>
    )
  }
  if (!court.nextNote) return null
  if (court.nextNote === 'Nothing left for this court' || court.nextNote === 'This is the last one here') {
    return <p className="border-t border-line px-4 py-2.5 text-meta text-text-3">{court.nextNote}</p>
  }
  const [head, ...rest] = court.nextNote.split(' · ')
  return (
    <p className="border-t border-line px-4 py-2.5 text-meta text-text-2">
      Next here: <b className="font-semibold text-text">{head}</b>
      {rest.length ? ` · ${rest.join(' · ')}` : ''}
    </p>
  )
}

/** A court somebody who is not a tournament has: a daily game, or a block. */
function HeldCard({
  court,
  held,
}: {
  court: VenueCourt
  held: NonNullable<VenueCourt['heldBy']>
}) {
  const blocked = held.kind === 'block'
  return (
    <article data-court className={clsx(CARD, blocked && 'opacity-80')}>
      <div className={HEAD}>
        <CourtSwatch colorKey={court.colorKey} size="md" />
        <span className={EYEBROW}>{court.name}</span>
        <span className="ml-auto text-right text-meta text-text-3">
          {blocked ? 'Out of action' : 'Game'}
        </span>
      </div>
      <div className="px-4 pt-1 pb-4">
        <p className="text-row text-text">
          {held.slug && !blocked ? (
            <Link href={`/admin/g/${held.slug}` as never} className="text-link">
              {held.name}
            </Link>
          ) : (
            held.name
          )}
        </p>
        <p className="num mt-0.5 text-meta text-text-3">until {venueTime(held.until)}</p>
        {/* The host is standing in front of the court. Making them go to
            Settings → Courts → the day view to give it back is three screens
            away from where they are. */}
        {blocked ? (
          <form action={giveCourtBack} className="mt-3">
            <input type="hidden" name="holdId" value={held.id} />
            <button className={`${QUIET_BUTTON} w-full`}>Give {court.name} back</button>
          </form>
        ) : null}
      </div>
    </article>
  )
}

/**
 * A court nobody holds today. "Not assigned" is the whole story unless a
 * tournament could use it, in which case the card offers it.
 */
function UnassignedCard({ court, board }: { court: VenueCourt; board: VenueBoard }) {
  const wants = board.wants
  return (
    <article data-court className="hatched rounded-card border border-dashed border-line-strong bg-paper">
      <div className={clsx(HEAD, !wants && 'pb-3')}>
        <CourtSwatch colorKey={court.colorKey} size="md" />
        <span className={EYEBROW}>{court.name}</span>
        <span className="ml-auto text-meta text-text-3">Not assigned</span>
      </div>
      {wants ? (
        <div className="px-4 pt-2 pb-4 text-body text-text-2">
          <p>
            {wants.shortName} has {wants.toPlay} to play and a court sitting empty.
          </p>
          <form action={addCourtFromBoard} className="mt-3">
            <input type="hidden" name="tournamentId" value={wants.id} />
            <input type="hidden" name="courtId" value={court.id} />
            <button className={`${QUIET_BUTTON} w-full`}>
              Add {court.name} to {wants.categoryName}
            </button>
          </form>
        </div>
      ) : null}
    </article>
  )
}

/** Held by a tournament on today that has not been started. */
function NotStartedCard({ court, tournament: t }: { court: VenueCourt; tournament: VenueTournament }) {
  return (
    <article data-court className="hatched rounded-card border border-dashed border-line-strong bg-paper">
      <div className={HEAD}>
        <CourtSwatch colorKey={court.colorKey} size="md" />
        <span className={EYEBROW}>{court.name}</span>
        <span className="ml-auto text-right text-meta text-text-3">{t.categoryName}</span>
      </div>
      <p className="px-4 pt-2 pb-4 text-body text-text-2">
        {t.name} hasn’t started yet.{' '}
        <Link href={`/admin/t/${t.slug}`} className="font-semibold text-link">
          Start it from its page
        </Link>
        .
      </p>
    </article>
  )
}

/** The escape hatch: pause, pull a pair out, fix a score — on the tournament's More page. */
function MoreLinks({ tournaments }: { tournaments: VenueTournament[] }) {
  if (tournaments.length === 0) return null
  if (tournaments.length === 1) {
    return (
      <Link
        href={`/admin/t/${tournaments[0].slug}/more` as never}
        className="tap flex items-center justify-center px-3 text-center text-[16px] font-semibold text-link"
      >
        More · pause, pull a pair out, fix a score
      </Link>
    )
  }
  return (
    <div className="flex flex-col items-center">
      <p className="text-center text-meta text-text-3">More · pause, pull a pair out, fix a score</p>
      <ul className="flex flex-wrap justify-center gap-x-2">
        {tournaments.map((t) => (
          <li key={t.id}>
            <Link
              href={`/admin/t/${t.slug}/more` as never}
              className="tap flex items-center justify-center px-3 text-center text-[16px] font-semibold text-link"
            >
              {t.categoryName}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
