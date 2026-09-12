import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  Button,
  Confirm,
  CourtSwatch,
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
import { courtsLabel, publicName, rupees, rupeesPlain } from '@/lib/display'
import { venueDate, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { freeCourtsBetween } from '@/server/courts'
import { schedulerHealth } from '@/server/daily-reconcile'
import { sessionMoney, type SessionCharge } from '@/server/money'
import { countRoster, getSessionBySlug, payerOptions, roster, sessionCourts } from '@/server/sessions'
import { getVenue } from '@/server/tournaments'
import { chargeWords } from '../../_money'
import { Attention, AttentionRow, PRIMARY_LINK, SECONDARY_LINK } from '../../_ui'
import {
  addPerson,
  cancelGame,
  changePayer,
  clearPrice,
  correctMoney,
  hidePerson,
  newSpotLink,
  openMoreSpots,
  publishGame,
  removePerson,
  runGateNow,
  setGameCourts,
  setPrice,
  setSpots,
  takeMoney,
  waiveMoney,
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
  // Wider than `over` on purpose: the 45 minutes between the finish and the
  // lock is exactly when a host notices the coach was about to be billed, and
  // it is the last moment an override can still reach the charge.
  const priceable = s.status !== 'locked' && s.status !== 'cancelled'
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

  // The courts this game has, and everything else at the venue with whoever
  // has it during these hours — so "Court 3 is free" is visible rather than
  // guessed at.
  const venue = await getVenue()
  const [mine, allCourts] = await Promise.all([
    sessionCourts(s.id),
    freeCourtsBetween(s.startsAt, s.endsAt, venue.id),
  ])
  // What the night actually billed, once it is a fact. Read only when it is
  // one: before the lock there are no charges, and the provisional amount lives
  // on the Tonight screen where the host is still able to change it.
  const money = s.status === 'locked' ? await sessionMoney(s.id) : null
  const charged = onList
    .map((e) => ({ e, c: money?.get(e.id) }))
    .filter((r): r is { e: (typeof onList)[number]; c: SessionCharge } => !!r.c)
  const owing = charged.filter((r) => r.c.state === 'locked' && r.c.duePaise > 0)
  const settled = charged.filter((r) => !(r.c.state === 'locked' && r.c.duePaise > 0))
  const owedPaise = owing.reduce((n, r) => n + r.c.duePaise, 0)
  // "Settled", not "in": `appliedPaise` counts a charge closed by a credit, and
  // a credit never went near the drawer. The day-end tally is where money that
  // actually arrived is split by how it arrived; this line only says how much
  // of the night stopped being owed.
  const settledPaise = charged.reduce((n, r) => n + r.c.appliedPaise, 0)

  const mineIds = new Set(mine.map((c) => c.id))
  const courtChoices = allCourts.map((c) => ({
    ...c,
    mine: mineIds.has(c.id),
    takenBy: c.takenBy && c.takenBy.sessionId !== s.id ? c.takenBy.holderName : null,
  }))
  const word = WORDS[s.status] ?? WORDS.draft

  const shareText = `${s.title} — ${venueDate(s.startsAt)} ${venueTime(s.startsAt)}–${venueTime(s.endsAt)}, ${courtsLabel(mine.map((c) => c.name), s.courtCount)}, ${s.pricePaise > 0 ? rupees(s.pricePaise) : 'free'}. ${counts.taken}/${s.capacity} in.`
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
          {courtsLabel(mine.map((c) => c.name), s.courtCount)} ·{' '}
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

      {/* m1, m2, m3 — only once the night is locked, because until then there
          is no charge to take, correct or waive, and a screen that offers all
          three against a number that can still move is a screen that takes
          money for a night somebody may yet be marked away from. */}
      {money ? (
        <section className="flex flex-col gap-2.5">
          <SectionHead
            title="Money"
            meta={
              owedPaise > 0
                ? `${rupees(owedPaise)} still to collect · ${rupees(settledPaise)} settled`
                : `Nothing outstanding · ${rupees(settledPaise)} settled`
            }
          />

          {charged.length === 0 ? (
            <EmptyState title="Nothing was charged">
              <p>Nobody was ticked off as having played, so this night billed no one.</p>
            </EmptyState>
          ) : owing.length === 0 ? (
            <EmptyState title="Everybody has settled">
              <p>Every charge for this night is paid, waived or written off.</p>
            </EmptyState>
          ) : (
            <Panel>
              <ul className="divide-y divide-line">
                {owing.map(({ e, c }) => {
                  const who = entries.find((x) => x.playerId === c.payerPlayerId)?.name ?? e.name
                  const part = c.appliedPaise > 0
                  return (
                    <li key={c.chargeId} className="flex flex-col gap-2.5 px-4 py-3.5">
                      <div className="flex flex-wrap items-center gap-2.5">
                        <div className="min-w-0 flex-1">
                          <p className="text-row text-text">
                            {who}
                            {c.payerPlayerId !== e.playerId ? (
                              <span className="ml-1.5 text-meta text-text-3">for {e.name}</span>
                            ) : null}
                          </p>
                          <p className="num mt-0.5 text-meta text-text-3">
                            {rupees(c.amountPaise + c.adjustPaise)} charged
                            {c.appliedPaise > 0 ? ` · ${rupees(c.appliedPaise)} paid` : ''}
                            {c.priceSource === 'override' && c.priceNote ? ` · ${c.priceNote}` : ''}
                          </p>
                        </div>
                        <span className="num text-section text-text">{rupees(c.duePaise)}</span>
                        <StatusPill state={part ? 'waiting' : 'alert'}>
                          {part ? 'Part paid' : 'Unpaid'}
                        </StatusPill>
                      </div>

                      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                        <Confirm
                          className="sm:flex-1"
                          label="Take the money"
                          question={`${rupees(c.duePaise)} from ${who}?`}
                          detail="It is recorded the moment you tap. Cash has to match the drawer and a venue QR has to match the venue’s own statement, so they are never one number."
                        >
                          {/* One form, two submits: the amount and how it came
                              in are the same act, and ₹200 of a ₹300 bill is
                              the ordinary Tuesday, not the exotic one. */}
                          <form action={takeMoney} className="flex flex-col gap-2.5">
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="participantId" value={e.id} />
                            <div>
                              <Label htmlFor={`take-${c.chargeId}`}>
                                How much{' '}
                                <span className="font-normal text-text-3">
                                  · leave it empty for all {rupees(c.duePaise)}
                                </span>
                              </Label>
                              <Input
                                id={`take-${c.chargeId}`}
                                name="amount"
                                inputMode="decimal"
                                className="mt-2"
                                placeholder={rupeesPlain(c.duePaise)}
                              />
                            </div>
                            <div className="flex flex-col gap-2 sm:flex-row">
                              <Button type="submit" name="method" value="cash" className="w-full sm:flex-1">
                                Cash
                              </Button>
                              <Button
                                type="submit"
                                name="method"
                                value="venue_qr"
                                variant="secondary"
                                className="w-full sm:flex-1"
                              >
                                Venue QR
                              </Button>
                            </div>
                          </form>
                        </Confirm>

                        <CorrectIt
                          slug={slug}
                          participantId={e.id}
                          who={who}
                          nowPaise={c.amountPaise + c.adjustPaise}
                        />

                        {c.appliedPaise === 0 ? (
                          <Confirm
                            className="sm:flex-1"
                            label="Waive it"
                            question={`${who} isn’t charged for this night?`}
                            detail="Only while nothing has been paid onto it. The charge closes with your reason beside your name — it is never deleted."
                          >
                            <form action={waiveMoney} className="flex flex-col gap-2.5">
                              <input type="hidden" name="slug" value={slug} />
                              <input type="hidden" name="participantId" value={e.id} />
                              <Input
                                name="reason"
                                required
                                maxLength={200}
                                aria-label={`Why ${who} isn’t charged`}
                                placeholder="Came for ten minutes"
                              />
                              <Button type="submit" variant="secondary" className="w-full">
                                Waive it
                              </Button>
                            </form>
                          </Confirm>
                        ) : null}
                      </div>
                    </li>
                  )
                })}
              </ul>
            </Panel>
          )}

          {/* A settled charge is exactly the one SPEC-v4 §4 works through: she
              paid, and it turns out she shouldn't have. Correcting it has to be
              reachable, or the worked example has no screen. */}
          {settled.length > 0 ? (
            <Disclosure summary="Settled" meta={`${settled.length} ${settled.length === 1 ? 'charge' : 'charges'}`}>
              <ul className="divide-y divide-line rounded-control border border-line bg-paper">
                {settled.map(({ e, c }) => {
                  const who = entries.find((x) => x.playerId === c.payerPlayerId)?.name ?? e.name
                  return (
                    <li key={c.chargeId} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
                      <div className="min-w-0 sm:flex-1">
                        <p className="text-row text-text-2">
                          {who}
                          {c.payerPlayerId !== e.playerId ? (
                            <span className="ml-1.5 text-meta text-text-3">for {e.name}</span>
                          ) : null}
                        </p>
                        {/* The same words the Tonight screen uses, from the
                            same function — a ₹0 coach charge was never "paid",
                            it was free, and the two screens must not disagree
                            about that in front of the coach. */}
                        <p className="num mt-0.5 text-meta text-text-3">{chargeWords(c)}</p>
                      </div>
                      {c.state === 'locked' ? (
                        <CorrectIt
                          slug={slug}
                          participantId={e.id}
                          who={who}
                          nowPaise={c.amountPaise + c.adjustPaise}
                        />
                      ) : null}
                    </li>
                  )
                })}
              </ul>
            </Disclosure>
          ) : null}

          <Link href="/admin/money" className={SECONDARY_LINK}>
            The day’s money
          </Link>
        </section>
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
                        {e.priceOverridePaise !== null ? (
                          <Tag tone="accent">
                            <span className="num">{rupees(e.priceOverridePaise)}</span>
                            {e.priceNote ? ` · ${e.priceNote}` : ''}
                          </Tag>
                        ) : null}
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
                    {priceable ? (
                      <details className="group w-full sm:w-auto">
                        <summary className="tap flex items-center justify-center rounded-control border border-line-key bg-paper px-3.5 text-[16px] font-semibold text-text-2">
                          More
                        </summary>
                        <div className="mt-2 flex flex-col gap-2.5 rounded-control border border-line-strong bg-sunken p-3.5">
                          {/* The rest of More is unchanged: the list itself
                              stops moving once the game is over. */}
                          {!over ? (
                            <>
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
                            </>
                          ) : null}
                          {/* m5 — on this night's participation, never on the
                              player: a coach who turns up on Sunday to play
                              should pay. The note is not optional, because a ₹0
                              charge with no reason reads in the ledger exactly
                              like a billing bug. */}
                          <form action={setPrice} className="flex flex-col gap-2">
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="participantId" value={e.id} />
                            <label className="block text-meta text-text-2" htmlFor={`price-${e.id}`}>
                              What this one pays
                            </label>
                            <div className="flex gap-2">
                              <div className="w-24 shrink-0">
                                <Input
                                  id={`price-${e.id}`}
                                  name="amount"
                                  required
                                  inputMode="decimal"
                                  defaultValue={
                                    e.priceOverridePaise === null ? '' : rupeesPlain(e.priceOverridePaise)
                                  }
                                  placeholder={rupeesPlain(s.pricePaise)}
                                />
                              </div>
                              <div className="min-w-0 flex-1">
                                <Input
                                  name="note"
                                  required
                                  maxLength={120}
                                  defaultValue={e.priceNote ?? ''}
                                  placeholder="Coach"
                                  aria-label={`Why ${e.name} pays that`}
                                />
                              </div>
                            </div>
                            <Button type="submit" variant="secondary" className="w-full">
                              Set their price
                            </Button>
                            <span className="text-meta text-text-3">
                              Both together, always — the amount and the reason go onto the charge.
                            </span>
                          </form>
                          {e.priceOverridePaise !== null ? (
                            <form action={clearPrice} className="flex flex-col gap-2">
                              <input type="hidden" name="slug" value={slug} />
                              <input type="hidden" name="participantId" value={e.id} />
                              <Button type="submit" variant="secondary" className="w-full">
                                Back to {s.pricePaise > 0 ? rupees(s.pricePaise) : 'free'}
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
          <SectionHead
            title="Courts and hours"
            meta={
              mine.length
                ? `${mine.map((c) => c.name).join(', ')} until ${venueTime(s.endsAt)}.`
                : 'This game has no courts held for it.'
            }
          />
          <form action={setGameCourts} className="flex flex-col gap-3">
            <input type="hidden" name="slug" value={slug} />
            <div className="flex flex-wrap gap-2">
              {courtChoices.map((c) => (
                <label
                  key={c.id}
                  className="tap inline-flex cursor-pointer items-center gap-2 rounded-full border border-line-key bg-paper px-3.5 text-[16px] font-semibold text-text has-checked:border-ink has-checked:bg-ink has-checked:text-white"
                >
                  <input
                    type="checkbox"
                    name="courts"
                    value={c.id}
                    defaultChecked={c.mine}
                    className="sr-only"
                  />
                  <CourtSwatch colorKey={c.colorKey} size="md" />
                  {c.name}
                  {c.takenBy ? <span className="font-normal">· {c.takenBy}</span> : null}
                </label>
              ))}
            </div>
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Label htmlFor="finish">Finishes at</Label>
                <Input
                  id="finish"
                  name="finish"
                  type="time"
                  defaultValue={venueTime(s.endsAt)}
                  className="mt-2"
                />
              </div>
              <Button type="submit" variant="secondary">
                Save
              </Button>
            </div>
            <p className="text-meta text-text-3">
              “Can we go till 9:30, Court 3 is free” — this is that. A court somebody else has for
              these hours is named here and refused on save.
            </p>
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

/**
 * Correcting one charge — the same form for one that is still owed and one that
 * has already been paid, because the hard case is the paid one.
 *
 * The host types what it SHOULD be rather than the difference: at the desk the
 * known number is "it should have been ₹150". The action reads what it is now
 * back from the database and works out the correction itself, so a screen that
 * is one correction old cannot post a delta from a stale number.
 */
function CorrectIt({
  slug,
  participantId,
  who,
  nowPaise,
}: {
  slug: string
  participantId: string
  who: string
  nowPaise: number
}) {
  return (
    <Confirm
      className="sm:flex-1"
      label="Correct it"
      question={`What should ${who} be charged for this night?`}
      detail="The charge itself never changes — this puts a signed correction beside it with your name on the reason. Anything already paid that is no longer owed goes back onto their account."
    >
      <form action={correctMoney} className="flex flex-col gap-2.5">
        <input type="hidden" name="slug" value={slug} />
        <input type="hidden" name="participantId" value={participantId} />
        <div>
          <Label htmlFor={`fix-${participantId}`}>What it should be</Label>
          <Input
            id={`fix-${participantId}`}
            name="amount"
            required
            inputMode="decimal"
            className="mt-2"
            defaultValue={rupeesPlain(nowPaise)}
          />
        </div>
        <div>
          <Label htmlFor={`why-${participantId}`}>Why</Label>
          <Input
            id={`why-${participantId}`}
            name="reason"
            required
            maxLength={200}
            className="mt-2"
            placeholder="Left at half time"
          />
        </div>
        <Button type="submit" variant="secondary" className="w-full">
          Correct it
        </Button>
      </form>
    </Confirm>
  )
}
