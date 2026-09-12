'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { paiseFromRupeeInput, rupees } from '@/lib/display'
import { venueDayKey, venueInstant, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { runTick } from '@/server/daily-reconcile'
import {
  collectAtDesk,
  correctCharge,
  openChargesFor,
  sessionMoney,
  waiveCharge,
  type Method,
} from '@/server/money'
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
  setParticipantPrice,
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
  // The day-end tally is one tap from both money screens and reads the same
  // rows these commands just moved. Left stale it shows yesterday's takings
  // straight after a collection.
  revalidatePath('/admin/money')
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
 * What one person pays tonight, when it is not the game's price — m5.
 *
 * The amount and the note are one fact and the database says so, so the parse
 * and the missing-note both come back as sentences rather than as a 500 on a
 * check constraint. The amount is read with `paiseFromRupeeInput` for the same
 * reason every other amount is: money is integer paise, and a form field is a
 * string somebody typed.
 */
export async function setPrice(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const raw = String(formData.get('amount') ?? '').trim()
  const note = String(formData.get('note') ?? '').trim().slice(0, 120)

  const found = await own(slug, participantId)
  if (!found) back(slug, { err: 'That spot has gone.' })

  const paise = paiseFromRupeeInput(raw)
  if (!raw || paise === null) back(slug, { err: 'That isn’t an amount. Put it in rupees — 0, or 150.' })
  if (!note) back(slug, { err: 'Say why they pay a different price — it goes on the charge.' })

  const res = await setParticipantPrice(participantId, paise, note, user)
  back(
    slug,
    res.ok ? { note: `${found.entry.name} pays ${rupees(paise)} tonight — ${note}.` } : { err: res.error },
  )
}

/** Back to the game's own price. The note goes with the amount, always. */
export async function clearPrice(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const found = await own(slug, participantId)
  if (!found) back(slug, { err: 'That spot has gone.' })
  const res = await setParticipantPrice(participantId, null, null, user)
  back(slug, res.ok ? { note: `${found.entry.name} pays the game’s price again.` } : { err: res.error })
}

/** The two ways a host takes money at a desk. Anything else is not a desk. */
const DESK_METHODS: readonly Method[] = ['cash', 'venue_qr']

/**
 * The charge this night raised for the spot the form named, and whose it is.
 *
 * Nothing below takes a charge id off the wire. `own()` proves the
 * participation belongs to this game, and `sessionMoney` turns it into the one
 * charge that participation earned — a hidden input proves neither, and a
 * charge id is the field where getting it wrong means taking somebody else's
 * money.
 */
async function chargeFor(slug: string, participantId: string) {
  const found = await own(slug, participantId)
  if (!found) return null
  const line = (await sessionMoney(found.session.id)).get(participantId)
  if (!line) return null
  // Labelled by whoever pays, who is not always whoever played.
  const payer = (await roster(found.session.id)).find((r) => r.playerId === line.payerPlayerId)
  return { ...found, line, who: payer?.name ?? found.entry.name }
}

/**
 * Money across the desk — m2.
 *
 * `openChargesFor` is re-read rather than trusted from the render: the row on
 * the host's screen was drawn before the other host's phone may have taken the
 * same ₹300. `collectAtDesk` then does it behind the reservation, so the second
 * tap is refused with a sentence rather than collected twice.
 */
export async function takeMoney(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const rawAmount = String(formData.get('amount') ?? '').trim()

  // Never defaulted. `cash` is the one line that has to match counted notes at
  // the end of the night, so a method this app does not recognise must not be
  // quietly filed there — it is refused and nothing is taken.
  const method = DESK_METHODS.find((m) => m === String(formData.get('method') ?? ''))
  if (!method) back(slug, { err: 'Say whether that was cash or the venue QR. Nothing was taken.' })

  const asked = rawAmount ? paiseFromRupeeInput(rawAmount) : null
  if (rawAmount && asked === null) {
    back(slug, { err: 'That isn’t an amount. Put it in rupees — 200 — or leave it empty to take the lot.' })
  }
  if (asked !== null && asked <= 0) {
    back(slug, { err: 'Put in an amount above zero, or leave it empty to take the lot. Nothing was taken.' })
  }

  const found = await chargeFor(slug, participantId)
  if (!found) back(slug, { err: 'There is no charge for that spot on this night.' })

  const open = (await openChargesFor(found.line.payerPlayerId, found.session.venueId)).find(
    (c) => c.id === found.line.chargeId,
  )
  if (!open) back(slug, { err: `There is nothing left to take from ${found.who} for this night.` })
  if (asked !== null && asked > open.duePaise) {
    back(slug, {
      err: `That is more than ${found.who} owes for this night. ${rupees(open.duePaise)} is the most you can take here.`,
    })
  }

  const res = await collectAtDesk({
    playerId: found.line.payerPlayerId,
    venueId: found.session.venueId,
    chargeIds: [open.id],
    method,
    amountPaise: asked ?? undefined,
    actor: { userId: user.id, label: user.username },
    // Written inside the same transaction as the payment, so "money moved" and
    // "this host moved it" are one fact that either both happened or neither
    // did. The payment's own row carries its id; what this adds is the human.
    audit: {
      action: 'money.collected',
      entity: 'charge',
      entityId: open.id,
      before: { duePaise: open.duePaise },
      after: { method, askedPaise: asked },
    },
  })
  if (!res.ok) back(slug, { err: res.error })

  const left = open.duePaise - res.allocatedPaise
  back(slug, {
    note:
      res.leftOverPaise > 0
        ? `${rupees(res.allocatedPaise)} from ${found.who} — ${rupees(res.leftOverPaise)} is sitting on their account.`
        : left > 0
          ? `${rupees(res.allocatedPaise)} from ${found.who} — ${rupees(left)} still to come for this night.`
          : `${rupees(res.allocatedPaise)} from ${found.who}.`,
  })
}

/**
 * Correct what somebody owes — m3.
 *
 * The host types what it SHOULD be, not the difference: at the desk the known
 * number is "it should have been ₹150", and asking for a signed delta is asking
 * them to do the arithmetic the machine is for. What it is now is read back
 * here rather than carried in the form, so a screen that is one correction old
 * cannot post a delta computed from a stale number.
 */
export async function correctMoney(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const raw = String(formData.get('amount') ?? '').trim()
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 200)

  const found = await chargeFor(slug, participantId)
  if (!found) back(slug, { err: 'There is no charge for that spot on this night.' })

  const target = paiseFromRupeeInput(raw)
  if (!raw || target === null) back(slug, { err: 'That isn’t an amount. Put it in rupees — 0, or 150.' })

  // The net as this action just read it, sent along so the domain can refuse
  // the delta if the charge moved between the read and the write. Without it
  // two hosts correcting the same charge in the same second both post a delta
  // computed from the same stale number and the charge ends up at neither.
  const nowPaise = found.line.amountPaise + found.line.adjustPaise
  const res = await correctCharge({
    chargeId: found.line.chargeId,
    deltaPaise: target - nowPaise,
    expectedNetPaise: nowPaise,
    reason,
    actor: { userId: user.id, label: user.username },
    audit: {
      action: 'money.corrected',
      entity: 'charge',
      entityId: found.line.chargeId,
      reason,
      before: { paise: nowPaise },
      after: { paise: target, deltaPaise: target - nowPaise },
    },
  })
  if (!res.ok) back(slug, { err: res.error })

  const owes =
    res.duePaise > 0 ? `owes ${rupees(res.duePaise)} for this night` : 'owes nothing for this night now'
  back(slug, {
    note:
      res.freedPaise > 0
        ? `${found.who} ${owes} — ${rupees(res.freedPaise)} of what they had paid came back off it.`
        : `${found.who} ${owes}.`,
  })
}

/** The host decides not to charge it at all — only while nothing has settled it. */
export async function waiveMoney(formData: FormData) {
  const user = await requireUser('admin')
  await ensureReady()
  const slug = String(formData.get('slug') ?? '')
  const participantId = String(formData.get('participantId') ?? '')
  const reason = String(formData.get('reason') ?? '').trim().slice(0, 200)

  const found = await chargeFor(slug, participantId)
  if (!found) back(slug, { err: 'There is no charge for that spot on this night.' })

  const res = await waiveCharge({
    chargeId: found.line.chargeId,
    reason,
    actor: { userId: user.id, label: user.username },
    audit: {
      action: 'money.waived',
      entity: 'charge',
      entityId: found.line.chargeId,
      reason,
      before: { paise: found.line.amountPaise + found.line.adjustPaise },
    },
  })
  if (!res.ok) back(slug, { err: res.error })
  back(slug, { note: `${found.who} isn’t being charged for this night. The reason is on the record.` })
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
