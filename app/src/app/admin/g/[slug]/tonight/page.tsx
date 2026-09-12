import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Button, Confirm, EmptyState, Input, Label, Meter, Notice, Panel, StatusPill, Tag } from '@/components/ui'
import { requireUser } from '@/lib/auth'
import { TICK_STALE_AFTER_MIN } from '@/lib/daily-clock'
import { courtsLabel, rupees } from '@/lib/display'
import { venueClock, venueDate, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { schedulerHealth } from '@/server/daily-reconcile'
import { effectivePrice, provisionalFor, sessionMoney } from '@/server/money'
import { countRoster, getSessionBySlug, roster, sessionCourts } from '@/server/sessions'
import { Eyebrow } from '../../../../t/court-card'
import { chargeWords } from '../../../_money'
import { SECONDARY_LINK } from '../../../_ui'
import {
  addPerson,
  endGame,
  markAllPresent,
  markPresent,
  promoteFromWaitlist,
  removePerson,
  runGateNow,
  startGame,
} from '../actions'
import { Nudge } from '../link-panel'

/**
 * Tonight.
 *
 * One list, one row per human: name, here?, money. This is the screen the host
 * is holding while sixteen people arrive, so it is one screen and not four, the
 * targets are the big ones, and the only thing it asks for is a tap.
 *
 * That tap is the load-bearing human act in the whole cycle — there is no
 * sensor that knows who played, and everything downstream is only as good as
 * one person spending a minute here. Ticking somebody off does not navigate:
 * a redirect resets the scroll position, and being thrown back to the top after
 * the fourteenth of sixteen names is how a screen like this stops being used.
 */
export const dynamic = 'force-dynamic'

export async function generateMetadata(props: PageProps<'/admin/g/[slug]/tonight'>) {
  const { slug } = await props.params
  const s = await getSessionBySlug(slug)
  return { title: s ? `Tonight · ${s.title}` : 'Tonight · Madras Pickleball' }
}

export default async function Tonight(props: PageProps<'/admin/g/[slug]/tonight'>) {
  await requireUser('admin')
  await ensureReady()
  const { slug } = await props.params
  const { err, done } = await props.searchParams

  const s = await getSessionBySlug(slug)
  if (!s) notFound()

  const now = new Date()
  const entries = await roster(s.id)
  const counts = countRoster(entries)
  const courtNames = (await sessionCourts(s.id)).map((c) => c.name)
  const health = await schedulerHealth(now)

  const playing = entries.filter((e) => e.state !== 'withdrawn' && e.state !== 'waitlisted')
  const waiting = entries.filter((e) => e.state === 'waitlisted')
  const names = new Map(entries.map((e) => [e.playerId, e.name]))
  const locked = s.status === 'locked'
  const cancelled = s.status === 'cancelled'
  const draft = s.status === 'draft'
  const open = s.status === 'open'
  const closedOff = locked || cancelled
  const toTick = playing.filter((e) => e.state === 'joined' || e.state === 'confirmed').length
  const staleGate = health.ageMinutes === null || health.ageMinutes > TICK_STALE_AFTER_MIN

  /**
   * The money column — m6 before the lock, the real charge after it.
   *
   * Before the lock this is `provisionalFor`, which is the same `effectivePrice`
   * the lock itself uses. The screen that promises an amount and the code that
   * writes the charge must agree, or the app's own screen becomes the evidence
   * in the dispute it was built to prevent — so neither of them multiplies a
   * head count by a price here.
   */
  const money = locked ? await sessionMoney(s.id) : null
  const provisional = locked
    ? null
    : provisionalFor(
        s,
        entries.map((e) => ({ ...e, displayName: e.name })),
      )

  const moneyWords = new Map<string, string>()
  if (money) {
    for (const [participationId, c] of money) moneyWords.set(participationId, chargeWords(c))
  } else if (provisional) {
    for (const l of provisional.lines) {
      moneyWords.set(
        l.participationId,
        l.paise === 0 && l.source === 'session' ? 'free' : `${rupees(l.paise)}${l.note ? ` · ${l.note}` : ''}`,
      )
    }
    /**
     * Everybody else still on the list gets what they WILL owe.
     *
     * This is the screen whose whole job is ticking people off, and "nothing to
     * pay" beside fourteen names who have simply not been tapped yet is the
     * screen arguing against its own purpose. The price comes from
     * `effectivePrice` — the one place it is decided — and never from
     * multiplying the game's price here.
     */
    for (const e of playing) {
      if (moneyWords.has(e.id) || e.state === 'absent') continue
      const price = effectivePrice(s, e)
      const free = price.paise === 0 && price.source === 'session'
      moneyWords.set(
        e.id,
        free ? 'free' : `${rupees(price.paise)} when ticked off${price.note ? ` · ${price.note}` : ''}`,
      )
    }
  }

  /**
   * What the night came to, and what became of it.
   *
   * Charged, settled, waived, written off and still owed are five separate
   * facts and they add up: a night where every charge was waived used to read
   * "₹4,800 charged · all settled", which is the opposite of what happened.
   * Nothing was settled; ₹4,800 was given away, and the line has to say so.
   */
  let chargedPaise = 0
  let settledPaise = 0
  let waivedPaise = 0
  let writtenOffPaise = 0
  let stillOwedPaise = 0
  if (money) {
    for (const c of money.values()) {
      chargedPaise += c.amountPaise + c.adjustPaise
      settledPaise += c.appliedPaise
      if (c.state === 'waived') waivedPaise += c.duePaise
      else if (c.state === 'written_off') writtenOffPaise += c.duePaise
      else stillOwedPaise += c.duePaise
    }
  }

  const outcome = [
    settledPaise > 0 ? `${rupees(settledPaise)} settled` : null,
    waivedPaise > 0 ? `${rupees(waivedPaise)} waived` : null,
    writtenOffPaise > 0 ? `${rupees(writtenOffPaise)} written off` : null,
    stillOwedPaise > 0 ? `${rupees(stillOwedPaise)} still owed` : null,
  ].filter((w): w is string => w !== null)

  const provisionalPaise = provisional?.totalPaise ?? 0
  const moneyLine = money
    ? [`${rupees(chargedPaise)} charged`, ...(outcome.length ? outcome : ['nothing to collect'])].join(' · ')
    : `${rupees(s.pricePaise)} a head · ${rupees(provisionalPaise)} so far`
  const anyMoney = s.pricePaise > 0 || chargedPaise > 0 || provisionalPaise > 0

  /**
   * When it locks, from the row and only from the row.
   *
   * `lockAt` is written when the game ends, so before that there is no clock
   * time to show and the honest sentence has no number in it. Adding 45 minutes
   * to the finish here would put a time on screen that the reconciler has never
   * agreed to and that a rescheduled finish would silently move.
   *
   * `venueClock`, not `venueTime`: this is a time inside a sentence, and a
   * night that locks at midnight should say so.
   *
   * A lock time that has been and gone is not a promise any more. Left as
   * "Locks at 9:45 pm" it sat there all night, on the same screen already
   * warning that the gate was not running — two lines contradicting each other,
   * and the wrong one is the reassuring one.
   */
  const lockOverdue = !locked && !cancelled && s.lockAt !== null && s.lockAt <= now
  const lockWords = cancelled
    ? null
    : locked
      ? 'Closed. What everyone owes is fixed now.'
      : lockOverdue && s.lockAt
        ? `It should have closed at ${venueClock(s.lockAt)} and hasn’t. Nobody is charged until the gate runs — run it below.`
        : s.lockAt
          ? `Locks at ${venueClock(s.lockAt)} — until then all of this can still change.`
          : 'Locking about 45 minutes after the game ends.'

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-title text-text">{s.title}</h1>
        <p className="num mt-1 text-body text-text-2">
          {venueDate(s.startsAt)} · {venueTime(s.startsAt)}–{venueTime(s.endsAt)} ·{' '}
          {courtsLabel(courtNames, s.courtCount)}
        </p>
        <p className="num mt-1 text-meta text-text-3">
          {counts.here} of {counts.taken} here
          {anyMoney ? ` · ${moneyLine}` : ' · free'}
        </p>
        {lockWords ? (
          <p className={lockOverdue ? 'mt-1 text-meta text-alert' : 'mt-1 text-meta text-text-3'}>{lockWords}</p>
        ) : null}
        <Meter
          className="mt-2"
          done={counts.here}
          total={Math.max(counts.taken, 1)}
          label={`${counts.here} of ${counts.taken} people ticked off`}
        />
      </div>

      {err ? (
        <Notice tone="alert" title="Not done">
          {String(err)}
        </Notice>
      ) : null}
      {done ? <Notice tone="done">{String(done)}</Notice> : null}

      {cancelled ? (
        <Notice tone="alert" title="Called off">
          This game was called off. Nobody is charged.
        </Notice>
      ) : locked ? (
        <Notice tone="done" title="Night closed">
          Who played is fixed now. A correction from here becomes an adjustment once billing is
          switched on.
        </Notice>
      ) : null}

      {/* The badge that replaces doing this work on a page render. If it is red,
          nothing is happening on its own and the host is the scheduler. */}
      {staleGate && !closedOff ? (
        <Notice
          tone="alert"
          title="Gate not running"
          detail={
            health.ageMinutes === null
              ? 'It has never run on this database.'
              : `It last ran ${health.ageMinutes} min ago.`
          }
          action={
            <form action={runGateNow}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="from" value="tonight" />
              <Button type="submit" variant="secondary" className="w-full">
                Run it now
              </Button>
            </form>
          }
        >
          Confirmations, the waitlist and finishing the night are not happening on their own.
        </Notice>
      ) : null}

      {draft && !closedOff ? (
        <Notice tone="waiting" title="Not published">
          Nobody can join this game yet. Publish it from the game page first.
        </Notice>
      ) : null}

      {open && !closedOff ? (
        <form action={startGame}>
          <input type="hidden" name="slug" value={slug} />
          <Button type="submit" className="w-full">
            Start
          </Button>
        </form>
      ) : null}

      {!closedOff && !draft && !open && toTick > 0 ? (
        <Confirm
          label={`All here (${toTick})`}
          question={`Tick off all ${toTick} who haven’t been marked yet?`}
          detail="Who is ticked off is what decides who gets charged. Un-tap anybody who didn’t come."
        >
          <form action={markAllPresent}>
            <input type="hidden" name="slug" value={slug} />
            <Button type="submit" className="w-full">
              Yes, all here
            </Button>
          </form>
        </Confirm>
      ) : null}

      <section>
        <Eyebrow count={playing.length}>On the list</Eyebrow>
        {playing.length === 0 ? (
          <div className="mt-2">
            <EmptyState title="Nobody on the list">
              <p>Add whoever turns up below — a name is enough.</p>
            </EmptyState>
          </div>
        ) : (
          <Panel className="mt-2">
            <ul className="divide-y divide-line">
              {playing.map((e) => {
                const here = e.state === 'checked_in' || e.state === 'played'
                const away = e.state === 'absent'
                return (
                  <li key={e.id} className="flex items-center gap-4 px-4 py-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-row text-text">
                        {e.name}
                        {e.isGuest ? (
                          <span className="ml-1.5 text-meta text-text-3">
                            guest of {names.get(e.payerPlayerId) ?? 'somebody'}
                          </span>
                        ) : null}
                      </p>
                      <p className="num mt-0.5 text-meta text-text-3">
                        {/* Somebody away, or not yet ticked off, has no line in
                            the provisional and no charge after the lock — so
                            the column says so rather than showing a price they
                            are not going to be asked for. */}
                        {moneyWords.get(e.id) ?? 'nothing to pay'}
                        {e.state === 'joined' ? ' · not confirmed' : ''}
                      </p>
                    </div>
                    {closedOff ? (
                      <StatusPill state={here ? 'live' : away ? 'alert' : 'done'}>
                        {here ? 'Played' : away ? 'Away' : 'On the list'}
                      </StatusPill>
                    ) : (
                      <form action={markPresent} className="shrink-0">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="participantId" value={e.id} />
                        <input type="hidden" name="present" value={here ? 'off' : 'on'} />
                        <button
                          type="submit"
                          aria-pressed={here}
                          aria-label={`${e.name} — here`}
                          className={
                            here
                              ? 'tap-lg inline-flex min-w-[108px] items-center justify-center rounded-control bg-ink text-[18px] font-bold text-white'
                              : 'tap-lg inline-flex min-w-[108px] items-center justify-center rounded-control border-2 border-line-key bg-paper text-[18px] font-bold text-text-2'
                          }
                        >
                          {here ? 'Here' : 'Not here'}
                        </button>
                      </form>
                    )}
                  </li>
                )
              })}
            </ul>
          </Panel>
        )}
      </section>

      {!closedOff && playing.some((e) => e.state === 'joined') ? (
        <section className="flex flex-col gap-2.5">
          <Eyebrow>Where are they?</Eyebrow>
          <ul className="flex flex-col gap-2">
            {playing
              .filter((e) => e.state === 'joined')
              .map((e) => (
                <li key={e.id} className="flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-row text-text-2">{e.name}</span>
                  <Nudge
                    phone={e.phone}
                    text={`${s.title} — are you coming? Tap here —`}
                    path={`/s/${e.token}`}
                    label="Message"
                  />
                </li>
              ))}
          </ul>
        </section>
      ) : null}

      {waiting.length > 0 ? (
        <section>
          <Eyebrow count={waiting.length}>Waiting</Eyebrow>
          <Panel className="mt-2">
            <ul className="divide-y divide-line">
              {waiting.map((e, i) => (
                <li key={e.id} className="flex items-center gap-4 px-4 py-3">
                  <span className="num w-6 shrink-0 text-meta text-text-3">{i + 1}</span>
                  <span className="min-w-0 flex-1 text-row text-text-2">{e.name}</span>
                  {closedOff ? (
                    <Tag tone="waiting">Waiting</Tag>
                  ) : (
                    <form action={promoteFromWaitlist} className="shrink-0">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="participantId" value={e.id} />
                      <Button type="submit" variant="secondary" className="px-4">
                        Put them in
                      </Button>
                    </form>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}

      {!closedOff ? (
        <section className="flex flex-col gap-2.5">
          <Eyebrow>Walk-in</Eyebrow>
          <form action={addPerson} className="flex flex-col gap-2.5">
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="from" value="tonight" />
            <input type="hidden" name="walkIn" value="on" />
            <div>
              <Label htmlFor="walk-name">Name</Label>
              <Input id="walk-name" name="name" required maxLength={60} className="mt-2" placeholder="Deepak Raj" />
            </div>
            {playing.length > 0 ? (
              <div>
                <Label htmlFor="walk-guest">
                  Somebody’s guest? <span className="font-normal text-text-3">· optional</span>
                </Label>
                <select
                  id="walk-guest"
                  name="guestOf"
                  defaultValue=""
                  className="tap mt-2 w-full rounded-control border border-line-key bg-paper px-3.5 text-body text-text focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none"
                >
                  <option value="">No — they pay for themselves</option>
                  {playing
                    .filter((e) => !e.isGuest)
                    .map((e) => (
                      <option key={e.playerId} value={e.playerId}>
                        Guest of {e.name}
                      </option>
                    ))}
                </select>
              </div>
            ) : null}
            <Button type="submit" variant="secondary" className="w-full">
              Add and tick them off
            </Button>
            <p className="text-meta text-text-3">
              Goes straight on as here. If the list is already full it opens one more spot.
            </p>
          </form>
        </section>
      ) : null}

      {!closedOff && !draft && !open ? (
        <div className="mt-2 border-t border-line pt-5">
          <Confirm
            label="That’s it for tonight"
            question={`Finish ${s.title}?`}
            detail="You have 45 minutes after this to fix who turned up. After that it is final, and nobody who wasn’t ticked off is charged."
            size="lg"
          >
            <form action={endGame}>
              <input type="hidden" name="slug" value={slug} />
              <Button type="submit" className="w-full">
                Finish
              </Button>
            </form>
          </Confirm>
        </div>
      ) : null}

      {s.status === 'ended' ? (
        <Confirm
          label="Close the night now"
          question="Fix who played, without waiting the 45 minutes?"
          detail="Everybody ticked off counts as having played. Everybody else is marked away and is not charged. This cannot be undone."
        >
          <form action={runGateNow}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="from" value="tonight" />
            <Button type="submit" className="w-full">
              Close it
            </Button>
          </form>
        </Confirm>
      ) : null}

      {playing.length > 0 && !closedOff ? (
        <details className="group">
          <summary className="tap flex items-center justify-center rounded-control border border-line-key bg-paper px-3.5 text-[16px] font-semibold text-text-2">
            Take somebody off
          </summary>
          <ul className="mt-2 flex flex-col gap-2 rounded-control border border-line-strong bg-sunken p-3.5">
            <li className="text-meta text-text-2">
              They come off the list entirely. Whoever is first on the waitlist takes the spot if
              the game hasn’t started.
            </li>
            {playing.map((e) => (
              <li key={e.id}>
                <Confirm label={e.name} question={`Take ${e.name} off the list?`} cancelHint={false}>
                  <form action={removePerson}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="from" value="tonight" />
                    <input type="hidden" name="participantId" value={e.id} />
                    <Button type="submit" variant="secondary" className="w-full">
                      Take {e.name} off
                    </Button>
                  </form>
                </Confirm>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <Link href={`/admin/g/${slug}` as never} className={SECONDARY_LINK}>
        Back to the game
      </Link>

      <Link href="/admin/money" className={SECONDARY_LINK}>
        The day’s money
      </Link>
    </div>
  )
}
