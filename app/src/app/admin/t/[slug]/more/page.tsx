import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Card, Chevron, Notice } from '@/components/ui'
import { estimateDay, minutesPerMatch } from '@/lib/estimate'
import { venueTime } from '@/lib/time'
import { substitutionOptions, withdrawalEffect } from '@/server/chaos'
import { myCourts, primaryCategory } from '@/server/events'
import {
  gamesByMatch,
  getTournamentBySlug,
  listMatches,
  listTeams,
  listTournamentPlayers,
  teamNameMap,
} from '@/server/tournaments'
import { SECONDARY_LINK } from '../../../_ui'
import {
  DeleteTournament,
  FixScore,
  Pause,
  Shorten,
  Swap,
  Withdraw,
  type PlayedMatch,
  type ShortenView,
  type WithdrawDetail,
  type WithdrawRow,
} from '../fixes'

/**
 * More — everything administrative, in one list, off the main path. Each row
 * says what it will do before it does it, and all of it is reversible and
 * logged. The delete is in its own card at the bottom.
 *
 * Each row opens on this same page (`?do=`), so a sub-screen is one query
 * string away and the back link is always "‹ More".
 */
export async function generateMetadata(props: PageProps<'/admin/t/[slug]/more'>) {
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  return { title: tournament ? `More · ${tournament.name}` : 'More · Madras Pickleball' }
}

export const dynamic = 'force-dynamic'

type View = 'fix' | 'withdraw' | 'swap' | 'shorten' | 'pause' | 'delete'
const VIEWS: Record<View, string> = {
  fix: 'Fix a score',
  withdraw: 'Who’s pulled out?',
  swap: 'Swap a player',
  shorten: 'Shorten what’s left',
  pause: 'Pause the tournament',
  delete: 'Delete this tournament',
}

/**
 * The three shapes a match can be shortened to, in the order they cost time.
 * `minutesPerMatch` decides which of them is actually shorter than what is
 * being played now — never a hardcoded ranking, or the two would drift.
 */
const SHORTER_SHAPES = [
  { bestOf: 3, pointsToWin: 11 },
  { bestOf: 1, pointsToWin: 15 },
  { bestOf: 1, pointsToWin: 11 },
]
const shapeLabel = (bestOf: number, pointsToWin: number) =>
  bestOf === 1 ? `One game to ${pointsToWin}` : `Best of ${bestOf} to ${pointsToWin}`

export default async function MorePage(props: PageProps<'/admin/t/[slug]/more'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const q = await props.searchParams
  const view = (typeof q.do === 'string' && q.do in VIEWS ? q.do : null) as View | null
  const teamParam = typeof q.team === 'string' ? q.team : null

  const t = await getTournamentBySlug(slug)
  if (!t) notFound()
  const category = await primaryCategory(t.id)
  const base = `/admin/t/${slug}`
  const more = `${base}/more`
  const unit = category.discipline === 'doubles' ? 'pair' : 'player'

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href={(view ? more : base) as never}
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          {view ? 'More' : t.name}
        </Link>
        <h1 className="mt-1 text-title text-text">{view ? VIEWS[view] : 'More'}</h1>
        {view ? null : <p className="mt-1 text-meta text-text-3">{t.name}</p>}
      </header>

      {q.err ? (
        <Notice
          tone="alert"
          title="Not done"
          action={
            q.fix === 'board' ? (
              <Link href={"/admin/live" as never} className={`${SECONDARY_LINK} w-full`}>
                Open the live board
              </Link>
            ) : q.fix === 'signups' ? (
              <Link href={`${base}/registration` as never} className={`${SECONDARY_LINK} w-full`}>
                Add the player first
              </Link>
            ) : undefined
          }
        >
          {String(q.err)}
        </Notice>
      ) : null}
      {q.done ? <Notice tone="done">{String(q.done)}</Notice> : null}

      {view === null ? (
        <MoreList base={base} more={more} paused={!!t.pauseNote} unit={unit} phase={t.status} />
      ) : view === 'fix' ? (
        <FixScore played={await playedMatches(t.id)} />
      ) : view === 'withdraw' ? (
        <WithdrawData slug={slug} categoryId={category.id} teamParam={teamParam} unit={unit} />
      ) : view === 'swap' ? (
        <SwapData slug={slug} tournamentId={t.id} />
      ) : view === 'shorten' ? (
        <Shorten
          slug={slug}
          view={await shortenView(t.id, {
            id: category.id,
            bestOf: category.bestOf,
            pointsToWin: category.pointsToWin,
            sunsetAt: t.sunsetAt,
          })}
        />
      ) : view === 'pause' ? (
        <Pause slug={slug} pauseNote={t.pauseNote} />
      ) : (
        <DeleteData slug={slug} tournamentId={t.id} name={t.name} />
      )}
    </div>
  )
}

