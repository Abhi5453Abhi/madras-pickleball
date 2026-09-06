import { Fragment } from 'react'
import { clsx } from 'clsx'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import {
  CourtSwatch,
  Disclosure,
  EmptyState,
  Notice,
  Panel,
  SectionHead,
  StatusPill,
  TeamName,
  statusWords,
  type Status,
} from '@/components/ui'
import { formatDuration, venueDate, venueTime } from '@/lib/time'
import { tiebreakNote } from '@/lib/standings'
import { boardData } from '@/server/board'
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
  Confirm,
  Meter,
  PRIMARY_LINK,
  ROW_BUTTON,
  ROW_BUTTON_ACCENT,
  SECONDARY_LINK,
} from '../../_ui'
import { Draw, type CategoryView, type MatchView } from './draw'
import { offersForFreeCourts } from './suggestions'
import { placeMatch } from './board/actions'
import { setCourtClosed } from './actions'

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
export const dynamic = 'force-dynamic'

/** One row of the attention block, already rendered, with a key to put it under. */
type Item = { key: string; node: React.ReactElement }

export default async function TournamentPage(props: PageProps<'/admin/t/[slug]'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const { err } = await props.searchParams

  const tournament = await getTournamentBySlug(slug)
  if (!tournament) notFound()

  const [cats, roster, allMatches, names, scores, board, registrations] = await Promise.all([
    listCategories(tournament.id),
    listTournamentPlayers(tournament.id),
    listMatches(tournament.id),
    teamNameMap(tournament.id),
    gamesByMatch(tournament.id),
    boardData(tournament.id),
    listPendingRegistrations(tournament.id),
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

  // A finished day has four free courts and nothing to put on them; saying so
  // four times is the nag this block exists to replace.
  if (board.remaining > 0) {
    for (const c of freeCourts) {
      const offer = offers.get(c.id)
      if (!offer) continue
      const idle = c.freeSinceMinutes !== null && c.freeSinceMinutes > 0
      items.push({
        key: `f-${c.id}`,
        node: (
          <AttentionRow
            tone="accent"
            what={idle ? `${c.name} has been empty ${c.freeSinceMinutes} min` : `${c.name} is free`}
            where={`${offer.nameA} v ${offer.nameB}`}
            action={
              <form action={placeMatch}>
                <input type="hidden" name="matchId" value={offer.id} />
                <input type="hidden" name="courtId" value={c.id} />
                <input type="hidden" name="slug" value={slug} />
                <button className={`${ROW_BUTTON_ACCENT} w-full sm:w-auto`}>
                  Send to {c.name} →
                </button>
              </form>
            }
          />
        ),
      })
    }

    // ONE row for all the courts standing empty with nothing legal to put on
    // them, rather than one row each: the cause is the same for all of them and
    // so is the organiser's move.
    const stuck = freeCourts.filter((c) => !offers.has(c.id))
    if (stuck.length && board.liveCount > 0) {
      items.push({
        key: 'stuck',
        node: (
          <AttentionRow
            tone="waiting"
            what={
              stuck.length === 1
                ? `${stuck[0].name} is free, nothing can start on it`
                : `${stuck.length} courts free, nothing can start on them`
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
            <Link href={`/admin/t/${slug}/registrations`} className={SECONDARY_LINK}>
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
      rows: rows.map((r, idx) => ({
        teamId: r.teamId,
        name: names.get(r.teamId) ?? '—',
        played: r.played,
        won: r.won,
        pointsFor: r.pointsFor,
        provisional: r.provisional,
        disputed: r.disputed,
        // Read down the column, a pair on three wins from four sits above a
        // pair on three from five with more points scored — which looks like
        // the venue's headline rule being ignored. Where a neighbour is level
        // on wins, both rows say what their record is.
        levelOnWins:
          r.played > 0 && (rows[idx - 1]?.won === r.won || rows[idx + 1]?.won === r.won),
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

  return (
    <div className="flex flex-col gap-7">
      <header>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <p className="font-score text-eyebrow text-accent uppercase">Tournament</p>
          <StatusPill state={status.state}>{status.label}</StatusPill>
        </div>
        <h1 className="mt-1 text-title text-text">{tournament.name}</h1>
        <p className="num mt-1.5 text-meta text-text-3">
          {venueDate(tournament.startDate)} · {roster.length} player
          {roster.length === 1 ? '' : 's'} · {allMatches.length} match
          {allMatches.length === 1 ? '' : 'es'}
        </p>
      </header>

      {err ? <Notice>{String(err)}</Notice> : null}

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
            <Meter done={played} total={allMatches.length} />
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
          <Link href={`/admin/t/${slug}/registrations`} className={SECONDARY_LINK}>
            Sign-ups
            {waitingSignups.length ? ` (${waitingSignups.length})` : ''}
          </Link>
          <Link href={`/admin/t/${slug}/cards`} className={SECONDARY_LINK}>
            Court cards
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
          <Link href="/admin/quick" className={clsx(SECONDARY_LINK, 'mt-3 max-w-[16rem]')}>
            Start one
          </Link>
        </EmptyState>
      ) : null}

      {roster.length === 0 && cats.length > 0 ? (
        <EmptyState title="Nobody is on the roster">
          <p>Share the sign-up link, or paste the list from the group chat.</p>
          <Link href={`/admin/t/${slug}/registrations`} className={clsx(SECONDARY_LINK, 'mt-3 max-w-[16rem]')}>
            Open sign-ups
          </Link>
        </EmptyState>
      ) : null}

      {/* ── the escape hatch (SPEC A7) ───────────────────────────────────── */}
      <section className="flex flex-col gap-3">
        <SectionHead
          title="If something's gone wrong"
          meta="All of it is reversible, and all of it goes in the log with your name on it."
        />

        <Disclosure
          summary="Change a score that's already in"
          meta={
            withResults.length
              ? `${withResults.length} entered · newest first`
              : 'Nothing has a score yet'
          }
        >
          {withResults.length ? (
            <Panel>
              <ul className="divide-y divide-line">
                {withResults.slice(0, 20).map((m) => (
                  <li key={m.id}>
                    <Link href={`/admin/m/${m.id}`} className="block hover:bg-ground">
                      <MatchLine m={m} />
                    </Link>
                  </li>
                ))}
              </ul>
              {withResults.length > 20 ? (
                <p className="border-t border-line bg-sunken px-4 py-3 text-meta text-text-2">
                  The oldest {withResults.length - 20} are under “Show the draw” in their category.
                </p>
              ) : null}
            </Panel>
          ) : (
            <p className="rounded-card border border-line-strong bg-paper px-4 py-4 text-body text-text-2">
              When a score is wrong, it turns up here the moment it is entered.
            </p>
          )}
        </Disclosure>

        <Disclosure
          summary="Take a court out of action"
          meta={
            closedCourts.length
              ? `${closedCourts.length} closed right now`
              : `${board.openCourts} court${board.openCourts === 1 ? '' : 's'} in use`
          }
        >
          <Panel>
            <ul className="divide-y divide-line">
              {board.courts.map((c) => {
                const leftOpen = board.openCourts - 1
                const leftLabel =
                  leftOpen <= 0
                    ? 'Nothing else is open, so the day stops until a court comes back.'
                    : `The finish estimate recomputes on ${leftOpen} court${leftOpen === 1 ? '' : 's'}.`
                return (
                  <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="flex min-w-[7rem] flex-1 items-center gap-2">
                      <CourtSwatch colorKey={c.colorKey} />
                      <span className="text-row text-text">{c.name}</span>
                      {c.closed ? (
                        <span className="text-meta text-waiting">{c.closedReason}</span>
                      ) : null}
                    </span>
                    {c.closed ? (
                      <form action={setCourtClosed} className="ml-auto">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="courtId" value={c.id} />
                        <input type="hidden" name="close" value="0" />
                        <button className="tap rounded-control border border-line-strong bg-paper px-4 text-[16px] font-semibold text-text">
                          Back in action
                        </button>
                      </form>
                    ) : (
                      <Confirm
                        className="ml-auto [&[open]]:w-full"
                        label="Close it"
                        question={
                          c.live
                            ? `${c.name} stops taking matches, and ${c.live.nameA} v ${c.live.nameB} comes off it with no score — nothing is lost, it goes back in the queue. ${leftLabel}`
                            : `${c.name} stops taking matches. ${leftLabel} You can put it back any time.`
                        }
                      >
                        <form action={setCourtClosed} className="flex flex-col gap-2">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="courtId" value={c.id} />
                          <input type="hidden" name="close" value="1" />
                          <input
                            name="reason"
                            defaultValue="Out of action"
                            aria-label={`Why ${c.name} is out of action`}
                            className="tap w-full rounded-control border border-line-strong bg-paper px-3.5 text-body text-text"
                          />
                          <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                            Take {c.name} out
                          </button>
                        </form>
                      </Confirm>
                    )}
                  </li>
                )
              })}
            </ul>
          </Panel>
        </Disclosure>

        <Link href={`/admin/t/${slug}/results`} className={SECONDARY_LINK}>
          Somebody didn’t turn up →
        </Link>
      </section>

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

/**
 * A result row inside the escape hatch. Deliberately not `MatchRow`: this list
 * is scanned for one specific match, so the round and the score carry it, and
 * the winner's emphasis would just be noise.
 */
function MatchLine({ m }: { m: MatchView }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <TeamName name={m.nameA} />
        <TeamName name={m.nameB} />
        <p className="mt-0.5 text-meta text-text-3">
          {m.roundName}
          {m.scoreLine ? ` · ${m.scoreLine}` : ''}
        </p>
      </div>
      <span className="num shrink-0 text-[22px] font-bold text-text">
        {m.gamesWonA}–{m.gamesWonB}
      </span>
    </div>
  )
}
