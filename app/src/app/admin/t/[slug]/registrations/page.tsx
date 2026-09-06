import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Button, Panel, SectionHead, StatusPill } from '@/components/ui'
import { venueDate } from '@/lib/time'
import {
  currentRegistrationToken,
  listPendingRegistrations,
} from '@/server/registration'
import { getTournamentBySlug, listCategories } from '@/server/tournaments'
import { approve, closeLink, makePair, reject } from './actions'
import { LinkPanel } from './link-panel'

export const dynamic = 'force-dynamic'

export default async function RegistrationsPage(props: PageProps<'/admin/t/[slug]/registrations'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) notFound()

  const [token, rows, cats] = await Promise.all([
    currentRegistrationToken(tournament.id),
    listPendingRegistrations(tournament.id),
    listCategories(tournament.id),
  ])

  const pending = rows.filter((r) => r.status === 'pending')
  const approved = rows.filter((r) => r.status === 'approved')
  const rejected = rows.filter((r) => r.status === 'rejected')
  const approvedById = new Map(approved.map((r) => [r.id, r]))

  return (
    <div className="flex flex-col gap-8">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Sign-ups</p>
        <h1 className="mt-1 text-title text-text">{tournament.name}</h1>
        <p className="num mt-1 text-meta text-text-3">
          {venueDate(tournament.startDate)} · {pending.length} waiting · {approved.length} in
        </p>
      </header>

      <LinkPanel slug={slug} hasActive={!!token} />

      {token ? (
        <form action={closeLink}>
          <input type="hidden" name="slug" value={slug} />
          <button className="tap text-left text-body font-medium text-link">
            Close sign-ups
          </button>
        </form>
      ) : null}

      <section className="flex flex-col gap-3">
        <SectionHead
          title="Waiting for you"
          meta="Nothing here is in the draw until you say so."
        />
        {pending.length ? (
          <Panel>
            <ul className="divide-y divide-line">
              {pending.map((r) => (
                <li key={r.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="text-row text-text">{r.name}</span>
                    {r.phone ? <span className="num text-meta text-text-3">{r.phone}</span> : null}
                    {r.looksLike ? (
                      <StatusPill state="waiting">Played here before</StatusPill>
                    ) : null}
                  </div>
                  <p className="text-meta text-text-2">
                    {r.categoryNames.join(' · ') || 'No category picked'}
                    {r.partnerName ? ` · with ${r.partnerName}` : ' · needs a partner'}
                    {r.mutualWith ? ' — they named each other' : ''}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <form action={approve}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="id" value={r.id} />
                      {r.looksLike ? (
                        <input type="hidden" name="linkPlayerId" value={r.looksLike.id} />
                      ) : null}
                      <Button className="tap px-4 text-[16px]">
                        {r.looksLike ? `Add — same as ${r.looksLike.name}` : 'Add to the roster'}
                      </Button>
                    </form>
                    {r.looksLike ? (
                      <form action={approve}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="id" value={r.id} />
                        <Button variant="secondary" className="tap px-4 text-[16px]">
                          Different person
                        </Button>
                      </form>
                    ) : null}
                    <form action={reject}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="id" value={r.id} />
                      <button className="tap rounded-control px-3 text-[16px] font-semibold text-text-3">
                        Not playing
                      </button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          </Panel>
        ) : (
          <p className="text-body text-text-2">
            {token ? 'Nobody new since you last looked.' : 'Make a link and share it to start.'}
          </p>
        )}
      </section>

      {approved.length ? (
        <section className="flex flex-col gap-3">
          <SectionHead title="On the roster" meta={`${approved.length} players`} />
          <Panel>
            <ul className="divide-y divide-line">
              {approved.map((r) => {
                const partner = r.mutualWith ? approvedById.get(r.mutualWith.id) : null
                // Only offer the pair once — from the alphabetically first of
                // the two — or the same team gets offered twice.
                const offerPair = partner && r.name.localeCompare(partner.name) < 0
                const sharedCategory = partner
                  ? cats.find(
                      (c) =>
                        c.discipline !== 'singles' &&
                        r.categoryIds.includes(c.id) &&
                        partner.categoryIds.includes(c.id),
                    )
                  : null
                return (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <div className="min-w-[9rem] flex-1">
                      <p className="text-row text-text">{r.name}</p>
                      <p className="text-meta text-text-3">{r.categoryNames.join(' · ')}</p>
                    </div>
                    {offerPair && partner && sharedCategory && r.playerId && partner.playerId ? (
                      <form action={makePair} className="ml-auto shrink-0">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="categoryId" value={sharedCategory.id} />
                        <input
                          type="hidden"
                          name="playerIds"
                          value={`${r.playerId},${partner.playerId}`}
                        />
                        <input type="hidden" name="names" value={`${r.name}|${partner.name}`} />
                        <Button variant="secondary" className="tap px-4 text-[16px]">
                          Team them up with {partner.name}
                        </Button>
                      </form>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Panel>
        </section>
      ) : null}

      {rejected.length ? (
        <p className="text-meta text-text-3">{rejected.length} marked as not playing.</p>
      ) : null}
    </div>
  )
}
