'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { venueDayKey, venueInstant, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { runTick } from '@/server/daily-reconcile'
import {
  cancelSession,
  endSession,
  extendSession,
  getSessionBySlug,
  joinSession,
  leaveSession,
  publishSession,
  roster,
  rotateSpotToken,
  seatFromWaitlist,
  setCapacity,
  setHidden,
  setPayer,
  setPresent,
  sessionCourts,
  setSessionCourts,
  startSession,
} from '@/server/sessions'

/**
 * The host's commands.
 *
 * Every one of them starts by resolving the slug and re-resolving whatever the
 * form named against it — form fields are wire values, and "this participant id
 * belongs to this game" is not something a hidden input can prove. The pattern
 * is `ownTeam` in `admin/t/[slug]/actions.ts`, for the same reason.
 *
 * These enqueue or apply work because a person tapped a button. Nothing in this
 * file is reachable from a page render.
 */

function back(slug: string, q?: { note?: string; err?: string }, to: 'game' | 'tonight' = 'game'): never {
  const base = to === 'tonight' ? `/admin/g/${slug}/tonight` : `/admin/g/${slug}`
  const qs = q?.err
    ? `?err=${encodeURIComponent(q.err)}`
    : q?.note
      ? `?done=${encodeURIComponent(q.note)}`
      : ''
  revalidatePath(`/admin/g/${slug}`, 'layout')
  revalidatePath('/admin/games')
  redirect(`${base}${qs}` as never)
}

/** The participant named by the form, only if it belongs to this game. */
async function own(slug: string, participantId: string) {
  const session = await getSessionBySlug(slug)
  if (!session) return null
  const entry = (await roster(session.id)).find((r) => r.id === participantId)
  return entry ? { session, entry } : null
}

export async function publishGame(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const session = await getSessionBySlug(slug)
  if (!session) back(slug, { err: 'That game has gone.' })
  const res = await publishSession(session.id, user)
  back(slug, res.ok ? { note: 'It’s on the public list. Share the link.' } : { err: res.error })
}

export async function startGame(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const session = await getSessionBySlug(slug)
  if (!session) back(slug, { err: 'That game has gone.' })
  const res = await startSession(session.id, user)
  back(slug, res.ok ? { note: 'Under way.' } : { err: res.error }, 'tonight')
}

export async function endGame(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const session = await getSessionBySlug(slug)
  if (!session) back(slug, { err: 'That game has gone.' })
  const res = await endSession(session.id, user)
  back(
    slug,
    res.ok
      ? { note: 'Done. You’ve got 45 minutes to fix who turned up before it’s final.' }
      : { err: res.error },
    'tonight',
  )
}

export async function cancelGame(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const reason = String(formData.get('reason') ?? '').slice(0, 200)
  const session = await getSessionBySlug(slug)
  if (!session) back(slug, { err: 'That game has gone.' })
  const res = await cancelSession(session.id, reason, user)
  back(slug, res.ok ? { note: 'Called off. Tell the group.' } : { err: res.error })
}

export async function openMoreSpots(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const by = Number(formData.get('by') ?? 4)
  const session = await getSessionBySlug(slug)
  if (!session) back(slug, { err: 'That game has gone.' })
  // A delta, not a number: read outside the lock, two hosts both tapping
  // "open 4 more" both see sixteen and both write twenty.
  const res = await setCapacity(session.id, { by: Number.isFinite(by) ? by : 4 }, user)
  if (!res.ok) back(slug, { err: res.error })
  back(slug, {
    note: res.promoted.length
      ? `${res.capacity} spots now — ${res.promoted.map((p) => p.name).join(', ')} moved up.`
      : `${res.capacity} spots now.`,
  })
}

export async function setSpots(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const capacity = Number(formData.get('capacity'))
  const session = await getSessionBySlug(slug)
  if (!session) back(slug, { err: 'That game has gone.' })
  const res = await setCapacity(session.id, capacity, user)
  if (!res.ok) back(slug, { err: res.error })
  back(slug, {
    note: res.clamped
      ? `Kept it at ${res.capacity} — that many people already have a spot.`
      : `${res.capacity} spots now.`,
  })
}

