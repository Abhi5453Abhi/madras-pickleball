import type { FormEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import type { Output } from '@/api/contract'
import { useAction, useRpc } from '@/api/use-rpc'
import { Card, Chevron, Notice } from '@/components/ui'
import { SECONDARY_LINK } from '@/components/admin-ui'
import { estimateDay, minutesPerMatch } from '@/lib/estimate'
import { venueTime } from '@/lib/time'
import { Loading, LoadError, NotFoundCard, useTitle } from '@/lib/page'
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
} from './fixes'

type Tournament = Output<'tournaments.getTournamentBySlug'>

/**
 * More — everything administrative, in one list, off the main path. Each row
 * says what it will do before it does it, and all of it is reversible and
 * logged. The delete is in its own card at the bottom.
 *
 * Each row opens on this same page (`?do=`), so a sub-screen is one query
 * string away and the back link is always "‹ More".
 */
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

export function MorePage() {
  const { slug = '' } = useParams()
  const loaded = useRpc('tournaments.getTournamentBySlug', { slug })
  useTitle(loaded.state === 'ready' ? `More · ${loaded.data.name}` : 'More · Madras Pickleball')

  if (loaded.state === 'loading') return <Loading />
  if (loaded.state === 'missing') return <NotFoundCard />
  if (loaded.state !== 'ready') return <LoadError error={loaded.error} retry={() => void loaded.reload(false)} />
  return <More slug={slug} t={loaded.data} />
}

