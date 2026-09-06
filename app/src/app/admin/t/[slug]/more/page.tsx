import { Fragment } from 'react'
import { clsx } from 'clsx'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import {
  CourtSwatch,
  Disclosure,
  EmptyState,
  Meter,
  Notice,
  Panel,
  SectionHead,
  StatusPill,
  TeamName,
  statusWords,
  type Status,
} from '@/components/ui'
import { formatDuration, venueDate, venueTime } from '@/lib/time'
import { estimateDay, minutesPerMatch } from '@/lib/estimate'
import { tiebreakNote } from '@/lib/standings'
import { boardData } from '@/server/board'
import { substitutionOptions, withdrawalEffect } from '@/server/chaos'
import { listPendingRegistrations } from '@/server/registration'
import {
  gamesByMatch,
  getTournamentBySlug,
  listCategories,
  listMatches,
  listTournamentPlayers,
  standingsFor,
  teamNameMap,
} from '@/server/tournaments'
import {
  Attention,
  AttentionRow,
  PRIMARY_LINK,
  ROW_BUTTON,
  ROW_BUTTON_ACCENT,
  SECONDARY_LINK,
} from '../../../_ui'
import { Draw, type CategoryView, type MatchView } from '../draw'
import { Fixes, type ShortenView, type WithdrawView } from '../fixes'
import { offersForFreeCourts } from '../suggestions'
import { placeMatch } from '../board/actions'
import { resumeDayAction } from '../actions'

/**
 * The tournament page — SPEC A2/A3/A7.
 *
 * It was 7,571px on a 390px phone: three standings tables, then all thirty-nine
 * matches round by round, then every player. A data dump answers no question
 * the organiser actually has, and it buries the two rows that need them.
 *
 * The order below is the order the questions arrive in:
 *
 *   1. What needs me right now?      → the attention block, with the button on it
 *   2. Will the day finish?          → the estimate, against sunset
 *   3. Something's gone wrong        → the escape hatch, three taps from here
 *   4. Reference                     → tables and the draw, when asked for
 *
 * Nothing is hidden: every match and every player is still in the document,
 * behind a `details`, so find-in-page reaches them.
 */

/**
 * Three of these screens live in three tabs on tournament morning. Sharing one
 * document title made the tab strip, the back button and browser history
 * useless (WCAG 2.4.2), so the distinguishing word goes first — a tab label
 * truncates from the right.
 */
export async function generateMetadata(props: PageProps<'/admin/t/[slug]/more'>) {
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  return {
    title: tournament ? `${tournament.name} · Madras Pickleball` : 'Tournament · Madras Pickleball',
  }
}

export const dynamic = 'force-dynamic'

/** One row of the attention block, already rendered, with a key to put it under. */
type Item = { key: string; node: React.ReactElement }

/**
 * The three shapes a match can be shortened to, in the order they cost time.
 * `minutesPerMatch` decides which of them is actually shorter than what a
 * category is playing now — never a hardcoded ranking, or the two would drift.
 */
const SHORTER_SHAPES = [
  { bestOf: 3, pointsToWin: 11 },
  { bestOf: 1, pointsToWin: 15 },
  { bestOf: 1, pointsToWin: 11 },
]

const shapeLabel = (bestOf: number, pointsToWin: number) =>
  bestOf === 1 ? `One game to ${pointsToWin}` : `Best of ${bestOf} to ${pointsToWin}`

