import Link from 'next/link'
import { Button, Input, Label, Notice, SectionHead } from '@/components/ui'
import { requireUser } from '@/lib/auth'
import { venueDayKey } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { SECONDARY_LINK } from '../../_ui'
import { createGame } from '../actions'

/**
 * Putting a game up. Plain form, plain server action — no JavaScript, because
 * this is typed once at a desk and the failure mode of a clever form is a lost
 * evening.
 */
export const dynamic = 'force-dynamic'
export const metadata = { title: 'New game · Madras Pickleball' }

export default async function NewGamePage(props: PageProps<'/admin/games/new'>) {
  await requireUser('admin')
  await ensureReady()
  const { err } = await props.searchParams
  const today = venueDayKey()

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
          <Input id="title" name="title" required maxLength={80} className="mt-2" placeholder="Tuesday evening social" defaultValue="" />
        </div>

        <div>
          <Label htmlFor="day">Day</Label>
          <Input id="day" name="day" type="date" required className="mt-2" defaultValue={today} />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label htmlFor="from">From</Label>
            <Input id="from" name="from" type="time" required className="mt-2" defaultValue="19:00" />
          </div>
          <div>
            <Label htmlFor="to">To</Label>
            <Input id="to" name="to" type="time" required className="mt-2" defaultValue="21:00" />
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
              defaultValue="300"
              placeholder="300"
            />
            <span className="mt-1.5 block text-meta text-text-3">Rupees. 0 for a free game.</span>
          </div>
          <div>
            <Label htmlFor="capacity">Spots</Label>
            <Input id="capacity" name="capacity" type="number" min={1} max={200} required className="mt-2" defaultValue={16} />
            <span className="mt-1.5 block text-meta text-text-3">You can open more later.</span>
          </div>
        </div>

        <div>
          <Label htmlFor="courtCount">Courts</Label>
          <Input id="courtCount" name="courtCount" type="number" min={0} max={50} required className="mt-2" defaultValue={2} />
        </div>

        <div>
          <Label htmlFor="notes">Anything to say</Label>
          <Input id="notes" name="notes" maxLength={400} className="mt-2" placeholder="Bring a spare ball" />
        </div>

        <label className="flex items-start gap-2.5 text-body text-text-2">
          <input
            type="checkbox"
            name="confirmationGate"
            defaultChecked
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

      <Link href="/admin/games" className={SECONDARY_LINK}>
        Back to games
      </Link>
    </div>
  )
}
