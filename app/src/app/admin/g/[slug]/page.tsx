import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  Button,
  Confirm,
  Disclosure,
  EmptyState,
  Input,
  Label,
  Notice,
  Panel,
  SectionHead,
  StatusPill,
  Tag,
  type Status,
} from '@/components/ui'
import { requireUser } from '@/lib/auth'
import { gatePhase, TICK_STALE_AFTER_MIN } from '@/lib/daily-clock'
import { rupees } from '@/lib/display'
import { publicName } from '@/lib/display'
import { venueDate, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { schedulerHealth } from '@/server/daily-reconcile'
import { countRoster, getSessionBySlug, payerOptions, roster } from '@/server/sessions'
import { Attention, AttentionRow, PRIMARY_LINK, SECONDARY_LINK } from '../../_ui'
import {
  addPerson,
  cancelGame,
  changePayer,
  hidePerson,
  newSpotLink,
  openMoreSpots,
  publishGame,
  removePerson,
  runGateNow,
  setSpots,
} from './actions'
import { GameLink, Nudge } from './link-panel'

/**
 * One game, for the host.
 *
 * Everything on this page is a pure read. Every button posts to a server action
 * — nothing here changes state because a page was rendered, which is the same
 * rule the money will run under and the reason the gate has a visible age
 * rather than quietly happening on someone's refresh.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata(props: PageProps<'/admin/g/[slug]'>) {
  const { slug } = await props.params
  const s = await getSessionBySlug(slug)
  return { title: s ? `${s.title} · Madras Pickleball` : 'Game · Madras Pickleball' }
}

const WORDS: Record<string, { label: string; tone: Status }> = {
  draft: { label: 'Draft', tone: 'waiting' },
  open: { label: 'Open', tone: 'ready' },
  live: { label: 'On now', tone: 'live' },
  ended: { label: 'Finished', tone: 'done' },
  locked: { label: 'Closed', tone: 'done' },
  cancelled: { label: 'Called off', tone: 'alert' },
}

const ROW_WORDS: Record<string, { label: string; tone: Status }> = {
  joined: { label: 'Not confirmed', tone: 'waiting' },
  confirmed: { label: 'Confirmed', tone: 'ready' },
  waitlisted: { label: 'Waiting', tone: 'waiting' },
  checked_in: { label: 'Here', tone: 'live' },
  played: { label: 'Played', tone: 'done' },
  absent: { label: 'Away', tone: 'alert' },
  withdrawn: { label: 'Off the list', tone: 'done' },
}

export default async function AdminGame(props: PageProps<'/admin/g/[slug]'>) {
  await requireUser('admin')
  await ensureReady()
  const { slug } = await props.params
  const { err, done } = await props.searchParams

  const s = await getSessionBySlug(slug)
  if (!s) notFound()

  const now = new Date()
  const over = s.status === 'ended' || s.status === 'locked' || s.status === 'cancelled'
  const entries = await roster(s.id)
  const counts = countRoster(entries)
  const health = await schedulerHealth(now)
  const gate = gatePhase(s, now)
  const staleGate = health.ageMinutes === null || health.ageMinutes > TICK_STALE_AFTER_MIN

  const onList = entries.filter((e) => e.state !== 'withdrawn' && e.state !== 'waitlisted')
  const waiting = entries.filter((e) => e.state === 'waitlisted')
  const off = entries.filter((e) => e.state === 'withdrawn')
  const unconfirmed = onList.filter((e) => e.state === 'joined')
  // Somebody to tell — but only while telling them can still change anything.
  // An attention list that never empties is one the host stops reading.
  const promoted = over ? [] : entries.filter((e) => e.promotedAt && e.state !== 'withdrawn')
  const payers = await payerOptions(s.id)
  const word = WORDS[s.status] ?? WORDS.draft

  const shareText = `${s.title} — ${venueDate(s.startsAt)} ${venueTime(s.startsAt)}–${venueTime(s.endsAt)}, ${s.courtCount === 1 ? '1 court' : `${s.courtCount} courts`}, ${s.pricePaise > 0 ? rupees(s.pricePaise) : 'free'}. ${counts.taken}/${s.capacity} in.`
  const nudgeText = `${s.title} at ${venueTime(s.startsAt)} — tap to say you’re coming —`

  const attentionCount =
    (s.status === 'draft' ? 1 : 0) +
    (gate !== 'before' && unconfirmed.length > 0 && !over ? 1 : 0) +
    promoted.length +
    (staleGate && !over ? 1 : 0)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <div className="flex flex-wrap items-center gap-2.5">
          <h1 className="text-title text-text">{s.title}</h1>
          <StatusPill state={word.tone}>{word.label}</StatusPill>
        </div>
        <p className="num mt-1 text-body text-text-2">
          {venueDate(s.startsAt)} · {venueTime(s.startsAt)}–{venueTime(s.endsAt)} ·{' '}
          {s.courtCount === 1 ? '1 court' : `${s.courtCount} courts`} ·{' '}
          {s.pricePaise > 0 ? rupees(s.pricePaise) : 'Free'}
        </p>
        <p className="num mt-1 text-meta text-text-3">
          {counts.taken}/{s.capacity} in
          {counts.waiting > 0 ? ` · ${counts.waiting} waiting` : ''}
          {counts.here > 0 ? ` · ${counts.here} here` : ''}
        </p>
      </div>

      {err ? (
        <Notice tone="alert" title="Not done">
          {String(err)}
        </Notice>
      ) : null}
      {done ? <Notice tone="done">{String(done)}</Notice> : null}
      {/* Not gated on a reason: the reason is optional, so gating on it left the
          commonest case — cancelled with nothing typed — with no notice at all. */}
      {s.status === 'cancelled' ? (
        <Notice tone="alert" title="Called off" detail={s.cancelReason ?? undefined}>
          This game isn’t happening. Nobody is charged for it, and telling the group is still
          yours to do.
        </Notice>
      ) : null}

      <Attention count={attentionCount}>
        {s.status === 'draft' ? (
          <AttentionRow
            tone="accent"
            what="Nobody can see this game yet"
            where="It stays off the public list until you publish it."
            action={
              <form action={publishGame}>
                <input type="hidden" name="slug" value={slug} />
                <Button type="submit" className="w-full">
                  Publish
                </Button>
              </form>
            }
          />
        ) : null}

        {staleGate && !over ? (
          <AttentionRow
            tone="alert"
            what={
              health.ageMinutes === null
                ? 'The gate has never run'
                : `The gate last ran ${health.ageMinutes} min ago`
            }
            where="Confirmations, the waitlist and auto-end are not happening on their own. Run it now, and get the scheduler looked at."
            action={
              <form action={runGateNow}>
                <input type="hidden" name="slug" value={slug} />
                <Button type="submit" variant="secondary" className="w-full">
                  Run it now
                </Button>
              </form>
            }
          />
        ) : null}

        {gate !== 'before' && unconfirmed.length > 0 && !over ? (
          <AttentionRow
            tone="waiting"
            what={`${unconfirmed.length} ${unconfirmed.length === 1 ? 'person hasn’t' : 'people haven’t'} confirmed`}
            where={
              s.confirmDeadlineAt
                ? `Their spots go to the waitlist at ${venueTime(s.confirmDeadlineAt)}. Send each of them their link.`
                : undefined
            }
            action={
              <Link href={`/admin/g/${slug}#roster` as never} className={SECONDARY_LINK}>
                See who
              </Link>
            }
          />
        ) : null}

        {promoted.map((p) => (
          <AttentionRow
            key={p.id}
            tone="accent"
            what={`${p.name} moved up off the waitlist`}
            where="They do not know yet — tell them."
            action={
              <Nudge
                phone={p.phone}
                text={`You’re in for ${s.title} at ${venueTime(s.startsAt)} —`}
                path={`/s/${p.token}`}
                label="Tell them"
              />
            }
          />
        ))}
      </Attention>

      {s.status !== 'draft' && s.status !== 'cancelled' ? (
        <section className="flex flex-col gap-2.5">
          <SectionHead title="The link" meta="Drop it in the group. It shows the live count." />
          <GameLink path={`/g/${s.slug}`} share={shareText} />
        </section>
      ) : null}

      {!over ? (
        <Link href={`/admin/g/${slug}/tonight` as never} className={PRIMARY_LINK}>
          Tonight
        </Link>
      ) : null}

      <section id="roster" className="flex flex-col gap-2.5">
        <SectionHead
          title="Who’s in"
          meta={`${counts.taken} of ${s.capacity}${counts.unconfirmed > 0 ? ` · ${counts.unconfirmed} not confirmed` : ''}`}
        />
        {onList.length === 0 ? (
          <EmptyState title="Nobody yet">
            <p>Share the link, or put people on yourself below.</p>
          </EmptyState>
        ) : (
          <Panel>
            <ul className="divide-y divide-line">
              {onList.map((e) => {
                const w = ROW_WORDS[e.state] ?? ROW_WORDS.joined
                return (
                  <li key={e.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
                    <div className="min-w-0 sm:flex-1">
                      <p className="text-row text-text">
                        {e.name}
                        {e.isGuest ? <span className="ml-1.5 text-meta text-text-3">guest</span> : null}
                      </p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-meta text-text-3">
                        <span className="num">{e.phone ?? 'no number'}</span>
                        {e.hideFromPublic ? <Tag>Hidden</Tag> : null}
                        {e.isGuest && e.invitedByPlayerId ? (
                          <span>
                            paid for by{' '}
                            {publicName(
                              entries.find((x) => x.playerId === e.payerPlayerId)?.name ?? 'somebody',
                            )}
                          </span>
                        ) : null}
                      </p>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-2">
                      <StatusPill state={w.tone}>{w.label}</StatusPill>
                      {e.state === 'joined' && gate !== 'before' && !over ? (
                        <Nudge phone={e.phone} text={nudgeText} path={`/s/${e.token}`} label="Nudge" />
                      ) : null}
                      {!over ? (
                        <Confirm label="Off" question={`Take ${e.name} off this list?`}>
                          <form action={removePerson}>
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="participantId" value={e.id} />
                            <Button type="submit" variant="secondary" className="w-full">
                              Take them off
                            </Button>
                          </form>
                        </Confirm>
                      ) : null}
                    </div>
                    {!over ? (
                      <details className="group w-full sm:w-auto">
                        <summary className="tap flex items-center justify-center rounded-control border border-line-key bg-paper px-3.5 text-[16px] font-semibold text-text-2">
                          More
                        </summary>
                        <div className="mt-2 flex flex-col gap-2.5 rounded-control border border-line-strong bg-sunken p-3.5">
                          <form action={newSpotLink} className="flex flex-col gap-2">
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="participantId" value={e.id} />
                            <Button type="submit" variant="secondary" className="w-full">
                              Give them a new link
                            </Button>
                          </form>
                          <form action={hidePerson} className="flex flex-col gap-2">
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="participantId" value={e.id} />
                            <input type="hidden" name="hidden" value={e.hideFromPublic ? 'off' : 'on'} />
                            <Button type="submit" variant="secondary" className="w-full">
                              {e.hideFromPublic ? 'Show their name publicly' : 'Keep their name off the list'}
                            </Button>
                          </form>
                          {payers.length > 1 ? (
                            <form action={changePayer} className="flex flex-col gap-2">
                              <input type="hidden" name="slug" value={slug} />
                              <input type="hidden" name="participantId" value={e.id} />
                              <label className="block text-meta text-text-2" htmlFor={`payer-${e.id}`}>
                                Who pays for this one
                              </label>
                              <select
                                id={`payer-${e.id}`}
                                name="payerPlayerId"
                                defaultValue={e.payerPlayerId}
                                className="tap w-full rounded-control border border-line-key bg-paper px-3.5 text-body text-text focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none"
                              >
                                <option value={e.playerId}>{e.name} — themselves</option>
                                {payers
                                  .filter((o) => o.playerId !== e.playerId)
                                  .map((o) => (
                                    <option key={o.playerId} value={o.playerId}>
                                      {o.name}
                                    </option>
                                  ))}
                              </select>
                              <Button type="submit" variant="secondary" className="w-full">
                                Change who pays
                              </Button>
                            </form>
                          ) : null}
                        </div>
                      </details>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Panel>
        )}
      </section>

      {waiting.length > 0 ? (
        <section className="flex flex-col gap-2.5">
          <SectionHead title="Waiting" meta="First on the list takes the next free spot." />
          <Panel>
            <ul className="divide-y divide-line">
              {waiting.map((e, i) => (
                <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="num w-6 shrink-0 text-meta text-text-3">{i + 1}</span>
                  <span className="min-w-0 flex-1 text-row text-text-2">{e.name}</span>
                  {!over ? (
                    <Confirm label="Off" question={`Take ${e.name} off the waitlist?`}>
                      <form action={removePerson}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="participantId" value={e.id} />
                        <Button type="submit" variant="secondary" className="w-full">
                          Take them off
                        </Button>
                      </form>
                    </Confirm>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}

      {!over ? (
        <section className="flex flex-col gap-2.5">
          <SectionHead title="Put somebody on" meta="A name is enough. A third of people reply in the group." />
          <form action={addPerson} className="flex flex-col gap-3">
            <input type="hidden" name="slug" value={slug} />
            <div>
              <Label htmlFor="add-name">Name</Label>
              <Input id="add-name" name="name" required maxLength={60} className="mt-2" placeholder="Deepak Raj" />
            </div>
            <div>
              <Label htmlFor="add-phone">
                Phone <span className="font-normal text-text-3">· optional</span>
              </Label>
              <Input id="add-phone" name="phone" type="tel" inputMode="tel" className="mt-2" placeholder="98400 12345" />
            </div>
            {onList.length > 0 ? (
              <div>
                <Label htmlFor="add-guest">
                  Somebody’s guest? <span className="font-normal text-text-3">· optional</span>
                </Label>
                <select
                  id="add-guest"
                  name="guestOf"
                  defaultValue=""
                  className="tap mt-2 w-full rounded-control border border-line-key bg-paper px-3.5 text-body text-text"
                >
                  <option value="">No — they pay for themselves</option>
                  {onList
                    .filter((e) => !e.isGuest)
                    .map((e) => (
                      <option key={e.playerId} value={e.playerId}>
                        Guest of {e.name}
                      </option>
                    ))}
                </select>
                <span className="mt-1.5 block text-meta text-text-3">
                  The guest plays as themselves; the bill goes to whoever brought them.
                </span>
              </div>
            ) : null}
            <Button type="submit" variant="secondary" className="w-full">
              Put them on
            </Button>
          </form>
        </section>
      ) : null}

      {!over ? (
        <section className="flex flex-col gap-2.5">
          <SectionHead title="Spots" meta={`${s.capacity} now. Lowering it never turns anybody out.`} />
          <div className="flex flex-wrap gap-2">
            <form action={openMoreSpots} className="flex-1">
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="by" value="4" />
              <Button type="submit" variant="secondary" className="w-full">
                Open 4 more
              </Button>
            </form>
          </div>
          <Disclosure summary="Set a number" meta="For when four is the wrong answer">
            <form action={setSpots} className="flex items-end gap-2">
              <input type="hidden" name="slug" value={slug} />
              <div className="flex-1">
                <Label htmlFor="cap">Spots</Label>
                <Input id="cap" name="capacity" type="number" min={1} max={200} defaultValue={s.capacity} className="mt-2" />
              </div>
              <Button type="submit" variant="secondary">
                Set
              </Button>
            </form>
          </Disclosure>
        </section>
      ) : null}

      {off.length > 0 ? (
        <Disclosure summary="Dropped out" meta={`${off.length} ${off.length === 1 ? 'person' : 'people'}`}>
          <ul className="divide-y divide-line rounded-control border border-line bg-paper">
            {off.map((e) => (
              <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1 text-row text-text-3">{e.name}</span>
                <span className="text-meta text-text-3">
                  {e.withdrawReason ?? 'left'}
                  {e.withdrawnBy ? ` · ${e.withdrawnBy}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </Disclosure>
      ) : null}

      {!over ? (
        <Confirm
          label="Call it off"
          question={`Call off ${s.title} on ${venueDate(s.startsAt)}?`}
          detail="Everyone on the list keeps their record of it and nobody is charged. Tell the group yourself — this does not message anybody."
        >
          <form action={cancelGame} className="flex flex-col gap-2.5">
            <input type="hidden" name="slug" value={slug} />
            <Input name="reason" maxLength={200} placeholder="Rain" />
            <Button type="submit" variant="secondary" className="w-full">
              Call it off
            </Button>
          </form>
        </Confirm>
      ) : null}

      <Link href="/admin/games" className={SECONDARY_LINK}>
        All games
      </Link>
    </div>
  )
}