export default async function TournamentPage(props: PageProps<'/admin/t/[slug]/more'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const { err, fix } = await props.searchParams

  const tournament = await getTournamentBySlug(slug)
  if (!tournament) notFound()

  const [cats, roster, allMatches, names, scores, board, registrations, subTeams] =
    await Promise.all([
      listCategories(tournament.id),
      listTournamentPlayers(tournament.id),
      listMatches(tournament.id),
      teamNameMap(tournament.id),
      gamesByMatch(tournament.id),
      boardData(tournament.id),
      listPendingRegistrations(tournament.id),
      substitutionOptions(tournament.id),
    ])
  const tables = await Promise.all(cats.map((c) => standingsFor(c.id)))

  const status = statusWords(tournament.status)
  const courtName = new Map(board.courts.map((c) => [c.id, c.name]))

  const played = allMatches.length - board.remaining
  const notStarted = played === 0 && board.liveCount === 0
  const finished = allMatches.length > 0 && board.remaining === 0

  // ── what needs the organiser, most urgent first ────────────────────────────

  const disputed = allMatches.filter((m) => m.resultState === 'disputed')
  const overrun = board.courts.filter((c) => c.live && c.live.overrunMinutes !== null)
  const freeCourts = board.courts.filter((c) => !c.closed && !c.live)
  const onCourt = board.courts.filter((c) => c.live)
  const offers = offersForFreeCourts(board)
  const waitingSignups = registrations.filter((r) => r.status === 'pending')

  const items: Item[] = []

  for (const m of disputed) {
    items.push({
      key: `d-${m.id}`,
      node: (
        <AttentionRow
          tone="alert"
          what="Two sides gave different scores"
          where={`${names.get(m.teamAId ?? '') ?? '—'} v ${names.get(m.teamBId ?? '') ?? '—'}`}
          action={
            <Link href={`/admin/m/${m.id}`} className={`${ROW_BUTTON} w-full sm:w-auto`}>
              Settle it
            </Link>
          }
        />
      ),
    })
  }

  for (const c of overrun) {
    const live = c.live!
    items.push({
      key: `o-${live.id}`,
      node: (
        <AttentionRow
          tone="alert"
          what={`${c.name} — on for ${live.overrunMinutes} min, no score`}
          where={`${live.nameA} v ${live.nameB}`}
          action={
            <Link href={`/admin/m/${live.id}`} className={`${ROW_BUTTON} w-full sm:w-auto`}>
              Enter it for them
            </Link>
          }
        />
      ),
    })
  }

  // Ranked by consequence, and edited. A stuck or wrong match comes before an
  // empty court: the first two rows are things nobody else will notice, the
  // third is something the board shows at a glance anyway.
  //
  // The free courts collapse to ONE row. Two full-terracotta buttons made
  // filling a court the loudest thing on a screen whose first row was a
  // disputed result, and sending a pair out is one tap per court either way —
  // the page re-renders and offers the next court.
  if (board.remaining > 0) {
    const offered = freeCourts.filter((c) => offers.has(c.id))
    const first = offered[0]

    if (first) {
      const offer = offers.get(first.id)!
      const idle = first.freeSinceMinutes !== null && first.freeSinceMinutes > 0
      items.push({
        key: 'free',
        node: (
          <AttentionRow
            tone="accent"
            what={
              offered.length > 1
                ? `${offered.length} courts free`
                : idle
                  ? `${first.name} has been empty ${first.freeSinceMinutes} min`
                  : `${first.name} is free`
            }
            where={`${notStarted ? 'First on' : 'Next up'}: ${offer.nameA} v ${offer.nameB}`}
            action={
              <form action={placeMatch}>
                <input type="hidden" name="matchId" value={offer.id} />
                <input type="hidden" name="courtId" value={first.id} />
                <input type="hidden" name="slug" value={slug} />
                <button className={`${ROW_BUTTON_ACCENT} w-full sm:w-auto`}>
                  Send to {first.name} →
                </button>
              </form>
            }
          />
        ),
      })
    } else if (freeCourts.length && board.liveCount > 0) {
      // Every free court is blocked by the same thing, so it is one row, not
      // one per court.
      items.push({
        key: 'stuck',
        node: (
          <AttentionRow
            tone="waiting"
            what={
              freeCourts.length === 1
                ? `${freeCourts[0].name} is free, nothing can start on it`
                : `${freeCourts.length} courts free, nothing can start on them`
            }
            where="Everyone who could play next is already on a court."
            action={
              <Link href={`/admin/t/${slug}/board`} className={SECONDARY_LINK}>
                Board
              </Link>
            }
          />
        ),
      })
    }
  }

  if (waitingSignups.length) {
    items.push({
      key: 'signups',
      node: (
        <AttentionRow
          tone="waiting"
          what={`${waitingSignups.length} ${waitingSignups.length === 1 ? 'person is' : 'people are'} waiting to be let in`}
          where={waitingSignups
            .slice(0, 3)
            .map((r) => r.name)
            .join(', ')}
          action={
            <Link href={`/admin/t/${slug}/registration`} className={SECONDARY_LINK}>
              Look
            </Link>
          }
        />
      ),
    })
  }

  // Four is what fits above the fold. The rest are on the board, which the
  // button under this block goes to.
  const shown = items.slice(0, 4)
  const hidden = items.length - shown.length

  // ── the reference half ─────────────────────────────────────────────────────

  const stateOf = (m: (typeof allMatches)[number]): { state: Status; label: string } => {
    if (m.status === 'live') return { state: 'live', label: 'Live' }
    if (m.resultState === 'disputed') return { state: 'alert', label: 'Under review' }
    if (m.resultState === 'reported') return { state: 'waiting', label: 'Not confirmed' }
    if (m.resultState === 'final') return { state: 'done', label: 'Final' }
    if (m.status === 'ready') return { state: 'ready', label: 'Ready' }
    return { state: 'waiting', label: 'Waiting' }
  }

  const toMatchView = (m: (typeof allMatches)[number]): MatchView => {
    const hasScore = m.resultState === 'final' || m.resultState === 'reported'
    const gs = scores.get(m.id) ?? []
    const s = stateOf(m)
    return {
      id: m.id,
      roundName: m.roundName ?? '',
      nameA: m.teamAId ? (names.get(m.teamAId) ?? null) : null,
      nameB: m.teamBId ? (names.get(m.teamBId) ?? null) : null,
      gamesWonA: m.gamesWonA,
      gamesWonB: m.gamesWonB,
      winnerSide: m.winnerTeamId === m.teamAId ? 'A' : m.winnerTeamId === m.teamBId ? 'B' : null,
      hasScore,
      state: s.state,
      stateLabel: s.label,
      scoreLine: gs.length ? gs.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ') : undefined,
      courtName: m.status === 'live' && m.courtId ? (courtName.get(m.courtId) ?? undefined) : undefined,
    }
  }

  const views: CategoryView[] = cats.map((category, i) => {
    const table = tables[i]
    const catMatches = allMatches.filter((m) => m.categoryId === category.id)
    const rows = table.rows
    return {
      id: category.id,
      name: category.name,
      advance: category.finalsStage === 'none' ? 0 : category.advancePerGroup,
      finalsStage: category.finalsStage,
      teams: table.teams.length,
      played: catMatches.filter((m) => m.resultState !== 'none').length,
      total: catMatches.length,
      rows: rows.map((r) => ({
        teamId: r.teamId,
        name: names.get(r.teamId) ?? '—',
        played: r.played,
        won: r.won,
        pointsFor: r.pointsFor,
        provisional: r.provisional,
        disputed: r.disputed,
        // Passed through untouched: the caption is the engine's own answer to
        // "what put this pair here", and rebuilding it from the columns names
        // the wrong rule (see `positionNote` in draw.tsx).
        reason: r.reason,
      })),
      matches: catMatches.map(toMatchView),
    }
  })

  // The forty-word tiebreak paragraph was printed once per category. Once.
  const tiebreakNotes = [...new Set(tables.map((t) => tiebreakNote(t.rule)))]

  // Newest first: a score that needs correcting was almost always just entered.
  // A match scored on paper never went on court and has no `startedAt`, so
  // those keep draw order at the bottom rather than jumping to the top.
  const withResults = allMatches
    .filter((m) => m.resultState !== 'none')
    .map((m, i) => ({ m, i }))
    .sort((x, y) => {
      const tx = x.m.startedAt ? new Date(x.m.startedAt).getTime() : -1
      const ty = y.m.startedAt ? new Date(y.m.startedAt).getTime() : -1
      return ty - tx || y.i - x.i
    })
    .map((r) => toMatchView(r.m))

  const closedCourts = board.courts.filter((c) => c.closed)

  // ── what the emergency tools would cost (SPEC A7) ──────────────────────────

  const everyTeam = cats.flatMap((c, i) =>
    tables[i].teams.map((t) => ({ ...t, categoryId: c.id, categoryName: c.name })),
  )
  // The engine's own answer, not one rebuilt from the match list: the number in
  // the confirm has to be the number the write acts on. They go out together,
  // so this is two round trips rather than two per pair.
  const effects = await Promise.all(everyTeam.map((t) => withdrawalEffect(t.id)))
  const withdrawals: WithdrawView[] = everyTeam.map((t, i) => {
    const e = effects[i]
    // `vacates` is a count; the sentence wants the round's name, and the match
    // list already on this page has it. The engine still owns whether the
    // clause is said at all.
    const vacatesRounds = allMatches
      .filter(
        (m) =>
          m.categoryId === t.categoryId &&
          m.resultState === 'none' &&
          m.status !== 'live' &&
          (m.teamAId === t.id || m.teamBId === t.id) &&
          !(m.teamAId && m.teamBId),
      )
      .map((m) => m.roundName)
      .filter((r): r is string => !!r)

    return {
      teamId: t.id,
      name: t.name,
      categoryName: t.categoryName,
      withdrawn: t.status === 'withdrawn',
      played: e?.played ?? 0,
      toWalkover: e?.toWalkover ?? 0,
      vacates: e?.vacates ?? 0,
      vacatesRounds,
      blockedBy: e?.blocked.length ? (e.blocked[0].roundName ?? 'A match of theirs') : null,
    }
  })

  // Shortening is reached for because of one number — when the day ends — so
  // every option carries that number rather than a format name. One `now` for
  // all of them, or three estimates taken a millisecond apart disagree.
  const now = new Date()
  const load = cats.map((c) => ({
    id: c.id,
    name: c.name,
    bestOf: c.bestOf,
    pointsToWin: c.pointsToWin,
    outstanding: allMatches.filter((m) => m.categoryId === c.id && m.resultState === 'none').length,
    live: allMatches.some((m) => m.categoryId === c.id && m.status === 'live'),
  }))
  const dayWith = (categoryId?: string, minutes?: number) =>
    estimateDay({
      categories: load.map((c) => ({
        name: c.name,
        matchCount: c.outstanding,
        minutesPerMatch: c.id === categoryId && minutes ? minutes : minutesPerMatch(c),
        minMatchesPerEntry: 0,
      })),
      courts: board.openCourts,
      startAt: now,
      sunsetAt: tournament.sunsetAt,
    })
  const baseline = dayWith()
  const shortenViews: ShortenView[] = load.map((c) => {
    const currentMinutes = minutesPerMatch(c)
    return {
      categoryId: c.id,
      name: c.name,
      currentLabel: shapeLabel(c.bestOf, c.pointsToWin),
      outstanding: c.outstanding,
      live: c.live,
      // Only what is actually shorter. Offering the format they are already
      // playing, or a longer one, is offering to make the problem worse.
      options: SHORTER_SHAPES.filter((s) => minutesPerMatch(s) < currentMinutes).map((s) => {
        const est = dayWith(c.id, minutesPerMatch(s))
        return {
          bestOf: s.bestOf,
          pointsToWin: s.pointsToWin,
          label: shapeLabel(s.bestOf, s.pointsToWin),
          finishAt: est.finishAt ? venueTime(est.finishAt) : null,
          savedMinutes: baseline.minutes - est.minutes,
        }
      }),
    }
  })

  return (
    <div className="flex flex-col gap-7">
      <header>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="font-score text-eyebrow text-accent uppercase">More</p>
          <StatusPill state={status.state}>{status.label}</StatusPill>
        </div>
        <h1 className="mt-1 text-title text-text">{tournament.name}</h1>
        <p className="num mt-1.5 text-meta text-text-3">
          {venueDate(tournament.startDate)} · {roster.length} player
          {roster.length === 1 ? '' : 's'} · {allMatches.length} match
          {allMatches.length === 1 ? '' : 'es'}
        </p>
      </header>

      {err ? (
        <Notice
          tone="alert"
          title="Not done"
          action={
            fix === 'board' ? (
              <Link href={`/admin/t/${slug}/board`} className={`${SECONDARY_LINK} w-full`}>
                Open the court board
              </Link>
            ) : fix === 'signups' ? (
              <Link href={`/admin/t/${slug}/registration`} className={`${SECONDARY_LINK} w-full`}>
                Open sign-ups
              </Link>
            ) : undefined
          }
        >
          {String(err)}
        </Notice>
      ) : null}

      {/* Everybody's phone says this too, so it is the first thing on the page
          — a stopped day that only the organiser knows about is worse than no
          pause at all. */}
      {tournament.pauseNote ? (
        <Notice
          tone="waiting"
          title="The day is stopped"
          detail="The public page is showing this, so nobody is staring at a board that has not moved."
          action={
            <form action={resumeDayAction}>
              <input type="hidden" name="slug" value={slug} />
              <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                Start the day again
              </button>
            </form>
          }
        >
          {tournament.pauseNote}
        </Notice>
      ) : null}

      <Attention count={shown.length}>
        {shown.map((i) => (
          <Fragment key={i.key}>{i.node}</Fragment>
        ))}
      </Attention>
      {hidden > 0 ? (
        <p className="-mt-4 text-meta text-text-2">
          {hidden} more waiting on the court board.
        </p>
      ) : null}

      {/* ── who is playing, right now ────────────────────────────────────
          This page is where the organiser lands, and until now a live match
          only appeared on it when something was WRONG with it. "Who is on
          court" is the first question anyone asks and it was only answerable
          from the board. */}
      {onCourt.length ? (
        <section className="flex flex-col gap-3">
          <SectionHead title="On court now" meta="tap one to put the score in" />
          <Panel>
            <ul className="divide-y divide-line">
              {onCourt.map((c) => (
                <li key={c.id}>
                  <Link
                    href={`/admin/m/${c.live!.id}`}
                    className="flex items-center gap-3 px-4"
                  >
                    <CourtSwatch colorKey={c.colorKey} size="md" />
                    <span className="min-w-0 flex-1 py-3">
                      {/* Stacked, not truncated: "Nithya Sundaram / Meera K…"
                          is the half of the name you need to tell two pairs
                          apart. */}
                      <TeamName name={c.live!.nameA} />
                      <span aria-hidden className="my-1 block h-px w-8 bg-line-strong" />
                      <TeamName name={c.live!.nameB} />
                      <span className="mt-1 block text-meta text-text-3">
                        {c.name} · {c.live!.categoryName}
                        {c.live!.roundName ? ` · ${c.live!.roundName}` : ''}
                      </span>
                    </span>
                    {c.live!.overrunMinutes !== null ? (
                      <StatusPill state="waiting">{c.live!.overrunMinutes} min</StatusPill>
                    ) : (
                      <StatusPill state="live">Live</StatusPill>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}

      {/* ── will the day finish? ─────────────────────────────────────────── */}
      {allMatches.length > 0 ? (
        <section className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <p className="font-score text-eyebrow text-text-2 uppercase">
                {finished ? 'The day is done' : notStarted ? 'If you start now' : 'Finishing about'}
              </p>
              <p
                className={clsx(
                  'num mt-1 text-hero',
                  board.pastSunset ? 'text-alert' : 'text-text',
                )}
              >
                {finished
                  ? `All ${allMatches.length} played`
                  : board.finishAt
                    ? venueTime(board.finishAt)
                    : formatDuration(board.finishEstimateMinutes)}
              </p>
            </div>
            {board.liveCount > 0 ? (
              <StatusPill state="live">
                {board.liveCount} on court
              </StatusPill>
            ) : null}
          </div>

          <div className="mt-3">
            <Meter
              done={played}
              total={allMatches.length}
              label={`${played} of ${allMatches.length} matches played`}
            />
          </div>
          <p className="num mt-2 text-meta text-text-2">
            {played} of {allMatches.length} played · {board.openCourts} court
            {board.openCourts === 1 ? '' : 's'} · {board.remaining} to play
          </p>

          {board.pastSunset ? (
            <p className="mt-3 rounded-control bg-alert-soft px-3.5 py-3 text-body font-medium text-alert">
              That is after sunset. Drop a stage or take a category out — nothing else moves this
              number.
            </p>
          ) : null}

          {closedCourts.length ? (
            <p className="mt-3 text-meta text-waiting">
              {closedCourts.map((c) => `${c.name} — ${c.closedReason}`).join(' · ')}. The estimate
              already assumes {board.openCourts} court{board.openCourts === 1 ? '' : 's'}.
            </p>
          ) : null}
        </section>
      ) : null}

      {/* ── where you go from here ───────────────────────────────────────── */}
      <nav className="flex flex-col gap-2">
        <Link href={`/admin/t/${slug}/board`} className={PRIMARY_LINK}>
          Court board
        </Link>
        <div className="grid grid-cols-2 gap-2">
          <Link href={`/admin/t/${slug}/results`} className={SECONDARY_LINK}>
            Results desk
          </Link>
          <Link href={`/admin/t/${slug}/registration`} className={SECONDARY_LINK}>
            Sign-ups
            {waitingSignups.length ? ` (${waitingSignups.length})` : ''}
          </Link>
          <Link href={`/t/${slug}`} className={SECONDARY_LINK}>
            Public page
          </Link>
        </div>
      </nav>

      {/* ── nothing to run yet ───────────────────────────────────────────── */}
      {cats.length === 0 ? (
        <EmptyState tone="accent" title="Nothing to play in yet">
          <p>
            This tournament has no categories. Quick Play makes the category, the pairs and the draw
            in one go — it takes about ninety seconds.
          </p>
          <Link href="/admin/new" className={clsx(SECONDARY_LINK, 'mt-3 max-w-[16rem]')}>
            Make a new one
          </Link>
        </EmptyState>
      ) : null}

      {roster.length === 0 && cats.length > 0 ? (
        <EmptyState title="Nobody is on the roster">
          <p>Share the sign-up link, or paste the list from the group chat.</p>
          <Link href={`/admin/t/${slug}/registration`} className={clsx(SECONDARY_LINK, 'mt-3 max-w-[16rem]')}>
            Open sign-ups
          </Link>
        </EmptyState>
      ) : null}

      {/* ── the escape hatch (SPEC A7) ───────────────────────────────────── */}
      <Fixes
        slug={slug}
        withResults={withResults}
        courts={board.courts}
        openCourts={board.openCourts}
        withdrawals={withdrawals}
        subTeams={subTeams}
        roster={roster}
        shorten={shortenViews}
        paused={!!tournament.pauseNote}
      />

      {/* ── reference ────────────────────────────────────────────────────── */}
      {cats.length > 0 ? (
        <Draw categories={views} slug={slug} tiebreakNotes={tiebreakNotes} />
      ) : null}

      {roster.length > 0 ? (
        <Disclosure summary="Everyone playing today" meta={`${roster.length} on the roster`}>
          <Panel>
            <ul className="grid grid-cols-2 divide-y divide-line">
              {roster.map((p) => (
                <li key={p.id} className="flex min-h-[56px] items-center px-4 text-row text-text">
                  <span className="truncate">{p.name}</span>
                </li>
              ))}
            </ul>
          </Panel>
        </Disclosure>
      ) : null}
    </div>
  )
}
