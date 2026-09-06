import { useEffect, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import type { Output } from '@/api/contract'
import { useAction, useRpc } from '@/api/use-rpc'
import { Chevron, Notice, Panel } from '@/components/ui'
import { Loading, LoadError, NotFoundCard, useTitle } from '@/lib/page'

type Unpaired = Output<'teams.teamBoard'>['unpaired'][number]

/**
 * "Pair Arun Prakash with": only the people who are free. Tapping one makes
 * the pair and goes back to Teams. Someone who is no longer free — paired
 * from another phone, or since the schedule was made — goes back to Teams
 * rather than to a list they cannot use.
 */
export function PairWithPage() {
  useTitle('Pair with · Madras Pickleball')
  const { slug = '' } = useParams()
  const tournament = useRpc('tournaments.getTournamentBySlug', { slug })

  if (tournament.state === 'loading') return <Loading />
  if (tournament.state === 'missing') return <NotFoundCard />
  if (tournament.state !== 'ready') {
    return <LoadError error={tournament.error} retry={() => void tournament.reload(false)} />
  }
  return <PairWith slug={slug} tournamentId={tournament.data.id} />
}

function PairWith({ slug, tournamentId }: { slug: string; tournamentId: string }) {
  const { playerId = '' } = useParams()
  const navigate = useNavigate()
  const loaded = useRpc('teams.teamBoard', { tournamentId })
  const { run } = useAction()
  const teamsHref = `/admin/t/${slug}/teams`

  const board = loaded.state === 'ready' ? loaded.data : null
  const me = board?.unpaired.find((p) => p.id === playerId) ?? null
  const bounce = !!board && (board.discipline === 'singles' || board.locked || !me)

  useEffect(() => {
    if (bounce) navigate(teamsHref, { replace: true })
  }, [bounce, navigate, teamsHref])

  if (loaded.state === 'loading' || bounce) return <Loading />
  if (loaded.state !== 'ready') return <LoadError error={loaded.error} retry={() => void loaded.reload(false)} />
  if (!me || !board) return <Loading />

  const free = board.unpaired.filter((p) => p.id !== me.id)

  async function pair(e: FormEvent<HTMLFormElement>, partnerId: string) {
    e.preventDefault()
    const res = await run('teams.pairWith', { tournamentId, playerA: playerId, playerB: partnerId })
    if (res.ok) navigate(teamsHref)
    else navigate(`${teamsHref}?err=${encodeURIComponent(res.error)}`)
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          to={teamsHref}
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          Teams
        </Link>
        <h1 className="mt-1 text-title text-text">Pair {me.name} with</h1>
        {me.wishPlayerName || me.wishText ? (
          <p className="mt-1 text-meta text-text-3">
            {me.name.split(/\s+/)[0]} asked for {me.wishPlayerName ?? `${me.wishText} (not signed up)`}
          </p>
        ) : null}
      </header>

      {free.length === 0 ? (
        <Notice tone="waiting">
          Nobody is free to pair with {me.name}. Split a pair, or add a player under{' '}
          <Link to={`/admin/t/${slug}/registration`} className="font-semibold text-link">
            Registration
          </Link>
          .
        </Notice>
      ) : (
        <Panel>
          <ul className="divide-y divide-line">
            {free.map((p) => (
              <li key={p.id}>
                <form onSubmit={(e) => pair(e, p.id)}>
                  <input type="hidden" name="player" value={me.id} />
                  <input type="hidden" name="partner" value={p.id} />
                  <button
                    type="submit"
                    className="flex min-h-[56px] w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ground"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block text-row text-text">{p.name}</span>
                      <span className="block text-meta text-text-3">{pickerLine(p)}</span>
                    </span>
                    <span aria-hidden className="shrink-0 text-text-3">
                      <Chevron className="-rotate-90" />
                    </span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <p className="text-meta text-text-3">A pair can be split again any time before the start.</p>
    </div>
  )
}

/** "wants Suresh" — first names, the way the organiser says them. */
function pickerLine(p: Unpaired) {
  const first = (name: string) => name.trim().split(/\s+/)[0] || name
  if (p.wishPlayerName) return `wants ${first(p.wishPlayerName)}`
  if (p.wishText) return `wants ${p.wishText} (not signed up)`
  return 'named nobody'
}