function More({ slug, t }: { slug: string; t: Tournament }) {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const raw = params.get('do')
  const view = (raw && raw in VIEWS ? raw : null) as View | null
  const teamParam = params.get('team')
  const base = `/admin/t/${slug}`
  const more = `${base}/more`
  const unit: 'pair' | 'player' = t.discipline === 'doubles' ? 'pair' : 'player'

  /**
   * A refusal with no next step is the stuck organiser this exists to prevent.
   * `fix` names where the thing that is blocking it can be dealt with, so the
   * message arrives with a button rather than as a dead end.
   */
  const refuse = (message: string, fix?: 'board' | 'signups') => {
    const q = new URLSearchParams({ err: message })
    if (fix) q.set('fix', fix)
    navigate(`${more}?${q}`)
  }
  /** Back to the list, with one sentence saying what just happened. */
  const done = (message: string) => navigate(`${more}?${new URLSearchParams({ done: message })}`)

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          to={view ? more : base}
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          {view ? 'More' : t.name}
        </Link>
        <h1 className="mt-1 text-title text-text">{view ? VIEWS[view] : 'More'}</h1>
      </header>

      {params.get('err') ? (
        <Notice
          tone="alert"
          title="Not done"
          action={
            params.get('fix') === 'board' ? (
              <Link to="/admin/live" className={`${SECONDARY_LINK} w-full`}>
                Open the live board
              </Link>
            ) : params.get('fix') === 'signups' ? (
              <Link to={`${base}/registration`} className={`${SECONDARY_LINK} w-full`}>
                Add the player first
              </Link>
            ) : undefined
          }
        >
          {params.get('err')}
        </Notice>
      ) : null}
      {params.get('done') ? <Notice tone="done">{params.get('done')}</Notice> : null}

      {view === null ? (
        <MoreList base={base} more={more} paused={!!t.pauseNote} unit={unit} phase={t.status} />
      ) : view === 'fix' ? (
        <FixScoreData tournamentId={t.id} />
      ) : view === 'withdraw' ? (
        <WithdrawData
          slug={slug}
          tournamentId={t.id}
          teamParam={teamParam}
          unit={unit}
          done={done}
          refuse={refuse}
        />
      ) : view === 'swap' ? (
        <SwapData slug={slug} tournamentId={t.id} done={done} refuse={refuse} />
      ) : view === 'shorten' ? (
        <ShortenData tournamentId={t.id} bestOf={t.bestOf} pointsToWin={t.pointsToWin} done={done} refuse={refuse} />
      ) : view === 'pause' ? (
        <PauseData tournamentId={t.id} pauseNote={t.pauseNote} done={done} />
      ) : (
        <DeleteData slug={slug} tournamentId={t.id} name={t.name} refuse={refuse} />
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
  const finished = phase === 'completed'
  const running = phase === 'live'
  // Only a running day needs any of this. Before the start, players, pairs
  // and courts are the steps on the tournament's own page; a pair that pulls
  // out is simply taken off the list — walkovers are for a day that is
  // already running. A finished tournament has nothing left but its scores.
  const rows: Array<{ label: string; href: string; when?: boolean }> = [
    { label: 'Fix a score that’s already in', href: `${more}?do=fix`, when: running || finished },
    { label: `A ${unit} has pulled out`, href: `${more}?do=withdraw`, when: running },
    { label: 'Swap a player', href: `${more}?do=swap`, when: running },
    { label: 'Change the courts', href: `${base}/schedule`, when: running },
    { label: 'Shorten what’s left', href: `${more}?do=shorten`, when: running },
    { label: paused ? 'Start again' : 'Pause the tournament', href: `${more}?do=pause`, when: running },
    { label: 'Add or remove players', href: `${base}/registration`, when: running },
  ].filter((r) => r.when !== false)
  return (
    <>
      {rows.length ? (
        <Card>
          <ul className="divide-y divide-line">
            {rows.map((r) => (
              <li key={r.label}>
                <Link to={r.href} className="tap-lg flex items-center gap-3 px-4">
                  <span className="min-w-0 flex-1 text-row text-text">{r.label}</span>
                  <span aria-hidden className="text-text-3">
                    <Chevron className="-rotate-90" />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
      <Card>
        <Link to={`${more}?do=delete`} className="tap-lg flex items-center gap-3 px-4">
          <span className="min-w-0 flex-1 text-row text-text">Delete this tournament</span>
          <span aria-hidden className="text-alert">
            <Chevron className="-rotate-90" />
          </span>
        </Link>
      </Card>
      {running ? (
        <Link
          to="/admin/live"
          className="tap flex items-center justify-center px-3 text-[16px] font-semibold text-link"
        >
          Live board
        </Link>
      ) : null}
    </>
  )
}

// ────────────────── the data behind each screen ──────────────────

type Done = (message: string) => void
type Refuse = (message: string, fix?: 'board' | 'signups') => void

/** Newest first: a score that needs correcting was almost always just entered. */
function FixScoreData({ tournamentId }: { tournamentId: string }) {
  const matches = useRpc('tournaments.listMatches', { tournamentId })
  const teamNames = useRpc('tournaments.teamNameMap', { tournamentId })
  const games = useRpc('tournaments.gamesByMatch', { tournamentId })

  if (matches.state === 'loading' || teamNames.state === 'loading' || games.state === 'loading') {
    return <Loading lines={2} />
  }
  if (matches.state !== 'ready' || teamNames.state !== 'ready' || games.state !== 'ready') {
    return <LoadError error="That didn’t load." retry={() => void matches.reload(false)} />
  }
  const names = teamNames.data
  const scores = games.data
  const played: PlayedMatch[] = matches.data
    .filter((m) => m.resultState === 'final')
    .map((m, i) => ({ m, i }))
    .sort((x, y) => {
      const tx = x.m.startedAt ? new Date(x.m.startedAt).getTime() : -1
      const ty = y.m.startedAt ? new Date(y.m.startedAt).getTime() : -1
      return ty - tx || y.i - x.i
    })
    .map(({ m }) => {
      const aWon = m.winnerTeamId === m.teamAId
      const gs = scores[m.id] ?? []
      return {
        id: m.id,
        roundName: m.roundName,
        winner: names[(aWon ? m.teamAId : m.teamBId) ?? ''] ?? '—',
        loser: names[(aWon ? m.teamBId : m.teamAId) ?? ''] ?? '—',
        games: `${aWon ? m.gamesWonA : m.gamesWonB}–${aWon ? m.gamesWonB : m.gamesWonA}`,
        scoreLine: gs.map((g) => (aWon ? `${g.scoreA}–${g.scoreB}` : `${g.scoreB}–${g.scoreA}`)).join(', '),
        walkover: m.resultType === 'walkover',
      }
    })
  return <FixScore played={played} />
}

function WithdrawData({
  slug,
  tournamentId,
  teamParam,
  unit,
  done,
  refuse,
}: {
  slug: string
  tournamentId: string
  teamParam: string | null
  unit: 'pair' | 'player'
  done: Done
  refuse: Refuse
}) {
  const teams = useRpc('tournaments.listTeams', { tournamentId })
  const { run } = useAction()

  if (teams.state === 'loading') return <Loading lines={2} />
  if (teams.state !== 'ready') return <LoadError error={teams.error} retry={() => void teams.reload(false)} />

  const rows = teams.data.map((t) => ({
    teamId: t.id,
    name: t.name,
    players: [] as string[],
    withdrawn: t.status === 'withdrawn',
  }))
  const picked = teams.data.find((t) => t.id === teamParam) ?? null

  async function withdraw(e: FormEvent<HTMLFormElement>, teamId: string) {
    e.preventDefault()
    const res = await run('chaos.withdrawTeam', { tournamentId, teamId })
    // `fix` only exists on the refusal the engine builds, not on the transport
    // one `useAction` synthesises, so it is read defensively.
    if (!res.ok) refuse(res.error, 'fix' in res ? res.fix : undefined)
    else done(res.note)
  }

  async function reinstate(e: FormEvent<HTMLFormElement>, teamId: string) {
    e.preventDefault()
    const res = await run('chaos.reinstateTeam', { tournamentId, teamId })
    if (!res.ok) refuse(res.error)
    else done(res.note)
  }

  const props = { slug, rows, unit, onWithdraw: withdraw, onReinstate: reinstate }
  // The effect is a whole component so it is not asked for until a pair has
  // been tapped: `withdrawalEffect` 404s without a team, and a screen that
  // 404s on arrival is a screen that logs a failure nobody caused.
  return picked ? (
    <WithdrawEffect {...props} tournamentId={tournamentId} picked={picked} />
  ) : (
    <Withdraw {...props} selected={null} />
  )
}

function WithdrawEffect({
  tournamentId,
  picked,
  ...props
}: {
  slug: string
  tournamentId: string
  picked: { id: string; name: string; status: 'active' | 'withdrawn' }
  rows: WithdrawRow[]
  unit: 'pair' | 'player'
  onWithdraw: (e: FormEvent<HTMLFormElement>, teamId: string) => void
  onReinstate: (e: FormEvent<HTMLFormElement>, teamId: string) => void
}) {
  // The engine's own answer, not one rebuilt from the match list: the number
  // in the confirm has to be the number the write acts on.
  const effect = useRpc('chaos.withdrawalEffect', { tournamentId, teamId: picked.id })
  const selected: WithdrawDetail | null =
    effect.state === 'ready'
      ? {
          teamId: picked.id,
          name: picked.name,
          withdrawn: picked.status === 'withdrawn',
          played: effect.data.played,
          toWalkover: effect.data.toWalkover,
          vacates: effect.data.vacates,
          blockedBy: effect.data.blocked.length
            ? (effect.data.blocked[0].roundName ?? 'A match of theirs')
            : null,
        }
      : null
  return <Withdraw {...props} selected={selected} />
}

function SwapData({
  slug,
  tournamentId,
  done,
  refuse,
}: {
  slug: string
  tournamentId: string
  done: Done
  refuse: Refuse
}) {
  const options = useRpc('chaos.substitutionOptions', { tournamentId })
  const players = useRpc('tournaments.listTournamentPlayers', { tournamentId })
  const { run } = useAction()

  if (options.state === 'loading' || players.state === 'loading') return <Loading lines={2} />
  if (options.state !== 'ready' || players.state !== 'ready') {
    return <LoadError error="That didn’t load." retry={() => void options.reload(false)} />
  }

  // Only people not already in a pair can step in — a name from another pair
  // would put one person on two sides of the draw.
  const inAPair = new Set(options.data.flatMap((t) => t.members.map((m) => m.id)))
  const roster = players.data.filter((p) => !inAPair.has(p.id))

  async function swap(e: FormEvent<HTMLFormElement>, out: string, inPlayerId: string) {
    e.preventDefault()
    // The reference's `out` field is "<teamId>:<playerId>"; the contract splits
    // it into two, so the select's value is unpicked here.
    const [teamId = '', outPlayerId = ''] = out.split(':')
    if (!teamId || !outPlayerId || !inPlayerId) {
      refuse('Pick who is coming out and who is going in.')
      return
    }
    const res = await run('chaos.substitutePlayer', { tournamentId, teamId, outPlayerId, inPlayerId })
    if (!res.ok) refuse(res.error, 'fix' in res ? res.fix : undefined)
    else done(res.note)
  }

  return <Swap slug={slug} teams={options.data} roster={roster} onSwap={swap} />
}

/**
 * Shortening is reached for because of one number — when the day ends — so
 * every option carries that number rather than a format name.
 */
function ShortenData({
  tournamentId,
  bestOf,
  pointsToWin,
  done,
  refuse,
}: {
  tournamentId: string
  bestOf: number
  pointsToWin: number
  done: Done
  refuse: Refuse
}) {
  const matches = useRpc('tournaments.listMatches', { tournamentId })
  const courts = useRpc('events.myCourts', { tournamentId })
  const { run } = useAction()

  if (matches.state === 'loading' || courts.state === 'loading') return <Loading lines={2} />
  if (matches.state !== 'ready' || courts.state !== 'ready') {
    return <LoadError error="That didn’t load." retry={() => void matches.reload(false)} />
  }

  const all = matches.data
  const outstanding = all.filter((m) => m.resultState === 'none' && m.status !== 'cancelled').length
  const live = all.some((m) => m.status === 'live')
  const now = new Date()
  const dayWith = (minutes: number) =>
    estimateDay({
      categories: [{ name: '', matchCount: outstanding, minutesPerMatch: minutes, minMatchesPerEntry: 0 }],
      courts: courts.data.length,
      startAt: now,
    })
  const currentMinutes = minutesPerMatch({ bestOf, pointsToWin })
  const baseline = dayWith(currentMinutes)
  const view: ShortenView = {
    currentLabel: shapeLabel(bestOf, pointsToWin),
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

  async function shorten(e: FormEvent<HTMLFormElement>, nextBestOf: number, nextPoints: number) {
    e.preventDefault()
    const res = await run('chaos.shortenFormat', {
      tournamentId,
      bestOf: nextBestOf,
      pointsToWin: nextPoints,
    })
    if (!res.ok) refuse(res.error, ('fix' in res ? res.fix : undefined) ?? 'board')
    else done(res.note)
  }

  return <Shorten view={view} onShorten={shorten} />
}

function PauseData({
  tournamentId,
  pauseNote,
  done,
}: {
  tournamentId: string
  pauseNote: string | null
  done: Done
}) {
  const { run } = useAction()

  async function pause(e: FormEvent<HTMLFormElement>, note: string) {
    e.preventDefault()
    const res = await run('chaos.pauseDay', { tournamentId, note: note.trim() })
    if (res.ok) done(res.note)
  }

  async function resume(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('chaos.resumeDay', { tournamentId })
    if (res.ok) done(res.note)
  }

  return <Pause pauseNote={pauseNote} onPause={pause} onResume={resume} />
}

function DeleteData({
  slug,
  tournamentId,
  name,
  refuse,
}: {
  slug: string
  tournamentId: string
  name: string
  refuse: Refuse
}) {
  const players = useRpc('tournaments.listTournamentPlayers', { tournamentId })
  const matches = useRpc('tournaments.listMatches', { tournamentId })
  const courts = useRpc('events.myCourts', { tournamentId })
  const { run } = useAction()

  if (players.state === 'loading' || matches.state === 'loading' || courts.state === 'loading') {
    return <Loading lines={2} />
  }
  if (players.state !== 'ready' || matches.state !== 'ready' || courts.state !== 'ready') {
    return <LoadError error="That didn’t load." retry={() => void players.reload(false)} />
  }

  const all = matches.data
  const live = all.find((m) => m.status === 'live')
  const liveOn = live ? (courts.data.find((c) => c.id === live.courtId)?.name ?? 'a court') : null

  async function remove(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('events.deleteEvent', { tournamentId })
    // On success `useAction` follows the redirect the server hands back.
    if (!res.ok) refuse(res.error, 'board')
  }

  return (
    <DeleteTournament
      slug={slug}
      name={name}
      players={players.data.length}
      matches={all.length}
      courts={courts.data.map((c) => c.name)}
      liveOn={liveOn}
      onDelete={remove}
    />
  )
}
