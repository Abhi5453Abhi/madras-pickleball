import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useAction, useRpc } from '@/api/use-rpc'
import { Chevron, CourtSwatch, Notice, Panel, splitTeam } from '@/components/ui'
import { Loading, LoadError, useTitle } from '@/lib/page'

/**
 * From "Move" on any court card. Only this tournament's courts are offered,
 * plus the queue. Another tournament's court isn't on the list at all.
 */
function shortPair(name: string | null) {
  const parts = splitTeam(name)
  if (!parts.length) return 'To be decided'
  return parts.map((p) => p.split(/\s+/)[0]).join(' / ')
}

export function MovePage() {
  useTitle('Move this match · Madras Pickleball')
  const { matchId = '' } = useParams()
  const navigate = useNavigate()
  const loaded = useRpc('board.moveOptions', { matchId })
  const { run } = useAction()
  const [err, setErr] = useState<string | null>(null)

  // A match that is not on a court has nothing to move; the board says where
  // it is.
  const missing = loaded.state === 'missing'
  useEffect(() => {
    if (missing) navigate('/admin/live', { replace: true })
  }, [missing, navigate])

  if (loaded.state === 'loading' || missing) return <Loading />
  if (loaded.state !== 'ready') return <LoadError error={loaded.error} retry={() => void loaded.reload(false)} />

  const opts = loaded.data
  const free = opts.courts.filter((c) => !c.busy && !c.closedReason)

  async function move(e: FormEvent<HTMLFormElement>, courtId: string) {
    e.preventDefault()
    const res = await run('board.moveMatch', { matchId, courtId })
    if (!res.ok) setErr(res.error)
  }

  async function backToQueue(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('board.clearCourt', { matchId, later: true })
    if (!res.ok) setErr(res.error)
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          to="/admin/live"
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          Live board
        </Link>
        <h1 className="mt-1 text-title text-text">Move this match</h1>
        <p className="mt-1 text-meta text-text-3">
          {shortPair(opts.match.nameA)} v {shortPair(opts.match.nameB)}
          {opts.match.courtName ? ` · on ${opts.match.courtName}` : ''}
        </p>
      </header>

      {err ? (
        <Notice tone="alert" title="Not done">
          {err}
        </Notice>
      ) : null}

      <Panel>
        <ul className="divide-y divide-line">
          {opts.courts.map((c) => {
            const meta = c.closedReason
              ? `${opts.tournament.categoryName} · out of action — ${c.closedReason}`
              : c.busy
                ? `${opts.tournament.categoryName} · busy — ${shortPair(c.busy.nameA)} v ${shortPair(c.busy.nameB)}, ${
                    c.busy.minutes < 1 ? 'just started' : `on for ${c.busy.minutes} min`
                  }`
                : `${opts.tournament.categoryName} · free`
            const pickable = !c.busy && !c.closedReason
            return (
              <li key={c.id}>
                {pickable ? (
                  <form onSubmit={(e) => move(e, c.id)}>
                    <input type="hidden" name="matchId" value={opts.match.id} />
                    <input type="hidden" name="courtId" value={c.id} />
                    <button className="tap-lg flex w-full items-center gap-3 px-4 text-left">
                      <CourtSwatch colorKey={c.colorKey} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-row text-text">{c.name}</span>
                        <span className="block text-meta text-text-3">{meta}</span>
                      </span>
                      <span aria-hidden className="text-text-3">
                        <Chevron className="-rotate-90" />
                      </span>
                    </button>
                  </form>
                ) : (
                  // Shown, not offered: a greyed row with who is on it says more
                  // than a row that is missing.
                  <div aria-disabled className="tap-lg flex items-center gap-3 bg-sunken px-4 text-left">
                    <CourtSwatch colorKey={c.colorKey} size="md" className="opacity-50" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-row text-text-3">{c.name}</span>
                      <span className="block text-meta text-text-3">{meta}</span>
                    </span>
                  </div>
                )}
              </li>
            )
          })}
          <li>
            <form onSubmit={backToQueue}>
              <input type="hidden" name="matchId" value={opts.match.id} />
              <button className="tap-lg flex w-full items-center gap-3 px-4 text-left">
                <span className="min-w-0 flex-1">
                  <span className="block text-row text-text">Back to the queue</span>
                  <span className="block text-meta text-text-3">
                    take it off court — it goes to the back of the order
                  </span>
                </span>
                <span aria-hidden className="text-text-3">
                  <Chevron className="-rotate-90" />
                </span>
              </button>
            </form>
          </li>
        </ul>
      </Panel>

      <p className="text-meta text-text-3">
        {opts.courts.length === 0
          ? `${opts.tournament.categoryName} has only the one court. `
          : free.length === 0 && opts.courts.length
            ? 'Every other court is busy. '
            : ''}
        Need another court? Add one under{' '}
        <Link to={`/admin/t/${opts.tournament.slug}/schedule`} className="font-semibold text-link">
          Schedule &amp; courts
        </Link>
        .
      </p>
    </div>
  )
}
