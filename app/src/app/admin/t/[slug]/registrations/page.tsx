import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { EmptyState, Panel, SectionHead, Tag } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { currentRegistrationToken, listPendingRegistrations } from '@/server/registration'
import { getTournamentBySlug, listCategories } from '@/server/tournaments'
import { Confirm, ROW_BUTTON, SECONDARY_LINK } from '../../../_ui'
import { approve, closeLink, makePair, reject } from './actions'
import { LinkPanel } from './link-panel'

/**
 * Sign-ups — SPEC A2. A form, not an account: no password, nothing to remember,
 * and nothing lands in the draw until the organiser says so.
 *
 * The order is the order they need attention: people waiting, then pairs that
 * can be formed with one tap, then everyone already in.
 */
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

  // The first time an organiser opens this there is no link and nobody on the
  // list, and that was 844px of two boxes both saying "make the link". This is
  // the state most first Sundays start in, so it gets a screen of its own.
  const firstRun = !token && rows.length === 0

  // A doubles player with nobody naming them back is the case the organiser has
  // to do something about — by hand, or by pairing the rest at random.
  const needsPartner = approved.filter(
    (r) =>
      !r.mutualWith &&
      cats.some((c) => c.discipline !== 'singles' && r.categoryIds.includes(c.id)),
  )

  return (
    <div className="flex flex-col gap-7">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Sign-ups</p>
        <h1 className="mt-1">
          <Link href={`/admin/t/${slug}`} className="text-title text-text">
            {tournament.name}
            <span aria-hidden className="text-text-3"> ›</span>
          </Link>
        </h1>
        <p className="num mt-1.5 text-meta text-text-3">
          {venueDate(tournament.startDate)} · {pending.length} waiting · {approved.length} in
        </p>
      </header>

      <LinkPanel slug={slug} hasActive={!!token} />

      {firstRun ? (
        <>
          <section className="flex flex-col gap-3">
            <SectionHead title="How it goes" meta="Three steps, and you are in charge of the third" />
            <Panel>
              <ol className="divide-y divide-line">
                {[
                  {
                    n: 1,
                    t: 'You drop the link in the group chat',
                    d: 'One link for the whole tournament. It stops working when the day ends, and you can close it sooner.',
                  },
                  {
                    n: 2,
                    t: 'They put their own name in',
                    d: 'Name, what they want to play, and who they’re playing with. No password, no app, nothing for them to remember.',
                  },
                  {
                    n: 3,
                    t: 'You wave them through, here',
                    d: 'Nothing is on the roster or in the draw until you say so. If two people name each other, the pair forms itself.',
                  },
                ].map((step) => (
                  <li key={step.n} className="flex gap-3 px-4 py-3.5">
                    <span className="num mt-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-ink text-[15px] font-bold text-white">
                      {step.n}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-row text-text">{step.t}</span>
                      <span className="mt-0.5 block text-meta text-text-2">{step.d}</span>
                    </span>
                  </li>
                ))}
              </ol>
            </Panel>
          </section>

          <section className="flex flex-col gap-2">
            <p className="text-body text-text-2">
              In a hurry, or already holding the list? Quick Play takes a paste from the group chat
              and skips all of this.
            </p>
            <Link href="/admin/quick" className={SECONDARY_LINK}>
              Paste a list instead
            </Link>
          </section>
        </>
      ) : null}

      {token ? (
        <Confirm
          label="Close sign-ups"
          question="The link stops working for everybody holding it, straight away. Anyone who has already filled it in stays on this screen, and you can still add people by hand."
        >
          <form action={closeLink}>
            <input type="hidden" name="slug" value={slug} />
            <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
              Close the link
            </button>
          </form>
        </Confirm>
      ) : null}

      {firstRun ? null : (
        <section className="flex flex-col gap-3">
          <SectionHead
            title="Waiting for you"
            meta="Nothing here is in the draw until you say so."
          />
          {pending.length ? (
            <Panel>
              <ul className="divide-y divide-line">
                {pending.map((r) => (
                  <li key={r.id} className="flex flex-col gap-2.5 px-4 py-3.5">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span className="text-row text-text">{r.name}</span>
                      {r.phone ? <span className="num text-meta text-text-3">{r.phone}</span> : null}
                    </div>
                    <p className="text-meta text-text-2">
                      {r.categoryNames.join(' · ') || 'No category picked'}
                      {r.partnerName ? ` · with ${r.partnerName}` : ' · needs a partner'}
                    </p>
                    {r.looksLike || r.mutualWith ? (
                      <p className="flex flex-wrap gap-1.5">
                        {r.looksLike ? (
                          <Tag tone="waiting">Looks like {r.looksLike.name}, who has played here</Tag>
                        ) : null}
                        {r.mutualWith ? <Tag tone="accent">They named each other</Tag> : null}
                      </p>
                    ) : null}

                    <div className="flex flex-wrap gap-2">
                      <form action={approve} className="flex-1 basis-[10rem]">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="id" value={r.id} />
                        {r.looksLike ? (
                          <input type="hidden" name="linkPlayerId" value={r.looksLike.id} />
                        ) : null}
                        <button className={`${ROW_BUTTON} w-full`}>
                          {r.looksLike ? 'Same person — add' : 'Add to the roster'}
                        </button>
                      </form>

                      {r.looksLike ? (
                        <form action={approve} className="flex-1 basis-[10rem]">
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="id" value={r.id} />
                          <button className={`${SECONDARY_LINK} w-full`}>
                            Different person — add anyway
                          </button>
                        </form>
                      ) : null}

                      <Confirm
                        className="flex-1 basis-[8rem] [&[open]]:basis-full"
                        label="Not playing"
                        question={`${r.name} comes off this list and does not go on the roster. If they turn up anyway, they can fill the same link in again.`}
                      >
                        <form action={reject}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="id" value={r.id} />
                          <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                            Take {r.name} off
                          </button>
                        </form>
                      </Confirm>
                    </div>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : (
            <EmptyState title="Nobody new since you last looked">
              <p>The link is live. Anything that comes in lands here for you to wave through.</p>
            </EmptyState>
          )}
        </section>
      )}

      {needsPartner.length ? (
        <section className="flex flex-col gap-3">
          <SectionHead
            title="Needs a partner"
            meta={`${needsPartner.length} on the roster with nobody named back`}
          />
          <Panel>
            <ul className="divide-y divide-line">
              {needsPartner.map((r) => (
                <li key={r.id} className="px-4 py-3">
                  <p className="text-row text-text">{r.name}</p>
                  <p className="mt-0.5 text-meta text-text-3">
                    {r.categoryNames.join(' · ')}
                    {r.partnerName ? ` · named ${r.partnerName}, who hasn’t signed up` : ''}
                  </p>
                </li>
              ))}
            </ul>
          </Panel>
          <p className="text-meta text-text-2">
            Pair them by hand on the tournament page, or let Quick Play pair the rest at random.
          </p>
        </section>
      ) : null}

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
                      <Confirm
                        className="ml-auto shrink-0 [&[open]]:w-full"
                        label={`Team up with ${partner.name}`}
                        question={`${r.name} and ${partner.name} become one pair in ${sharedCategory.name}. If the draw is already made, it does not change on its own.`}
                      >
                        <form action={makePair}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="categoryId" value={sharedCategory.id} />
                          <input
                            type="hidden"
                            name="playerIds"
                            value={`${r.playerId},${partner.playerId}`}
                          />
                          <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                            Make the pair
                          </button>
                        </form>
                      </Confirm>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Panel>
        </section>
      ) : null}

      {rejected.length ? (
        <p className="text-meta text-text-3">
          {rejected.length} marked as not playing. They can sign up again on the same link.
        </p>
      ) : null}
    </div>
  )
}