/** The host putting somebody on the list — a name is enough. */
export async function addPerson(formData: FormData) {
  await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const name = String(formData.get('name') ?? '').slice(0, 80)
  const phone = String(formData.get('phone') ?? '').slice(0, 24)
  const guestOf = String(formData.get('guestOf') ?? '') || null
  const walkIn = formData.get('walkIn') === 'on'
  const to = formData.get('from') === 'tonight' ? 'tonight' : 'game'

  const session = await getSessionBySlug(slug)
  if (!session) back(slug, { err: 'That game has gone.' }, to)

  const res = await joinSession({
    sessionId: session.id,
    name,
    phone: phone || null,
    source: 'host',
    guestOfPlayerId: guestOf,
    arriveCheckedIn: walkIn,
  })
  if (!res.ok) back(slug, { err: res.error }, to)

  const who = name.trim()
  if (res.alreadyIn) back(slug, { err: `${who} is already on this list.` }, to)
  back(
    slug,
    {
      note: res.waiting
        ? `${who} is on the waitlist.`
        : res.openedASpot
          ? `${who} is in — that’s one extra spot.`
          : `${who} is in.`,
    },
    to,
  )
}

export async function removePerson(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const to = formData.get('from') === 'tonight' ? 'tonight' : 'game'

  const found = await own(slug, participantId)
  if (!found) back(slug, { err: 'That spot has gone.' }, to)

  const res = await leaveSession(
    participantId,
    { kind: 'host', label: user.username, userId: user.id },
    'taken off by the host',
  )
  if (!res.ok) back(slug, { err: res.error }, to)
  back(
    slug,
    {
      note: res.promoted.length
        ? `${found.entry.name} is off — ${res.promoted.map((p) => p.name).join(', ')} moved up.`
        : `${found.entry.name} is off the list.`,
    },
    to,
  )
}

/**
 * The one human step in the whole cycle: tap who turned up.
 *
 * It revalidates and does NOT redirect. A redirect is a navigation, and a
 * navigation resets the scroll position and sends focus back to the top of the
 * document — so ticking off the fourteenth of sixteen people arriving at once
 * threw the host back to the masthead every single time.
 */
export async function markPresent(formData: FormData) {
  await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const present = formData.get('present') === 'on'

  const found = await own(slug, participantId)
  if (!found) back(slug, { err: 'That spot has gone.' }, 'tonight')
  const res = await setPresent(participantId, present)
  if (!res.ok) back(slug, { err: res.error }, 'tonight')
  revalidatePath(`/admin/g/${slug}/tonight`)
  revalidatePath(`/admin/g/${slug}`)
}

/** "All here" — every spot that hasn't been ticked off gets ticked off. */
export async function markAllPresent(formData: FormData) {
  await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const session = await getSessionBySlug(slug)
  if (!session) back(slug, { err: 'That game has gone.' }, 'tonight')

  const entries = await roster(session.id)
  let n = 0
  for (const e of entries) {
    if (e.state === 'joined' || e.state === 'confirmed') {
      const res = await setPresent(e.id, true)
      if (res.ok) n++
    }
  }
  back(slug, { note: n ? `${n} ticked off. Un-tap anyone who didn’t come.` : 'Everyone was already ticked off.' }, 'tonight')
}

/**
 * Fill a vacancy from the waitlist by hand.
 *
 * The tick does this on its own when somebody drops out before the start, but
 * at ten past seven the host is looking at a no-show and the person who wants
 * the spot is standing in front of them.
 */
export async function promoteFromWaitlist(formData: FormData) {
  await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const found = await own(slug, participantId)
  if (!found) back(slug, { err: 'That spot has gone.' }, 'tonight')

  const res = await seatFromWaitlist(participantId)
  back(
    slug,
    res.ok ? { note: `${found.entry.name} is in.` } : { err: res.error },
    'tonight',
  )
}

