import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { Button, Chevron, Confirm, CourtSwatch, Input, Label, Notice, Panel, SectionHead } from '@/components/ui'
import { formatDuration, hhmmFromMinutes, minutesOfDay, venueDate, venueDayKey, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { courtDay, dayStart, type HoldRow } from '@/server/courts'
import { getVenue } from '@/server/tournaments'
import { SECONDARY_LINK } from '../../_ui'
import { blockCourtAction, unblockCourtAction } from './actions'

export const metadata = { title: 'The day · Madras Pickleball' }
export const dynamic = 'force-dynamic'

/**
 * What every court is doing, hour by hour, and what is left.
 *
 * For a booked game, when a court is free IS the product — so this is the one
 * screen that answers it without anybody adding hours up in their head. It is
 * also where a court goes out of action: a coaching batch, a private booking,
 * a broken net.
 */

/**
 * The hours worth drawing — six to eleven, widened to cover anything that
 * actually runs outside them. A block from eleven at night to half past twelve
 * used to be clamped to a zero-width sliver and vanish from the bar entirely.
 */
const DEFAULT_FROM_MIN = 6 * 60
const DEFAULT_UNTIL_MIN = 23 * 60

const BAR_TONE: Record<HoldRow['kind'], string> = {
  tournament: 'bg-ink',
  session: 'bg-link',
  block: 'bg-text-3',
}

function shiftDay(dayKey: string, days: number): string {
  return venueDayKey(new Date(dayStart(dayKey).getTime() + days * 24 * 60 * 60_000))
}

/**
 * The grid's 24-hour clock, except at the edge of the day. A court free
 * "06:00–00:00" reads as a range that ends before it starts; midnight has a
 * name, so it gets it.
 */
function clock(at: Date): string {
  const t = venueTime(at)
  return t === '00:00' ? 'midnight' : t
}

/** "2 hrs" / "45 min" — how much of a gap it is, which is the whole question. */
function span(from: Date, until: Date): string {
  return formatDuration((until.getTime() - from.getTime()) / 60_000)
}

/** The next quarter hour, in venue time, as a time input wants it. */
function nextQuarter(now: Date): string {
  const at = new Date(Math.ceil(now.getTime() / 900_000) * 900_000)
  return venueTime(at)
}

function plusHours(hhmm: string, hours: number): string {
  // Wraps rather than clamps: a block started at half eleven at night runs to
  // half one, and the action already reads an end before its start as crossing
  // midnight. Clamping produced "24:00", which a time input will not take.
  const min = minutesOfDay(hhmm) ?? 0
  return hhmmFromMinutes((min + hours * 60) % (24 * 60))
}

export default async function CourtDayPage(props: PageProps<'/admin/courts/day'>) {
  await requireUser('admin')
  await ensureReady()
  const { day, note, err } = await props.searchParams

  const now = new Date()
  const todayKey = venueDayKey(now)
  const dayKey = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : todayKey
  const venue = await getVenue()
  const rows = await courtDay(dayKey, venue.id)
  const base = dayStart(dayKey).getTime()
  const isToday = dayKey === todayKey

  // The drawn window: six to eleven, stretched to hold anything outside it.
  const edges = rows.flatMap(({ holds }) => holds.flatMap((h) => [h.heldFrom, h.heldUntil]))
  const fromMin = Math.min(
    DEFAULT_FROM_MIN,
    ...edges.map((d) => Math.floor((d.getTime() - base) / 60_000)).filter((m) => m >= 0),
  )
  const untilMin = Math.max(
    DEFAULT_UNTIL_MIN,
    // Not capped at midnight: a block from eleven at night to half past twelve
    // is exactly the hold this widening exists for, and the old cap dropped it.
    ...edges.map((d) => Math.ceil((d.getTime() - base) / 60_000)).filter((m) => m <= 48 * 60),
  )
  const drawn = { from: new Date(base + fromMin * 60_000), until: new Date(base + untilMin * 60_000) }
  const pct = (at: Date) =>
    Math.max(0, Math.min(100, (((at.getTime() - base) / 60_000 - fromMin) / (untilMin - fromMin)) * 100))

  // The next quarter hour, unless that has wrapped past midnight — the form's
  // day is the day being viewed, and "today at 00:00" is eleven hours gone.
  const soon = isToday ? nextQuarter(now) : hhmmFromMinutes(DEFAULT_FROM_MIN)
  const blockFrom = isToday && (minutesOfDay(soon) ?? 0) < (minutesOfDay(venueTime(now)) ?? 0) ? '23:45' : soon
  const blockUntil = plusHours(blockFrom, 2)

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/admin/courts"
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          Courts
        </Link>
        <h1 className="mt-1 text-title text-text">{venueDate(dayStart(dayKey))}</h1>
        <p className="num mt-1 text-meta text-text-3">
          {isToday ? 'Today · ' : ''}
          {rows.length} court{rows.length === 1 ? '' : 's'} · {clock(drawn.from)} to {clock(drawn.until)}
        </p>
      </header>

      <div className="flex items-center justify-between gap-2">
        <Link href={`/admin/courts/day?day=${shiftDay(dayKey, -1)}` as never} className={SECONDARY_LINK}>
          ← {venueDate(dayStart(shiftDay(dayKey, -1)))}
        </Link>
        <Link href={`/admin/courts/day?day=${shiftDay(dayKey, 1)}` as never} className={SECONDARY_LINK}>
          {venueDate(dayStart(shiftDay(dayKey, 1)))} →
        </Link>
      </div>

      {err ? (
        <Notice tone="alert" title="Not done">
          {String(err)}
        </Notice>
      ) : null}
      {note ? <Notice tone="done">{String(note)}</Notice> : null}

      <div className="flex flex-wrap items-center gap-3 text-meta text-text-3">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-full bg-ink" /> tournament
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-full bg-link" /> game
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-4 rounded-full bg-text-3" /> out of action
        </span>
        {isToday ? (
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-0.5 bg-live" /> now
          </span>
        ) : null}
      </div>

      <Panel>
        <ul className="divide-y divide-line">
          {rows.map(({ court, holds, free }) => {
            // Clipped to the drawn window, not merely filtered by it: offering
            // "free 00:00–09:00" as the answer on a screen that draws from six
            // in the morning is not an answer anybody can use.
            const inHours = free
              .map((f) => ({
                from: f.from.getTime() < drawn.from.getTime() ? drawn.from : f.from,
                until: f.until.getTime() > drawn.until.getTime() ? drawn.until : f.until,
              }))
              .filter((f) => f.until.getTime() - f.from.getTime() >= 15 * 60_000)
            return (
              <li key={court.id} className="flex flex-col gap-2 px-4 py-3.5">
                <div className="flex items-center gap-2.5">
                  <CourtSwatch colorKey={court.colorKey} size="md" />
                  <p className="text-row text-text">{court.name}</p>
                </div>

                {/* The bar is for scanning; the sentences below it are the answer. */}
                <div className="relative h-3 w-full overflow-hidden rounded-full bg-sunken" aria-hidden="true">
                  {holds.map((h) => {
                    const left = pct(h.heldFrom)
                    const right = pct(h.heldUntil)
                    if (right <= left) return null
                    return (
                      <span
                        key={h.id}
                        className={`absolute top-0 h-full ${BAR_TONE[h.kind]}`}
                        style={{ left: `${left}%`, width: `${right - left}%` }}
                      />
                    )
                  })}
                  {isToday ? (
                    <span
                      className="absolute top-0 h-full w-0.5 bg-live"
                      style={{ left: `${pct(now)}%` }}
                    />
                  ) : null}
                </div>

                {holds.length ? (
                  <ul className="flex flex-col gap-1.5">
                    {holds.map((h) => (
                      <li key={h.id} className="flex flex-wrap items-center justify-between gap-2">
                        <p className="num text-meta text-text-2">
                          <span className="font-semibold text-text">
                            {h.heldFrom.getTime() < base ? `from ${clock(h.heldFrom)} yesterday` : clock(h.heldFrom)}
                            –
                            {h.heldUntil.getTime() > base + 24 * 60 * 60_000
                              ? `${venueTime(h.heldUntil)} tomorrow`
                              : clock(h.heldUntil)}
                          </span>{' '}
                          {h.holderName}
                          {h.kind === 'block' ? (h.heldUntil <= now ? ' · was out of action' : ' · out of action') : ''}
                        </p>
                        {h.kind === 'block' && h.heldUntil > now ? (
                          <Confirm
                            className="[&>summary]:border-0 [&>summary]:px-2 [&>summary]:text-link [&[open]]:w-full"
                            label="Give it back"
                            question={`${court.name} goes back to the venue for ${clock(h.heldFrom)}–${clock(h.heldUntil)}.`}
                          >
                            <form action={unblockCourtAction}>
                              <input type="hidden" name="holdId" value={h.id} />
                              <input type="hidden" name="day" value={dayKey} />
                              <Button type="submit" className="w-full">
                                Give {court.name} back
                              </Button>
                            </form>
                          </Confirm>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}

                {/* The answer, in the size of an answer. The court's name is
                    the thing you already know; when it is free is not. */}
                <p className="num text-row text-text-2">
                  {inHours.length
                    ? inHours
                        .map((f) => `${clock(f.from)}–${clock(f.until)} · ${span(f.from, f.until)}`)
                        .join('  ·  ')
                    : 'Nothing free'}
                </p>
              </li>
            )
          })}
        </ul>
      </Panel>

      <section className="flex flex-col gap-2.5">
        <SectionHead
          title="Take a court out for a while"
          meta="Coaching, maintenance, a private booking, a broken net."
        />
        <form action={blockCourtAction} className="flex flex-col gap-3">
          <input type="hidden" name="day" value={dayKey} />
          <div>
            <Label htmlFor="courtId">Court</Label>
            <select
              id="courtId"
              name="courtId"
              required
              className="tap mt-2 w-full rounded-control border border-line-key bg-paper px-3 text-[17px] text-text"
              defaultValue=""
            >
              <option value="" disabled>
                Which court?
              </option>
              {rows.map(({ court }) => (
                <option key={court.id} value={court.id}>
                  {court.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="from">From</Label>
              <Input id="from" name="from" type="time" required className="mt-2" defaultValue={blockFrom} />
            </div>
            <div>
              <Label htmlFor="until">Until</Label>
              <Input id="until" name="until" type="time" required className="mt-2" defaultValue={blockUntil} />
            </div>
          </div>
          <div>
            <Label htmlFor="reason">What for</Label>
            <Input id="reason" name="reason" required maxLength={80} className="mt-2" placeholder="Coaching batch" />
          </div>
          <Button type="submit" variant="secondary" className="w-full">
            Take it out
          </Button>
        </form>
        <p className="text-meta text-text-3">
          A block has an end. A court taken out “until further notice” is a court that quietly
          disappears, so this one comes back on its own and you can always take it out again.
        </p>
      </section>
    </div>
  )
}