// ───────────────────────────── the list ─────────────────────────────

function MoreList({
  base,
  more,
  paused,
  unit,
  phase,
}: {
  base: string
  more: string
  paused: boolean
  unit: 'pair' | 'player'
  phase: string
}) {
  const finished = phase === 'completed' || phase === 'archived'
  const running = phase === 'live'
  // A finished tournament has nothing left to pause, shorten or reorder;
  // one that has not started has no scores to fix.
  const rows: Array<{ label: string; href: string; when?: boolean }> = [
    { label: 'Fix a score that’s already in', href: `${more}?do=fix`, when: running || finished },
    { label: `A ${unit} has pulled out`, href: `${more}?do=withdraw`, when: !finished },
    { label: 'Swap a player', href: `${more}?do=swap`, when: !finished },
    { label: 'Change the courts', href: `${base}/schedule`, when: !finished },
    { label: 'Change the order of play', href: `${base}/schedule`, when: !finished },
    { label: 'Shorten what’s left', href: `${more}?do=shorten`, when: running },
    { label: paused ? 'Start again' : 'Pause the tournament', href: `${more}?do=pause`, when: running },
    { label: 'Add or remove players', href: `${base}/registration`, when: !finished },
  ].filter((r) => r.when !== false)
  return (
    <>
      <Card>
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.label}>
              <Link href={r.href as never} className="tap-lg flex items-center gap-3 px-4">
                <span className="min-w-0 flex-1 text-row text-text">{r.label}</span>
                <span aria-hidden className="text-text-3">
                  <Chevron className="-rotate-90" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
      <Card>
        <Link href={`${more}?do=delete` as never} className="tap-lg flex items-center gap-3 px-4">
          <span className="min-w-0 flex-1 text-row text-text">Delete this tournament</span>
          <span aria-hidden className="text-alert">
            <Chevron className="-rotate-90" />
          </span>
        </Link>
      </Card>
      <Link
        href={'/admin/live' as never}
        className="tap flex items-center justify-center px-3 text-[16px] font-semibold text-link"
      >
        Live board
      </Link>
    </>
  )
}

// ───────────────────────────── the data behind each screen ─────────────────────────────

/** Newest first: a score that needs correcting was almost always just entered. */
async function playedMatches(tournamentId: string): Promise<PlayedMatch[]> {
  const [all, names, scores] = await Promise.all([
    listMatches(tournamentId),
    teamNameMap(tournamentId),
    gamesByMatch(tournamentId),
  ])
  return all
    .filter((m) => m.resultState === 'final' || m.resultState === 'reported')
    .map((m, i) => ({ m, i }))
    .sort((x, y) => {
      const tx = x.m.startedAt ? new Date(x.m.startedAt).getTime() : -1
      const ty = y.m.startedAt ? new Date(y.m.startedAt).getTime() : -1
      return ty - tx || y.i - x.i
    })
    .map(({ m }) => {
      const aWon = m.winnerTeamId === m.teamAId
      const gs = scores.get(m.id) ?? []
      return {
        id: m.id,
        roundName: m.roundName,
        winner: names.get((aWon ? m.teamAId : m.teamBId) ?? '') ?? '—',
        loser: names.get((aWon ? m.teamBId : m.teamAId) ?? '') ?? '—',
        games: `${aWon ? m.gamesWonA : m.gamesWonB}–${aWon ? m.gamesWonB : m.gamesWonA}`,
        scoreLine: gs
          .map((g) => (aWon ? `${g.scoreA}–${g.scoreB}` : `${g.scoreB}–${g.scoreA}`))
          .join(', '),
        walkover: m.resultType === 'walkover',
      }
    })
}