/**
 * Replace one person's link. For when it ends up in the wrong group chat, or
 * when somebody needs a fresh one sent.
 */
export async function newSpotLink(formData: FormData) {
  await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const found = await own(slug, participantId)
  if (!found) back(slug, { err: 'That spot has gone.' })
  const res = await rotateSpotToken(participantId)
  back(
    slug,
    res.ok
      ? { note: `${found.entry.name} has a new link — the old one stops working. Send it to them.` }
      : { err: res.error },
  )
}

export async function hidePerson(formData: FormData) {
  await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const hidden = formData.get('hidden') === 'on'
  const found = await own(slug, participantId)
  if (!found) back(slug, { err: 'That spot has gone.' })
  const res = await setHidden(participantId, hidden)
  back(slug, res.ok ? { note: hidden ? 'Name hidden from the public list.' : 'Name back on the list.' } : { err: res.error })
}

export async function changePayer(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const payerPlayerId = String(formData.get('payerPlayerId') ?? '')
  const found = await own(slug, participantId)
  if (!found) back(slug, { err: 'That spot has gone.' })
  const res = await setPayer(participantId, payerPlayerId, user)
  back(slug, res.ok ? { note: 'Changed who pays for that one.' } : { err: res.error })
}

/**
 * Run the gate now.
 *
 * The reconciler is normally driven by `/api/cron/tick`. This is the host doing
 * it by hand, because the venue must never be blocked by a scheduler it cannot
 * see. It enqueues nothing and hides nothing: it runs exactly the work the tick
 * would have run, and the badge on the screen shows when that last happened.
 */
export async function runGateNow(formData: FormData) {
  await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const to = formData.get('from') === 'tonight' ? 'tonight' : 'game'
  const out = await runTick()
  if (out.skipped) back(slug, { note: 'Already running — give it a moment.' }, to)
  if (out.error) {
    // Some games may well have reconciled; saying only that it failed sends the
    // host looking for a problem that has already half fixed itself.
    back(
      slug,
      {
        err: out.applied
          ? `${out.applied} change${out.applied === 1 ? '' : 's'} went through, but some games didn’t. Try again in a minute.`
          : 'The gate didn’t finish. Try again in a minute.',
      },
      to,
    )
  }
  back(slug, { note: out.applied ? `Done — ${out.applied} change${out.applied === 1 ? '' : 's'}.` : 'Nothing was due.' }, to)
}

/**
 * Which courts the game is on, and when it finishes — one form, because on a
 * Tuesday evening they are one decision. "Anna, can we go till 9:30, Court 3
 * is free."
 *
 * The hours move first. If they are refused, the courts are left exactly as
 * they were rather than half-applied to a window that did not happen.
 */
export async function setGameCourts(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const session = await getSessionBySlug(slug)
  if (!session) back(slug, { err: 'That game has gone.' })

  const courtIds = formData.getAll('courts').map(String).filter(Boolean)
  const finish = String(formData.get('finish') ?? '').trim()

  if (finish && finish !== venueTime(session.endsAt)) {
    // The finish is a time of day; which day it lands on is the day the game
    // started, unless that would put the end before the start — a game that
    // runs past midnight is a real Saturday, not a typo.
    const sameDay = venueInstant(venueDayKey(session.startsAt), finish)
    if (!sameDay) back(slug, { err: 'That finish time isn’t a time.' })
    const endsAt = sameDay <= session.startsAt ? new Date(sameDay.getTime() + 24 * 3600_000) : sameDay
    const moved = await extendSession(session.id, endsAt, user)
    if (!moved.ok) back(slug, { err: moved.error })
  }

  const res = await setSessionCourts(session.id, courtIds, user)
  if (!res.ok) back(slug, { err: res.error })
  // Named, not counted: the host just picked courts by name and a number back
  // is not an answer to what they did.
  const on = await sessionCourts(session.id)
  back(slug, {
    note: on.length ? `On ${on.map((c) => c.name).join(' and ')} now.` : 'No courts held for it now.',
  })
}
