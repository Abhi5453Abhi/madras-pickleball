import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import {
  CourtSwatch,
  EmptyState,
  NetRule,
  Notice,
  Panel,
  StatusPill,
  TeamName,
} from '@/components/ui'
import { umpireQueue } from '@/server/umpire'
import { ensureReady } from '@/server/bootstrap'

export const dynamic = 'force-dynamic'

/**
 * An umpire's whole world: what is on court now that they may score, and what
 * is coming. Deliberately no navigation to anything else — an umpire who taps
 * into the organiser's screens is bounced straight back out, and a link that
 * always bounces is worse than no link.
 */
export default async function UmpireHome(props: PageProps<'/umpire'>) {
  await ensureReady()
  const user = await requireUser('umpire')
  const { denied } = await props.searchParams
  const queue = await umpireQueue()

  const live = queue.filter((m) => m.status === 'live')
  const next = queue.filter((m) => m.status !== 'live')

  return (
    <div className="flex flex-col gap-7">
      {denied ? (
        <Notice tone="info">
          That part of the app is for organisers. Everything you can score is below.
        </Notice>
      ) : null}

      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Scoring</p>
        <h1 className="mt-1 text-title text-text">{user.name}</h1>
        <p className="mt-1.5 text-meta text-text-3">
          {live.length
            ? `${live.length} match${live.length === 1 ? '' : 'es'} on court now`
            : 'Nothing on court right now'}
        </p>
      </header>

      <section>
        <div className="flex items-baseline justify-between">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">On court now</h2>
          {live.length ? (
            <span className="num text-meta text-text-3">tap one to score it</span>
          ) : null}
        </div>
        <NetRule className="mt-2" />
        {live.length ? (
          <Panel className="mt-3">
            <ul className="divide-y divide-line">
              {live.map((m) => (
                <li key={m.id}>
                  <Link href={`/admin/m/${m.id}`} className="tap-xl flex items-center gap-3 px-4">
                    {m.courtColor ? <CourtSwatch colorKey={m.courtColor} /> : null}
                    <span className="min-w-0 flex-1">
                      <TeamName name={m.nameA} />
                      <TeamName name={m.nameB} />
                      <span className="block text-meta text-text-3">
                        {m.courtName ? `${m.courtName} · ` : ''}
                        {m.categoryName}
                        {m.roundName ? ` · ${m.roundName}` : ''}
                      </span>
                    </span>
                    <StatusPill state="live">Score it</StatusPill>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        ) : (
          <div className="mt-3">
            <EmptyState title="Nothing has been sent out yet">
              <p>
                When the organiser sends a match to a court it turns up here. Leave this page open —
                it catches up when you come back to it.
              </p>
            </EmptyState>
          </div>
        )}
      </section>

      {next.length ? (
        <section>
          <div className="flex items-baseline justify-between">
            <h2 className="font-score text-eyebrow text-text-2 uppercase">Waiting for a court</h2>
            <span className="num text-meta text-text-3">{next.length} to come</span>
          </div>
          <NetRule className="mt-2" />
          <Panel className="mt-3">
            <ul className="divide-y divide-line">
              {next.slice(0, 12).map((m) => (
                <li key={m.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <TeamName name={m.nameA} muted />
                    <TeamName name={m.nameB} muted />
                    <span className="block text-meta text-text-3">
                      {m.categoryName}
                      {m.roundName ? ` · ${m.roundName}` : ''}
                    </span>
                  </span>
                  <StatusPill state="waiting">Not out yet</StatusPill>
                </li>
              ))}
            </ul>
          </Panel>
          {next.length > 12 ? (
            <p className="mt-2 text-meta text-text-3">
              and {next.length - 12} more after these.
            </p>
          ) : null}
        </section>
      ) : null}

      <p className="text-meta text-text-3">
        A score you enter here is final the moment you send it — you are named against it. If one
        needs changing afterwards, the organiser does it.
      </p>
    </div>
  )
}
