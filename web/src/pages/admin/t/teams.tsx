import { useState, type FormEvent, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import type { Output } from '@/api/contract'
import { useAction, useRpc } from '@/api/use-rpc'
import { Chevron, Confirm, EmptyState, Notice, Panel, TeamName } from '@/components/ui'
import { ROW_BUTTON, SECONDARY_LINK } from '@/components/admin-ui'
import { Loading, LoadError, NotFoundCard, useTitle } from '@/lib/page'

type Board = Output<'teams.teamBoard'>
type BoardPair = Board['pairs'][number]
type Unpaired = Board['unpaired'][number]

/** The sentence the screen prints once the schedule exists and nothing can move. */
export const LOCKED_MESSAGE = 'The tournament has started. Changing a pair is under More.'

/**
 * Two piles: pairs that exist, and people who still need one. The count at
 * the top is the thing the organiser is driving to zero. Singles has no
 * pairs to make, so the same route is the list of who is in.
 */
export function TeamsPage() {
  useTitle('Teams · Madras Pickleball')
  const { slug = '' } = useParams()
  const tournament = useRpc('tournaments.getTournamentBySlug', { slug })

  if (tournament.state === 'loading') return <Loading />
  if (tournament.state === 'missing') return <NotFoundCard />
  if (tournament.state !== 'ready') {
    return <LoadError error={tournament.error} retry={() => void tournament.reload(false)} />
  }
  return <Teams slug={slug} tournamentId={tournament.data.id} name={tournament.data.name} />
}

function Teams({ slug, tournamentId, name }: { slug: string; tournamentId: string; name: string }) {
  // Loading the board settles what can be settled without the organiser.
  const loaded = useRpc('teams.teamBoard', { tournamentId })
  const { run } = useAction()
  const [params] = useSearchParams()
  // A refusal from the partner picker arrives in the URL, as the reference's
  // action redirect did; the two buttons here put theirs in state.
  const [failed, setErr] = useState<string | null>(null)
  const err = failed ?? params.get('err')
  const base = `/admin/t/${slug}`

  const back = (
    <Link to={base} className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link">
      <Chevron className="rotate-90" />
      {name}
    </Link>
  )

  if (loaded.state === 'loading') return <Loading />
  if (loaded.state !== 'ready') return <LoadError error={loaded.error} retry={() => void loaded.reload(false)} />
  const board = loaded.data

  async function pairRest(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('teams.pairRestRandomly', { tournamentId })
    if (!res.ok) setErr(res.error)
    else setErr(null)
    await loaded.reload()
  }

  async function split(e: FormEvent<HTMLFormElement>, teamId: string) {
    e.preventDefault()
    const res = await run('teams.splitTeam', { tournamentId, teamId })
    if (!res.ok) setErr(res.error)
    else setErr(null)
    await loaded.reload()
  }

  if (board.discipline === 'singles') {
    const n = board.pairs.length
    return (
      <div className="flex flex-col gap-6">
        <header>
          {back}
          <h1 className="mt-1 text-title text-text">Players</h1>
          <p className="num mt-1 text-meta text-text-3">{n ? `${n} in the draw` : 'Nobody in yet'}</p>
        </header>
        {n === 0 ? (
          <NobodyYet base={base} />
        ) : (
          <Panel>
            <ul className="divide-y divide-line">
              {board.pairs.map((p) => (
                <li key={p.teamId} className="flex min-h-[56px] items-center px-4 text-row text-text">
                  {p.players[0]?.name ?? p.name}
                </li>
              ))}
            </ul>
          </Panel>
        )}
        {n >= 2 ? (
          <Link to={`${base}/schedule`} className={SECONDARY_LINK}>
            Next: Schedule &amp; courts
          </Link>
        ) : null}
      </div>
    )
  }

  const { pairs, unpaired, needed, locked } = board
  const nobody = pairs.length === 0 && unpaired.length === 0
  const allPaired = !nobody && unpaired.length === 0
  const sub = nobody
    ? 'No players yet'
    : `${count(pairs.length, 'pair')} made · ${
        allPaired ? 'everyone is paired' : `${count(unpaired.length, 'player')} still to pair`
      }`

  return (
    <div className="flex flex-col gap-6">
      <header>
        {back}
        <h1 className="mt-1 text-title text-text">Teams</h1>
        <p className="num mt-1 text-meta text-text-3">{sub}</p>
      </header>

      {err ? <Notice tone="alert">{err}</Notice> : null}
      {locked && !nobody ? <p className="-mt-2 text-body text-text-2">{LOCKED_MESSAGE}</p> : null}

      {nobody ? <NobodyYet base={base} /> : null}

      {unpaired.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">
            Still to pair
            <small className="num ml-1 font-normal normal-case text-text-3">
              {count(unpaired.length, 'player')}
            </small>
          </h2>
          <Panel>
            <ul className="divide-y divide-line">
              {unpaired.map((p) => (
                <UnpairedRow key={p.id} p={p} base={base} locked={locked} alone={unpaired.length === 1} />
              ))}
            </ul>
          </Panel>
          {!locked && unpaired.length === 1 ? (
            <p className="text-meta text-text-2">
              {unpaired[0].name} is the odd one out — add or remove a player under{' '}
              <Link to={`${base}/registration`} className="font-semibold text-link">
                Registration
              </Link>
              .
            </p>
          ) : null}
          {!locked && unpaired.length >= 2 ? (
            <Confirm
              label="Pair the rest at random"
              question={`Pair the ${unpaired.length} people left at random?`}
              detail={
                unpaired.length % 2
                  ? `${unpaired.length} is an odd number, so one person will be left out.`
                  : 'Any of them can be split afterwards.'
              }
            >
              <form onSubmit={pairRest}>
                <input type="hidden" name="slug" value={slug} />
                <button className={`${ROW_BUTTON} w-full`}>Pair them</button>
              </form>
            </Confirm>
          ) : null}
        </section>
      ) : null}

      {pairs.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">
            Pairs
            <small className="num ml-1 font-normal normal-case text-text-3">
              {pairs.length} of {Math.max(needed, pairs.length)}
            </small>
          </h2>
          <Panel>
            <ul className="divide-y divide-line">
              {pairs.map((pair) => (
                <PairRow key={pair.teamId} pair={pair} locked={locked} onSplit={split} />
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}

      {allPaired && pairs.length >= 2 && !locked ? (
        <Link to={`${base}/schedule`} className={SECONDARY_LINK}>
          Next: Schedule &amp; courts
        </Link>
      ) : null}
    </div>
  )
}

function count(n: number, noun: string) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`
}

function NobodyYet({ base }: { base: string }) {
  return (
    <EmptyState title="Nobody has signed up yet">
      <p>Share the sign-up link, or add players by hand under Registration.</p>
      <Link to={`${base}/registration`} className={`${SECONDARY_LINK} mt-3 max-w-[16rem]`}>
        Registration
      </Link>
    </EmptyState>
  )
}

/** The wish line under a name: what they asked for, in their words. */
function wishLine(p: Unpaired) {
  if (p.wishPlayerName) return `wants ${p.wishPlayerName}`
  if (p.wishText) return `wants ${p.wishText} (not signed up)`
  return 'named nobody'
}

/**
 * A person in the pile. The whole row opens the picker — the grey note on
 * the right says why they are still here, not that they cannot be paired.
 */
function UnpairedRow({
  p,
  base,
  locked,
  alone,
}: {
  p: Unpaired
  base: string
  locked: boolean
  alone: boolean
}) {
  // The wish and why it did not happen sit under the name; the right-hand
  // side is the same "Pair with…" on every row, so nobody looks unpairable.
  const names: ReactNode = (
    <span className="min-w-0 flex-1">
      <span className="block text-row text-text">{p.name}</span>
      <span className="block text-meta text-text-3">
        {wishLine(p)}
        {p.note ? ` · ${p.note}` : ''}
      </span>
    </span>
  )
  const right = locked || alone ? null : (
    <span className="shrink-0 text-[16px] font-semibold text-link">Pair with…</span>
  )
  if (locked || alone) {
    return (
      <li className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">
        {names}
        {right}
      </li>
    )
  }
  return (
    <li>
      <Link
        to={`${base}/teams/pair/${p.id}`}
        className="flex min-h-[56px] items-center gap-3 px-4 py-2.5 hover:bg-ground"
      >
        {names}
        {right}
      </Link>
    </li>
  )
}

/**
 * A pair. Mutual ones carry their tick; the rest can be split — a second tap
 * inside the row, so a thumb landing on the wrong line costs nothing.
 */
function PairRow({
  pair,
  locked,
  onSplit,
}: {
  pair: BoardPair
  locked: boolean
  onSplit: (e: FormEvent<HTMLFormElement>, teamId: string) => void
}) {
  const names: ReactNode = (
    <span className="min-w-0 flex-1">
      <TeamName name={pair.name} players={pair.players.map((p) => p.name).filter(Boolean)} />
      <span className="block text-meta text-text-3">
        {pair.how === 'mutual' ? 'named each other' : 'paired by you'}
      </span>
    </span>
  )
  if (pair.how === 'mutual' || locked) {
    return <li className="flex min-h-[56px] items-center gap-3 px-4 py-2.5">{names}</li>
  }
  return (
    <li>
      <details className="group">
        <summary className="flex min-h-[56px] items-center gap-3 px-4 py-2.5 hover:bg-ground">
          {names}
          <span className="shrink-0 text-[16px] font-semibold text-link">Split</span>
        </summary>
        <div className="mx-4 mb-3 rounded-control border border-line-strong bg-sunken p-3.5">
          <p className="text-body text-text">
            Split {pair.players.map((p) => p.name).join(' and ')}? Both go back to the pile.
          </p>
          <form onSubmit={(e) => onSplit(e, pair.teamId)} className="mt-3">
            <input type="hidden" name="team" value={pair.teamId} />
            <button className={`${ROW_BUTTON} w-full`}>Split them</button>
          </form>
          <p className="mt-2 text-meta text-text-3">Tap the row again to leave it.</p>
        </div>
      </details>
    </li>
  )
}
