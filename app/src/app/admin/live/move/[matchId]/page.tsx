import Link from 'next/link'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Chevron, CourtSwatch, Notice, Panel, Tag, splitTeam } from '@/components/ui'
import { moveOptions } from '@/server/board'
import { backToQueueAction, moveMatchAction } from './actions'

/**
 * From "Move" on any court card. Only this tournament's courts are offered,
 * plus the queue. Another tournament's court isn't on the list at all.
 */
export const metadata = { title: 'Move this match · Madras Pickleball' }

export const dynamic = 'force-dynamic'

function shortPair(name: string | null) {
  const parts = splitTeam(name)
  if (!parts.length) return 'To be decided'
  return parts.map((p) => p.split(/\s+/)[0]).join(' / ')
}

export default async function MovePage(props: PageProps<'/admin/live/move/[matchId]'>) {
  await requireUser('admin')
  const { matchId } = await props.params
  const { err } = await props.searchParams

  const opts = await moveOptions(matchId)
  // A match that is not on a court has nothing to move; the board says where
  // it is.
  if (!opts) redirect('/admin/live')

  const free = opts.courts.filter((c) => !c.busy && !c.closedReason)

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/admin/live"
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
          {String(err)}
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
                  <form action={moveMatchAction}>
                    <input type="hidden" name="matchId" value={opts.match.id} />
                    <input type="hidden" name="courtId" value={c.id} />
                    <button className="tap-lg flex w-full items-center gap-3 px-4 text-left">
                      <CourtSwatch colorKey={c.colorKey} size="md" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-row text-text">{c.name}</span>
                        <span className="block text-meta text-text-3">{meta}</span>
                      </span>
                      <Tag tone="accent">Pick</Tag>
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
            <form action={backToQueueAction}>
              <input type="hidden" name="matchId" value={opts.match.id} />
              <button className="tap-lg flex w-full items-center gap-3 px-4 text-left">
                <span className="min-w-0 flex-1">
                  <span className="block text-row text-text">Back to the queue</span>
                  <span className="block text-meta text-text-3">take it off court — it goes to the back of the order</span>
                </span>
                <Tag tone="accent">Pick</Tag>
              </button>
            </form>
          </li>
        </ul>
      </Panel>

      <p className="text-meta text-text-3">
        {opts.courts.length === 0
          ? `${opts.tournament.categoryName} has only the one court. `
          : free.length === 0 && opts.courts.length
            ? 'Every other court is busy — the queue is the only way off. '
            : ''}
        Need another court? Add one to this tournament under{' '}
        <Link href={`/admin/t/${opts.tournament.slug}/schedule` as never} className="font-semibold text-link">
          Schedule &amp; courts
        </Link>{' '}
        — that’s where courts change, not here.
      </p>
    </div>
  )
}