async function WithdrawData({
  slug,
  categoryId,
  teamParam,
  unit,
}: {
  slug: string
  categoryId: string
  teamParam: string | null
  unit: 'pair' | 'player'
}) {
  const teams = await listTeams(categoryId)
  const rows: WithdrawRow[] = teams.map((t) => ({
    teamId: t.id,
    name: t.name,
    players: [],
    withdrawn: t.status === 'withdrawn',
  }))
  // The engine's own answer, not one rebuilt from the match list: the number
  // in the confirm has to be the number the write acts on.
  const picked = teams.find((t) => t.id === teamParam)
  const effect = picked ? await withdrawalEffect(picked.id) : null
  const selected: WithdrawDetail | null =
    picked && effect
      ? {
          teamId: picked.id,
          name: picked.name,
          withdrawn: picked.status === 'withdrawn',
          played: effect.played,
          toWalkover: effect.toWalkover,
          vacates: effect.vacates,
          blockedBy: effect.blocked.length ? (effect.blocked[0].roundName ?? 'A match of theirs') : null,
        }
      : null
  return <Withdraw slug={slug} rows={rows} selected={selected} unit={unit} />
}

async function SwapData({ slug, tournamentId }: { slug: string; tournamentId: string }) {
  const [teams, roster] = await Promise.all([
    substitutionOptions(tournamentId),
    listTournamentPlayers(tournamentId),
  ])
  // Only people not already in a pair can step in — a name from another
  // pair would put one person on two sides of the draw.
  const inAPair = new Set(teams.flatMap((t) => t.members.map((m) => m.id)))
  return (
    <Swap
      slug={slug}
      teams={teams}
      roster={roster
        .filter((p) => !p.withdrawn && !inAPair.has(p.id))
        .map((p) => ({ id: p.id, name: p.name }))}
    />
  )
}

/**
 * Shortening is reached for because of one number — when the day ends — so
 * every option carries that number rather than a format name.
 */
async function shortenView(
  tournamentId: string,
  category: { id: string; bestOf: number; pointsToWin: number; sunsetAt: Date | null },
): Promise<ShortenView> {
  const [all, courts] = await Promise.all([listMatches(tournamentId), myCourts(tournamentId)])
  const outstanding = all.filter((m) => m.resultState === 'none' && m.status !== 'cancelled').length
  const live = all.some((m) => m.status === 'live')
  const now = new Date()
  const dayWith = (minutes: number) =>
    estimateDay({
      categories: [{ name: '', matchCount: outstanding, minutesPerMatch: minutes, minMatchesPerEntry: 0 }],
      courts: courts.length,
      startAt: now,
      sunsetAt: category.sunsetAt,
    })
  const currentMinutes = minutesPerMatch(category)
  const baseline = dayWith(currentMinutes)
  return {
    categoryId: category.id,
    currentLabel: shapeLabel(category.bestOf, category.pointsToWin),
    outstanding,
    live,
    // Only what is actually shorter. Offering the format they are already
    // playing, or a longer one, is offering to make the problem worse.
    options: SHORTER_SHAPES.filter((s) => minutesPerMatch(s) < currentMinutes).map((s) => {
      const est = dayWith(minutesPerMatch(s))
      return {
        bestOf: s.bestOf,
        pointsToWin: s.pointsToWin,
        label: shapeLabel(s.bestOf, s.pointsToWin),
        finishAt: est.finishAt ? venueTime(est.finishAt) : null,
        savedMinutes: baseline.minutes - est.minutes,
      }
    }),
  }
}

async function DeleteData({
  slug,
  tournamentId,
  name,
}: {
  slug: string
  tournamentId: string
  name: string
}) {
  const [players, all, courts] = await Promise.all([
    listTournamentPlayers(tournamentId),
    listMatches(tournamentId),
    myCourts(tournamentId),
  ])
  const live = all.find((m) => m.status === 'live')
  const liveOn = live ? (courts.find((c) => c.id === live.courtId)?.name ?? 'a court') : null
  return (
    <DeleteTournament
      slug={slug}
      name={name}
      players={players.length}
      matches={all.length}
      courts={courts.map((c) => c.name)}
      liveOn={liveOn}
    />
  )
}
