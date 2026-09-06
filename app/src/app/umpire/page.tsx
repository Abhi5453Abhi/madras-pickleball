import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { CourtSwatch, Notice, Panel, SectionHead, StatusPill } from '@/components/ui'
import { umpireQueue } from '@/server/umpire'
import { ensureReady } from '@/server/bootstrap'

export const dynamic = 'force-dynamic'

export default async function UmpireHome(props: PageProps<'/umpire'>) {
  await ensureReady()
  await requireUser('umpire')
  const { denied } = await props.searchParams
  const queue = await umpireQueue()

  const live = queue.filter((m) => m.status === 'live')
  const next = queue.filter((m) => m.status !== 'live')

  return (
    <div className="flex flex-col gap-7">
      {denied ? (
        <Notice tone="info">
          That part of the app is for organisers. You can score the matches below.
        </Notice>
      ) : null}

      <div>
        <SectionHead
          title="On court now"
          meta={live.length ? undefined : 'Nothing has been sent out yet.'}
        />
        {live.length ? (
          <Panel className="mt-3 divide-y divide-line">
            {live.map((m) => (
              <Link key={m.id} href={`/admin/m/${m.id}`} className="tap-xl flex items-center gap-3 px-4">
                {m.courtColor ? <CourtSwatch colorKey={m.courtColor} /> : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-row text-text">{m.nameA}</span>
                  <span className="block truncate text-row text-text">{m.nameB}</span>
                  <span className="block text-meta text-text-3">
                    {m.courtName ? `${m.courtName} · ` : ''}
                    {m.categoryName}
                    {m.roundName ? ` · ${m.roundName}` : ''}
                  </span>
                </span>
                <StatusPill state="live">Score it</StatusPill>
              </Link>
            ))}
          </Panel>
        ) : null}
      </div>

      {next.length ? (
        <div>
          <SectionHead title="Waiting for a court" />
          <Panel className="mt-3 divide-y divide-line">
            {next.slice(0, 12).map((m) => (
              <div key={m.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-row text-text">
                    {m.nameA} <span className="text-text-3">v</span> {m.nameB}
                  </span>
                  <span className="block text-meta text-text-3">
                    {m.categoryName}
                    {m.roundName ? ` · ${m.roundName}` : ''}
                  </span>
                </span>
                <StatusPill state="waiting">Not out yet</StatusPill>
              </div>
            ))}
          </Panel>
        </div>
      ) : null}

      <p className="text-meta text-text-3">
        Scores you enter here are final. If one needs changing afterwards, the organiser does it.
      </p>
    </div>
  )
}
