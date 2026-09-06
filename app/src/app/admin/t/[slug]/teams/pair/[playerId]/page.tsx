import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Chevron, Notice, Panel } from '@/components/ui'
import { teamBoard, type Unpaired } from '@/server/teams'
import { getTournamentBySlug } from '@/server/tournaments'
import { SECONDARY_LINK } from '../../../../../_ui'
import { pairWithAction } from '../../actions'

export const metadata = { title: 'Pair with · Madras Pickleball' }
export const dynamic = 'force-dynamic'

/**
 * "Pair Arun Prakash with": only the people who are free. Tapping one makes
 * the pair and goes back to Teams. Someone who is no longer free — paired
 * from another phone, or since the schedule was made — goes back to Teams
 * rather than to a list they cannot use.
 */
export default async function PairWithPage(props: PageProps<'/admin/t/[slug]/teams/pair/[playerId]'>) {
  await requireUser('admin')
  const { slug, playerId } = await props.params
  const t = await getTournamentBySlug(slug)
  if (!t) notFound()
  const board = await teamBoard(t.id)
  const teamsHref = `/admin/t/${slug}/teams`

  if (board.discipline === 'singles' || board.locked) redirect(teamsHref as never)
  const me = board.unpaired.find((p) => p.id === playerId)
  if (!me) redirect(teamsHref as never)
  const free = board.unpaired.filter((p) => p.id !== me.id)

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link href={teamsHref as never} className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link">
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
        <>
          <Notice tone="waiting">
            Nobody is free to pair with {me.name}. Split a pair, or add a player under Registration.
          </Notice>
          <Link href={teamsHref as never} className={SECONDARY_LINK}>
            Back to Teams
          </Link>
        </>
      ) : (
        <Panel>
          <ul className="divide-y divide-line">
            {free.map((p) => (
              <li key={p.id}>
                <form action={pairWithAction}>
                  <input type="hidden" name="slug" value={slug} />
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
                    <span className="font-score shrink-0 text-eyebrow text-text-3 uppercase">Tap</span>
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <p className="text-meta text-text-3">
        A pair can be split and re-made any time before the schedule is made. After that it&rsquo;s under More.
      </p>
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
