import Link from 'next/link'
import { headers } from 'next/headers'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Card, Chevron, Confirm, EmptyState, Notice, Panel, Tag } from '@/components/ui'
import { endOfVenueDay } from '@/lib/time'
import { primaryCategory } from '@/server/events'
import { ensureRegistrationLink, listRoster, signupsClosed } from '@/server/registration'
import { getTournamentBySlug } from '@/server/tournaments'
import { ROW_BUTTON, SECONDARY_LINK } from '../../../_ui'
import { closeSignups, remove, reopenSignups, settleDuplicate } from './actions'
import { AddPlayerForm, LinkCard } from './link-panel'

/**
 * Registration — SPEC v4. The link, then everyone who is in and how they got
 * there. "Add a player" sits right under the link for the ones who phoned.
 * Nobody waits for approval: a sign-up is on the list the moment it lands,
 * and the only question the organiser is ever asked is "same person?".
 */
export async function generateMetadata(props: PageProps<'/admin/t/[slug]/registration'>) {
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  return {
    title: tournament ? `Registration · ${tournament.name}` : 'Registration · Madras Pickleball',
  }
}

export const dynamic = 'force-dynamic'

export default async function RegistrationPage(props: PageProps<'/admin/t/[slug]/registration'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const { err, note } = await props.searchParams
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) notFound()

  const closed = signupsClosed(tournament)
  const started = tournament.status !== 'draft' && tournament.status !== 'registration'
  const [raw, roster, category, h] = await Promise.all([
    ensureRegistrationLink(tournament.id, endOfVenueDay(tournament.endDate)),
    listRoster(tournament.id),
    primaryCategory(tournament.id),
    headers(),
  ])
  const doubles = category.discipline !== 'singles'
  // A possible duplicate is the one row that needs a decision, so it goes to
  // the top of the list rather than wherever it arrived.
  const flagged = roster.filter((r) => r.duplicateOf).length
  const ordered = [...roster.filter((r) => r.duplicateOf), ...roster.filter((r) => !r.duplicateOf)]

  // The address as the organiser will paste it. The host is whatever they are
  // looking at this page on, which is the only origin the app can vouch for.
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'madraspickleball.in'
  const proto = h.get('x-forwarded-proto') ?? (/^(localhost|127\.)/.test(host) ? 'http' : 'https')
  const path = `/r/${raw}`
  const fullLink = `${proto}://${host}${path}`

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href={`/admin/t/${slug}`}
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          {tournament.name}
        </Link>
        <h1 className="mt-1 text-title text-text">Registration</h1>
        <p className="num mt-1 text-meta text-text-3">
          {roster.length} in · sign-ups {closed ? 'closed' : 'open'}
          {flagged ? ` · ${flagged} possible ${flagged === 1 ? 'duplicate' : 'duplicates'}` : ''}
        </p>
      </header>

      {err ? (
        <Notice tone="alert" title="Not done">
          {String(err)}
        </Notice>
      ) : null}
      {note ? <Notice tone="done">{String(note)}</Notice> : null}

      {closed ? (
        <Card className="border-line-key p-4">
          <p className="font-score text-eyebrow text-text-2 uppercase">Sign-ups closed</p>
          <p className="mt-1 text-body text-text-2">
            {started
              ? 'The tournament has started, so the link no longer accepts anyone. You can still add or remove people here.'
              : 'The link no longer accepts anyone. Players who open it see “Sign-ups have closed — ask the organiser.”'}
          </p>
          {started ? null : (
            <form action={reopenSignups} className="mt-3">
              <input type="hidden" name="slug" value={slug} />
              <button className={SECONDARY_LINK}>Reopen sign-ups</button>
            </form>
          )}
        </Card>
      ) : (
        <>
          <LinkCard shown={`${host}${path}`} full={fullLink} />
          <Confirm
            label="Close sign-ups"
            question="The link stops taking new names straight away. Everyone already on the list stays, and you can still add or remove people here."
          >
            <form action={closeSignups}>
              <input type="hidden" name="slug" value={slug} />
              <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                Close sign-ups
              </button>
            </form>
          </Confirm>
        </>
      )}

      <AddPlayerForm slug={slug} />

      <section className="flex flex-col gap-3">
        <h2 className="font-score text-eyebrow text-text-2 uppercase">
          Players
          {roster.length ? (
            <small className="num ml-1 font-normal normal-case text-text-3">{roster.length}</small>
          ) : null}
        </h2>
        {roster.length === 0 ? (
          <EmptyState title="Nobody on the list yet">
            <p>
              {closed
                ? 'Sign-ups are closed. Add people by hand above.'
                : 'Send the link to the group, or add people by hand above.'}
            </p>
          </EmptyState>
        ) : (
          <Panel>
            <ul className="divide-y divide-line">
              {ordered.map((r) => {
                // "wants Sathish Kumar · via link". A flagged row skips "no
                // partner named": the tag under it is the thing to read.
                const meta = [
                  doubles && r.partner ? `wants ${r.partner}` : null,
                  doubles && !r.partner && !r.duplicateOf ? 'no partner named' : null,
                  r.source === 'link' ? 'via link' : 'added by you',
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <li key={r.playerId} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-row text-text">{r.name}</p>
                        <p className="text-meta text-text-3">{meta}</p>
                        {r.duplicateOf ? (
                          <p className="mt-1.5">
                            <Tag tone="waiting">Same as {r.duplicateOf.name}?</Tag>
                          </p>
                        ) : null}
                      </div>
                      <Confirm
                        className="ml-auto shrink-0 [&>summary]:border-0 [&>summary]:px-2 [&>summary]:text-link [&[open]]:w-full"
                        label="Remove"
                        question={`${r.name} comes off the list. If they are in a pair that has not played, the pair is split.`}
                      >
                        <form action={remove}>
                          <input type="hidden" name="slug" value={slug} />
                          <input type="hidden" name="playerId" value={r.playerId} />
                          <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                            Take {r.name} off
                          </button>
                        </form>
                      </Confirm>
                    </div>
                    {r.duplicateOf ? (
                      <form action={settleDuplicate} className="flex gap-2">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="playerId" value={r.playerId} />
                        <input type="hidden" name="keepId" value={r.duplicateOf.playerId} />
                        <button name="decision" value="same" className={`${ROW_BUTTON} flex-1`}>
                          Same person
                        </button>
                        <button name="decision" value="different" className={`${SECONDARY_LINK} flex-1`}>
                          Different
                        </button>
                      </form>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Panel>
        )}
      </section>
    </div>
  )
}
