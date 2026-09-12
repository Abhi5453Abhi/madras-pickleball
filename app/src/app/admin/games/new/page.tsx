import Link from 'next/link'
import { Button, CourtSwatch, Input, Label, Notice, SectionHead } from '@/components/ui'
import { requireUser } from '@/lib/auth'
import { venueDayKey, venueInstant } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { freeCourtsBetween, hoursLabelFor } from '@/server/courts'
import { getVenue } from '@/server/tournaments'
import { SECONDARY_LINK } from '../../_ui'
import { createGame } from '../actions'

/**
 * Putting a game up. Plain form, plain server action — no JavaScript, because
 * this is typed once at a desk and the failure mode of a clever form is a lost
 * evening.
 */
export const dynamic = 'force-dynamic'
export const metadata = { title: 'New game · Madras Pickleball' }

const DEFAULT_FROM = '19:00'
const DEFAULT_TO = '21:00'

export default async function NewGamePage(props: PageProps<'/admin/games/new'>) {
  await requireUser('admin')
  await ensureReady()
  const sp = await props.searchParams
  const { err } = sp
  // Whatever was typed last time, so a refused save is a correction rather than
  // a retype. `str` because a repeated query key arrives as an array.
  const str = (v: string | string[] | undefined, fallback = '') =>
    (typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? '') : '') || fallback
  const back = {
    title: str(sp.title),
    day: str(sp.day),
    from: str(sp.from),
    to: str(sp.to),
    price: str(sp.price),
    capacity: str(sp.capacity),
    notes: str(sp.notes),
    gate: str(sp.gate),
    courts: str(sp.courts).split(',').filter(Boolean),
  }
  const returning = !!err
  const today = venueDayKey()

  // The courts are ticked for the hours the form opens with. Change the hours
  // and the ticks may be wrong — the server says who has the court and the
  // quarter-hour index is what actually decides, so a wrong tick costs a
  // sentence rather than a double-booked evening.
  const venue = await getVenue()
  const shownDay = back.day || today
  const shownFrom = back.from || DEFAULT_FROM
  const shownTo = back.to || DEFAULT_TO
  const defaultFrom = venueInstant(shownDay, shownFrom)
  const defaultTo = venueInstant(shownDay, shownTo)
  const courtRows =
    defaultFrom && defaultTo ? await freeCourtsBetween(defaultFrom, defaultTo, venue.id) : []

  return (
    <div className="flex flex-col gap-6">
      <SectionHead title="New game" meta="It stays a draft until you publish it." />

      {err ? (
        <Notice tone="alert" title="Not done">
          {String(err)}
        </Notice>
      ) : null}

      <form action={createGame} className="flex flex-col gap-5">
        <div>
          <Label htmlFor="title">What to call it</Label>
          <Input id="title" name="title" required maxLength={80} className="mt-2" placeholder="Tuesday evening social" defaultValue={back.title} />
        </div>

        <div>
          <Label htmlFor="day">Day</Label>
          <Input id="day" name="day" type="date" required className="mt-2" defaultValue={shownDay} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="from">From</Label>
            <Input id="from" name="from" type="time" required className="mt-2" defaultValue={shownFrom} />
          </div>
          <div>
            <Label htmlFor="to">To</Label>
            <Input id="to" name="to" type="time" required className="mt-2" defaultValue={shownTo} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="price">Price a head</Label>
            <Input
              id="price"
              name="price"
              inputMode="decimal"
              className="mt-2"
              defaultValue={back.price || '300'}
              placeholder="300"
            />
            <span className="mt-1.5 block text-meta text-text-3">Rupees. 0 for a free game.</span>
          </div>
          <div>
            <Label htmlFor="capacity">Spots</Label>
            <Input id="capacity" name="capacity" type="number" min={1} max={200} required className="mt-2" defaultValue={back.capacity || 16} />
            <span className="mt-1.5 block text-meta text-text-3">You can open more later.</span>
          </div>
        </div>

        <fieldset>
          <legend className="text-row text-text">Courts</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {courtRows.map((c) => (
              <label
                key={c.id}
                className="tap inline-flex cursor-pointer items-center gap-2 rounded-full border border-line-key bg-paper px-3.5 text-[16px] font-semibold text-text has-checked:border-ink has-checked:bg-ink has-checked:text-white"
              >
                <input
                  type="checkbox"
                  name="courts"
                  value={c.id}
                  defaultChecked={returning ? back.courts.includes(c.id) : !c.takenBy}
                  className="sr-only"
                />
                <CourtSwatch colorKey={c.colorKey} size="md" />
                {c.name}
                {c.takenBy ? (
                  <span className="font-normal">
                    · {c.takenBy.holderName} till {hoursLabelFor(c.takenBy.heldUntil)}
                  </span>
                ) : null}
              </label>
            ))}
          </div>
          <span className="mt-1.5 block text-meta text-text-3">
            {courtRows.length
              ? `Who has what is shown for ${shownFrom}–${shownTo}. Change the times above and this line is stale until you save — the save itself is checked.`
              : 'No courts at the venue yet.'}
          </span>
        </fieldset>

        <div>
          <Label htmlFor="notes">Anything to say</Label>
          <Input id="notes" name="notes" maxLength={400} className="mt-2" placeholder="Bring a spare ball" defaultValue={back.notes} />
        </div>

        <label className="flex items-start gap-2.5 py-2 text-body text-text-2">
          <input
            type="checkbox"
            name="confirmationGate"
            defaultChecked={returning ? back.gate === 'on' : true}
            className="mt-1 h-5 w-5 shrink-0 rounded border-line-key"
          />
          <span>
            Ask everyone to confirm three hours before
            <span className="mt-0.5 block text-meta text-text-3">
              Spots nobody confirms go to the waitlist an hour before the start. Turn it off for a
              game where you haven’t told anybody to expect it.
            </span>
          </span>
        </label>

        <Button type="submit" className="w-full">
          Make the game
        </Button>
      </form>

      <Link href="/admin/courts/day" className={SECONDARY_LINK}>
        What is on today, and what is free
      </Link>

      <Link href="/admin/games" className={SECONDARY_LINK}>
        Back to games
      </Link>
    </div>
  )
}
