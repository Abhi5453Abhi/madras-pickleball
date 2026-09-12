'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { paiseFromRupeeInput } from '@/lib/display'
import { venueInstant } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { createSession } from '@/server/sessions'

/**
 * Putting a game up. One form, one server action, and the game is a draft until
 * the host taps Publish — so a half-filled evening never appears on the public
 * list while it is being sorted out.
 */

/**
 * Back to the form with the words still in it.
 *
 * A plain server form is the right shape for this screen — it is typed once at
 * a desk and a clever form's failure mode is a lost evening — but a redirect
 * that carries only the error takes the title, both times, the price, the
 * spots, the notes and the court ticks with it. On the fourth attempt at a
 * clashing court that is the whole evening retyped.
 */
function backToNew(err: string, formData?: FormData): never {
  const q = new URLSearchParams({ err })
  if (formData) {
    for (const key of ['title', 'day', 'from', 'to', 'price', 'capacity', 'notes']) {
      const v = String(formData.get(key) ?? '')
      if (v) q.set(key, v)
    }
    const courts = formData.getAll('courts').map(String).filter(Boolean)
    if (courts.length) q.set('courts', courts.join(','))
    q.set('gate', formData.get('confirmationGate') === 'on' ? 'on' : 'off')
  }
  redirect(`/admin/games/new?${q.toString()}` as never)
}

export async function createGame(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()

  const title = String(formData.get('title') ?? '').slice(0, 80)
  const day = String(formData.get('day') ?? '')
  const from = String(formData.get('from') ?? '')
  const to = String(formData.get('to') ?? '')
  const price = String(formData.get('price') ?? '')
  const capacity = Number(formData.get('capacity'))
  const courtIds = formData.getAll('courts').map(String).filter(Boolean)
  // An unchecked checkbox sends NOTHING, so the test has to be for the value
  // being present. `!== 'off'` made the switch permanently on.
  const gate = formData.get('confirmationGate') === 'on'
  const notes = String(formData.get('notes') ?? '').slice(0, 400)

  const startsAt = venueInstant(day, from)
  const endsAtSameDay = venueInstant(day, to)
  if (!startsAt || !endsAtSameDay) backToNew('Put a date and both times in.', formData)
  // A game that finishes before it starts is one that runs past midnight —
  // "21:00 to 00:30" is a real Saturday, not a typo.
  const endsAt =
    endsAtSameDay <= startsAt ? new Date(endsAtSameDay.getTime() + 24 * 3600_000) : endsAtSameDay

  const pricePaise = paiseFromRupeeInput(price)
  if (pricePaise === null) backToNew('That price isn’t money — a number of rupees, like 300.', formData)

  const res = await createSession(
    {
      title,
      startsAt,
      endsAt,
      pricePaise,
      capacity: Number.isFinite(capacity) ? capacity : 16,
      courtCount: courtIds.length,
      courtIds,
      confirmationGate: gate,
      notes,
    },
    user,
  )
  if (!res.ok) backToNew(res.error, formData)

  revalidatePath('/admin/games')
  redirect(`/admin/g/${res.session.slug}?done=${encodeURIComponent('Game made. Publish it when you’re ready.')}` as never)
}
