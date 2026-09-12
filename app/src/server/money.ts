import 'server-only'
import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm'
import { db, transact, type Tx } from '@/db'
import {
  chargeAdjustments,
  chargeApplications,
  charges,
  collectionAttemptCharges,
  collectionAttempts,
  credits,
  payments,
  refunds,
  sessionParticipants,
} from '@/db/schema'
import { recordAudit } from '@/lib/audit'
import { newId } from '@/lib/ids'
import { venueDate } from '@/lib/time'
import { isWriteConflict, savedAtOnce } from './courts'

/**
 * The money — SPEC-v4 §4, §5, §6.
 *
 * Three rules run through every function here, and each one is structural
 * rather than a habit:
 *
 *  1. **A charge is written once.** Its amount, its reason and its timestamp
 *     never change. A correction is a `charge_adjustments` row with a sign, and
 *     money arriving is a `payments` row plus a `charge_applications` row. The
 *     only columns this file ever updates on a charge are the two settlement
 *     counters and the lifecycle state, and both move in the same transaction
 *     as the row they summarise.
 *  2. **The database refuses what must never happen.** Over-settling a charge,
 *     spending a payment twice, collecting the same charge from two places at
 *     once, billing one night twice, processing one webhook twice. Every one is
 *     a constraint, and this file turns the SQLSTATE into an English sentence
 *     rather than letting it become a 500.
 *  3. **No external call happens inside an open transaction.** There is nothing
 *     external to call until stage 4, which is exactly why the shape is built
 *     now: `openAttempt` commits the reservation and returns, the call happens
 *     with no transaction held, and `settleAttempt` commits the outcome. A
 *     transaction held across a network call on a pooled connection is fatal
 *     under trivial load, and retrofitting the ordering afterwards means doing
 *     it while money is moving.
 *
 * What is deliberately not here: a stored balance (derived, see `balanceFor`),
 * a mandate, a sweep, a notice, any fee arithmetic, and any timer that releases
 * a reservation.
 */

export type Fail = { ok: false; error: string }
const fail = (error: string): Fail => ({ ok: false, error })

/** ₹10,00,000 in one payment. Far beyond a Tuesday, and well inside an int4. */
export const MAX_MONEY_PAISE = 100_000_000

export type Method = 'cash' | 'venue_qr' | 'gateway' | 'bank_transfer'
export type Initiator = 'player' | 'host' | 'system'
export type Actor = { userId: string | null; label: string }

/**
 * What to write in the audit log, in the same transaction as the money.
 *
 * Every command here takes one optional. A money write whose audit row is
 * written afterwards, outside the transaction, can succeed while the record of
 * who did it fails — and "host visibility is logged" becomes false for exactly
 * the write that mattered.
 */
export type AuditNote = {
  action: string
  entity: string
  entityId: string
  reason?: string | null
  before?: unknown
  after?: unknown
}

async function note(tx: Tx, actor: Actor, audit: AuditNote | undefined) {
  if (!audit) return
  await recordAudit({ userId: actor.userId, actorLabel: actor.label, ...audit }, tx)
}

export type ChargeRow = typeof charges.$inferSelect
export type PaymentRow = typeof payments.$inferSelect

// ─────────────────────── constraints, as sentences ───────────────────────

/**
 * What each guarantee says when it fires.
 *
 * The lesson is from the court holds: reading a 23505 and discarding which
 * constraint it was turns a race the design anticipated into a 500 the host
 * cannot act on. Every sentence here names what did not happen, because the
 * thing a host needs to know at the desk is whether the money moved.
 */
const SENTENCES: Record<string, string> = {
  charges_applied_within:
    'That would settle the charge past what is owed. Take the payment off it first, then correct the amount.',
  charges_net_nonneg: 'That takes off more than the charge. Waive it instead, or give a credit for the difference.',
  charges_participation_uq: 'That night is already billed. Nothing was charged twice.',
  charges_policy_uq: 'That fee is already on the night. Nothing was charged twice.',
  payments_spent_within: 'That payment is already spoken for. Nothing was changed.',
  credits_applied_within: 'That credit is already used up. Nothing was changed.',
  one_live_reservation_per_charge:
    'Somebody else is collecting that right now. Nothing was taken twice — try again in a moment.',
  collection_attempt_charges_uq: 'That charge is already on this collection. Nothing was added twice.',
  charge_applications_reverses_uq: 'That payment line has already been taken back.',
  webhook_events_provider_uq: 'That message has already been dealt with.',
}

/**
 * The constraint a driver error names, whichever driver raised it.
 *
 * postgres.js puts it in `constraint_name`, PGlite in `constraint`, and drizzle
 * wraps both in an error whose `cause` is the real one — so this walks the
 * chain rather than trusting the top. The message is the last resort, because a
 * `raise exception` from a trigger has no constraint field at all.
 */
export function constraintOf(err: unknown): string | null {
  let e = err as { code?: string; constraint?: string; constraint_name?: string; message?: string; cause?: unknown } | null
  for (let depth = 0; e && depth < 6; depth += 1) {
    const named = e.constraint ?? e.constraint_name
    if (typeof named === 'string' && named) return named
    if (typeof e.message === 'string') {
      const m = /constraint "([a-z0-9_]+)"/i.exec(e.message)
      if (m) return m[1]
    }
    e = e.cause as typeof e
  }
  return null
}

/** The English for a refusal the database made, or null when it was not one of ours. */
export function moneySentence(err: unknown): string | null {
  const name = constraintOf(err)
  return name ? (SENTENCES[name] ?? null) : null
}

/** Every money write ends in this: a sentence, or the error keeps going up. */
function refuse(err: unknown): Fail {
  const said = moneySentence(err)
  if (said) return fail(said)
  if (isWriteConflict(err)) return fail(savedAtOnce)
  throw err
}

// ───────────────────────────── the price ─────────────────────────────

export type Priced = { paise: number; source: 'session' | 'override'; note: string | null }

/**
 * What one person pays for one night. The ONE place this is decided.
 *
 * The screen that promises an amount before the night locks and the code that
 * writes the charge when it does must agree, or the app's own screen becomes
 * the evidence in the dispute it was built to prevent. So there is exactly one
 * function, and both callers use it.
 */
export function effectivePrice(
  session: { pricePaise: number },
  who: { priceOverridePaise: number | null; priceNote: string | null },
): Priced {
  if (who.priceOverridePaise == null) return { paise: session.pricePaise, source: 'session', note: null }
  return { paise: who.priceOverridePaise, source: 'override', note: who.priceNote }
}

/** "Tuesday evening social · Mon, 14 Sept" — what a player would recognise. */
export function chargeReasonFor(session: { title: string; startsAt: Date }): string {
  return `${session.title} · ${venueDate(session.startsAt)}`
}

// ─────────────────────── raising charges at the lock ───────────────────────

/**
 * The night is closed, so what everybody owes is now a fact.
 *
 * Runs inside the transaction that moved the session to `locked`, which is what
 * makes it idempotent twice over: that UPDATE re-asserts `ended` and only one
 * transaction can win it, and `charges_participation_uq` refuses a second
 * charge for the same participation even if one somehow did. A replayed lock
 * raises nothing, and `on conflict do nothing` means it says so rather than
 * throwing.
 *
 * Only `played` is billed. `absent` produces no session charge at all — they
 * did not play, so they do not owe the session fee. If a no-show fee is ever
 * switched on it is a separate charge with `origin = 'policy'`, never this one
 * wearing a different label.
 *
 * Somebody playing free still gets a ₹0 charge. Without a row, "played free"
 * and "not billed yet" are the same state, the day-end tally cannot show who
 * played without paying, and a replayed lock has nothing to collide with.
 */
export async function raiseSessionCharges(
  tx: Tx,
  session: { id: string; venueId: string; pricePaise: number; title: string; startsAt: Date },
  now: Date,
  actor: Actor,
): Promise<{ raised: number; paise: number }> {
  const played = await tx
    .select({
      id: sessionParticipants.id,
      payerPlayerId: sessionParticipants.payerPlayerId,
      priceOverridePaise: sessionParticipants.priceOverridePaise,
      priceNote: sessionParticipants.priceNote,
    })
    .from(sessionParticipants)
    .where(and(eq(sessionParticipants.sessionId, session.id), eq(sessionParticipants.state, 'played')))
    .orderBy(asc(sessionParticipants.seq))

  if (!played.length) return { raised: 0, paise: 0 }

  const reason = chargeReasonFor(session)
  const done = await tx
    .insert(charges)
    .values(
      played.map((p) => {
        const price = effectivePrice(session, p)
        return {
          id: newId('chg'),
          venueId: session.venueId,
          playerId: p.payerPlayerId,
          sessionId: session.id,
          participationId: p.id,
          origin: 'participation' as const,
          amountPaise: price.paise,
          reason,
          unitPricePaise: price.paise,
          priceSource: price.source,
          priceNote: price.note,
          createdByUserId: actor.userId,
          createdAt: now,
          updatedAt: now,
        }
      }),
    )
    .onConflictDoNothing()
    .returning({ id: charges.id, amountPaise: charges.amountPaise })

  // Money already on account finds the charge that was just raised. Without
  // this, somebody who handed over ₹500 for a ₹300 night is asked for another
  // ₹300 next Tuesday while the venue is still holding ₹200 of theirs — and
  // the collections list and the game screen disagree about the same person.
  for (const payer of new Set(played.map((p) => p.payerPlayerId))) {
    await applyOnAccount(tx, payer, session.venueId, now, actor.label)
  }

  return { raised: done.length, paise: done.reduce((n, r) => n + r.amountPaise, 0) }
}

// ───────────────────────────── allocation ─────────────────────────────
//
// Three functions, one rule: money settles the oldest thing owed first, and
// nothing settles a charge somebody else is collecting. `applyOnAccount` is the
// one every path ends in, because money that arrived before the charge existed
// is still that player's money.

/** What is still owed on a charge: the amount, as corrected, less what has settled it. */
const DUE = sql<number>`${charges.amountPaise} + ${charges.adjustPaise} - ${charges.appliedPaise}`

/**
 * Money on account, spread over what is owed, oldest first.
 *
 * Charges somebody is already collecting are skipped — that is the whole point
 * of the reservation, and skipping them here is what stops a link payment and a
 * desk payment settling the same ₹300 from two directions. `only` lets the
 * attempt that HOLDS a reservation settle its own charges, which is the one
 * caller allowed past that filter.
 *
 * Anything left over stays unallocated and visible. It is never silently
 * absorbed, and the next charge raised for that player picks it up.
 */
async function allocate(
  tx: Tx,
  paymentId: string,
  now: Date,
  actorLabel: string,
  only?: readonly string[],
): Promise<number> {
  // Who the payment belongs to, without locking it yet. Every path in this
  // file takes charges before payments; `correctCharge` locks a charge and then
  // its payment, so allocating in the other order is a deadlock between two
  // hosts correcting two charges that share one payment.
  const [whose] = await tx
    .select({ playerId: payments.playerId, venueId: payments.venueId, state: payments.state })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1)
  if (!whose || whose.state !== 'succeeded') return 0
  const pay = { id: paymentId, playerId: whose.playerId, venueId: whose.venueId }

  const open = await tx
    .select({ id: charges.id, due: DUE })
    .from(charges)
    .where(
      and(
        eq(charges.playerId, pay.playerId),
        eq(charges.venueId, pay.venueId),
        eq(charges.state, 'locked'),
        sql`${charges.amountPaise} + ${charges.adjustPaise} > ${charges.appliedPaise}`,
        only?.length
          ? inArray(charges.id, [...only])
          : sql`not exists (
              select 1 from ${collectionAttemptCharges} r
              where r."charge_id" = ${charges.id} and r."released_at" is null
            )`,
      ),
    )
    .orderBy(asc(charges.createdAt), asc(charges.id))
    .for('update')

  // Now the payment, and its counters read under the lock rather than before it.
  const [held] = await tx
    .select({
      amountPaise: payments.amountPaise,
      allocatedPaise: payments.allocatedPaise,
      refundedPaise: payments.refundedPaise,
      state: payments.state,
    })
    .from(payments)
    .where(eq(payments.id, paymentId))
    .limit(1)
    .for('update')
  if (!held || held.state !== 'succeeded') return 0
  let left = held.amountPaise - held.allocatedPaise - held.refundedPaise
  if (left <= 0) return 0

  let spent = 0
  for (const c of open) {
    if (left <= 0) break
    const take = Math.min(left, Number(c.due))
    if (take <= 0) continue
    await tx.insert(chargeApplications).values({
      id: newId('app'),
      chargeId: c.id,
      paymentId: pay.id,
      amountPaise: take,
      actorLabel,
      at: now,
    })
    await tx
      .update(charges)
      .set({ appliedPaise: sql`${charges.appliedPaise} + ${take}`, updatedAt: now })
      .where(eq(charges.id, c.id))
    left -= take
    spent += take
  }

  if (spent > 0) {
    await tx
      .update(payments)
      .set({ allocatedPaise: sql`${payments.allocatedPaise} + ${spent}`, updatedAt: now })
      .where(eq(payments.id, pay.id))
  }
  return spent
}

/**
 * Spread whatever a player has on account over whatever they owe.
 *
 * Called after a correction frees money up, and after a credit is granted. It
 * is the same oldest-first rule as a fresh payment, because money on account is
 * exactly that: a payment that has not found its charge yet.
 */
async function applyOnAccount(tx: Tx, playerId: string, venueId: string, now: Date, actorLabel: string) {
  const loose = await tx
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.playerId, playerId),
        eq(payments.venueId, venueId),
        eq(payments.state, 'succeeded'),
        sql`${payments.allocatedPaise} + ${payments.refundedPaise} < ${payments.amountPaise}`,
      ),
    )
    .orderBy(asc(payments.receivedAt), asc(payments.id))
  for (const p of loose) await allocate(tx, p.id, now, actorLabel)

  const spare = await tx
    .select({ id: credits.id })
    .from(credits)
    .where(
      and(
        eq(credits.playerId, playerId),
        eq(credits.venueId, venueId),
        sql`${credits.appliedPaise} < ${credits.amountPaise}`,
      ),
    )
    .orderBy(asc(credits.createdAt), asc(credits.id))
  for (const c of spare) await spendCredit(tx, c.id, now, actorLabel)
}

/** A credit settles charges the same way a payment does — it just never touched the bank. */
async function spendCredit(tx: Tx, creditId: string, now: Date, actorLabel: string): Promise<number> {
  const [cr] = await tx
    .select({
      id: credits.id,
      playerId: credits.playerId,
      venueId: credits.venueId,
      amountPaise: credits.amountPaise,
      appliedPaise: credits.appliedPaise,
    })
    .from(credits)
    .where(eq(credits.id, creditId))
    .limit(1)
    .for('update')
  if (!cr) return 0
  let left = cr.amountPaise - cr.appliedPaise
  if (left <= 0) return 0

  const open = await tx
    .select({ id: charges.id, due: DUE })
    .from(charges)
    .where(
      and(
        eq(charges.playerId, cr.playerId),
        eq(charges.venueId, cr.venueId),
        eq(charges.state, 'locked'),
        sql`${charges.amountPaise} + ${charges.adjustPaise} > ${charges.appliedPaise}`,
        sql`not exists (
          select 1 from ${collectionAttemptCharges} r
          where r."charge_id" = ${charges.id} and r."released_at" is null
        )`,
      ),
    )
    .orderBy(asc(charges.createdAt), asc(charges.id))
    .for('update')

  let spent = 0
  for (const c of open) {
    if (left <= 0) break
    const take = Math.min(left, Number(c.due))
    if (take <= 0) continue
    await tx.insert(chargeApplications).values({
      id: newId('app'),
      chargeId: c.id,
      creditId: cr.id,
      amountPaise: take,
      actorLabel,
      at: now,
    })
    await tx
      .update(charges)
      .set({ appliedPaise: sql`${charges.appliedPaise} + ${take}`, updatedAt: now })
      .where(eq(charges.id, c.id))
    left -= take
    spent += take
  }
  if (spent > 0) {
    await tx
      .update(credits)
      .set({ appliedPaise: sql`${credits.appliedPaise} + ${spent}`, updatedAt: now })
      .where(eq(credits.id, cr.id))
  }
  return spent
}

// ───────────────────────────── money arriving ─────────────────────────────

/**
 * Money arrived. Record it, then spread it over what is owed.
 *
 * `method` is how it came in and nothing else. How far a charge has been
 * settled is derived from its counters, and "owes" is neither — it is a balance
 * being positive. One column that meant all three is the notebook this stage
 * replaces.
 */
export async function recordPayment(input: {
  playerId: string
  venueId: string
  amountPaise: number
  method: Method
  initiator: Initiator
  receivedAt?: Date
  note?: string | null
  actor: Actor
  audit?: AuditNote
  now?: Date
}): Promise<{ ok: true; paymentId: string; allocatedPaise: number; leftOverPaise: number } | Fail> {
  const now = input.now ?? new Date()
  const amount = Math.round(input.amountPaise)
  if (!Number.isFinite(amount) || amount <= 0) return fail('Put in an amount above zero.')
  if (amount > MAX_MONEY_PAISE) return fail('That is more than this app will take in one payment.')

  try {
    return await transact(async (tx) => {
      const id = newId('pay')
      await tx.insert(payments).values({
        id,
        venueId: input.venueId,
        playerId: input.playerId,
        amountPaise: amount,
        method: input.method,
        initiator: input.initiator,
        // Cash and a venue QR are money in hand the moment the host taps. A
        // gateway payment is only `succeeded` when the gateway says so, which
        // is stage 4's webhook — never this function's optimism.
        state: input.method === 'gateway' ? 'initiated' : 'succeeded',
        receivedAt: input.receivedAt ?? now,
        note: input.note ?? null,
        createdByUserId: input.actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      const spent = await allocate(tx, id, now, input.actor.label)
      await note(tx, input.actor, input.audit)
      return { ok: true as const, paymentId: id, allocatedPaise: spent, leftOverPaise: amount - spent }
    })
  } catch (e) {
    return refuse(e)
  }
}

/**
 * Correct what somebody owes, after the fact.
 *
 * This is SPEC-v4 §4's own worked example and it is the hardest path in the
 * file: Priya was billed ₹300 and has already paid. The charge stays — it is
 * what we said she owed on the night. A −₹300 adjustment appears. But the
 * adjustment cannot be posted while her payment is still sitting on the charge,
 * because `charges_applied_within` would refuse it, and deleting the
 * application is forbidden.
 *
 * So the order is fixed, and it lives here rather than in a host's head:
 *
 *   1. take the payment back off the charge — a NEW application row with a
 *      negative amount, pointing at the one it undoes;
 *   2. post the adjustment;
 *   3. put the freed money back to work oldest-first, and whatever is left
 *      stays on her account, visible, until it is refunded or used.
 *
 * A whole application is reversed, never part of one, so "an application is
 * undone once" stays true and the ledger reads as a sequence of complete moves.
 */
export async function correctCharge(input: {
  chargeId: string
  deltaPaise: number
  reason: string
  /**
   * What the caller believed the charge came to — `amount_paise + adjust_paise`
   * — when it worked out the delta. Re-checked under the row lock, because a
   * delta cannot re-assert anything on its own: two hosts both correcting ₹300
   * to ₹150 in the same second would otherwise both post −₹150 and land on ₹0.
   */
  expectedNetPaise?: number
  actor: Actor
  audit?: AuditNote
  now?: Date
}): Promise<{ ok: true; freedPaise: number; duePaise: number } | Fail> {
  const now = input.now ?? new Date()
  const delta = Math.round(input.deltaPaise)
  const reason = input.reason.trim().slice(0, 200)
  if (!Number.isFinite(delta) || delta === 0) return fail('A correction has to change the amount.')
  if (Math.abs(delta) > MAX_MONEY_PAISE) return fail('That is more than this app will correct in one go.')
  if (!reason) return fail('Say what the correction is for — it goes on the record.')

  try {
    return await transact(async (tx) => {
      const [c] = await tx
        .select({
          id: charges.id,
          playerId: charges.playerId,
          venueId: charges.venueId,
          amountPaise: charges.amountPaise,
          adjustPaise: charges.adjustPaise,
          appliedPaise: charges.appliedPaise,
          state: charges.state,
        })
        .from(charges)
        .where(eq(charges.id, input.chargeId))
        .limit(1)
        .for('update')
      if (!c) return fail('That charge has gone.')
      if (c.state !== 'locked') return fail('That charge is closed. A correction needs a charge that is still open.')
      if (input.expectedNetPaise != null && input.expectedNetPaise !== c.amountPaise + c.adjustPaise) {
        return fail('Somebody corrected that a moment ago. Have another look — your change was not made.')
      }

      // The same rule the waive path follows: do not move a charge under an
      // attempt that has already fixed an amount against it.
      const heldNow = await tx
        .select({ id: collectionAttemptCharges.id })
        .from(collectionAttemptCharges)
        .where(and(eq(collectionAttemptCharges.chargeId, c.id), isNull(collectionAttemptCharges.releasedAt)))
        .limit(1)
      if (heldNow.length) return fail('Somebody is collecting that right now. Let that finish, then correct it.')

      const net = c.amountPaise + c.adjustPaise + delta
      if (net < 0) return fail('That takes off more than the charge. Waive it instead, or give a credit.')

      // Step 1 — free the charge up, newest application first, whole rows only.
      let freed = 0
      if (c.appliedPaise > net) {
        const lines = await tx
          .select({
            id: chargeApplications.id,
            amountPaise: chargeApplications.amountPaise,
            paymentId: chargeApplications.paymentId,
            creditId: chargeApplications.creditId,
          })
          .from(chargeApplications)
          .where(
            and(
              eq(chargeApplications.chargeId, c.id),
              sql`${chargeApplications.amountPaise} > 0`,
              sql`not exists (
                select 1 from ${chargeApplications} r where r."reverses_id" = ${chargeApplications.id}
              )`,
            ),
          )
          .orderBy(desc(chargeApplications.at), desc(chargeApplications.id))

        for (const line of lines) {
          if (c.appliedPaise - freed <= net) break
          await tx.insert(chargeApplications).values({
            id: newId('app'),
            chargeId: c.id,
            paymentId: line.paymentId,
            creditId: line.creditId,
            amountPaise: -line.amountPaise,
            reversesId: line.id,
            reason,
            actorLabel: input.actor.label,
            at: now,
          })
          if (line.paymentId) {
            await tx
              .update(payments)
              .set({ allocatedPaise: sql`${payments.allocatedPaise} - ${line.amountPaise}`, updatedAt: now })
              .where(eq(payments.id, line.paymentId))
          }
          if (line.creditId) {
            await tx
              .update(credits)
              .set({ appliedPaise: sql`${credits.appliedPaise} - ${line.amountPaise}`, updatedAt: now })
              .where(eq(credits.id, line.creditId))
          }
          freed += line.amountPaise
        }
        await tx
          .update(charges)
          .set({ appliedPaise: sql`${charges.appliedPaise} - ${freed}`, updatedAt: now })
          .where(eq(charges.id, c.id))
      }

      // Step 2 — the correction itself, as a signed row that is never edited.
      await tx.insert(chargeAdjustments).values({
        id: newId('adj'),
        chargeId: c.id,
        deltaPaise: delta,
        reason,
        actorUserId: input.actor.userId,
        actorLabel: input.actor.label,
        at: now,
      })
      await tx
        .update(charges)
        .set({ adjustPaise: sql`${charges.adjustPaise} + ${delta}`, updatedAt: now })
        .where(eq(charges.id, c.id))

      // Step 3 — money that came loose goes back to work, oldest charge first.
      // Unconditionally: a correction that raises the amount has freed nothing,
      // and is exactly the moment money sitting on account should cover it.
      await applyOnAccount(tx, c.playerId, c.venueId, now, input.actor.label)

      await note(tx, input.actor, input.audit)
      const [after] = await tx
        .select({ due: DUE })
        .from(charges)
        .where(eq(charges.id, c.id))
        .limit(1)
      return { ok: true as const, freedPaise: freed, duePaise: Number(after?.due ?? 0) }
    })
  } catch (e) {
    return refuse(e)
  }
}

/** The host decides not to charge it at all. Only while nothing has settled it. */
export async function waiveCharge(input: {
  chargeId: string
  reason: string
  actor: Actor
  audit?: AuditNote
  now?: Date
}): Promise<{ ok: true } | Fail> {
  return closeCharge('waived', input)
}

/**
 * The debt stays true and stops being chased. A recorded decision, never a
 * deletion — and never automatic: a job that erases debt, running before there
 * is any way to collect it, writes off money nobody has been asked for.
 */
export async function writeOffCharge(input: {
  chargeId: string
  reason: string
  actor: Actor
  audit?: AuditNote
  now?: Date
}): Promise<{ ok: true } | Fail> {
  return closeCharge('written_off', input)
}

async function closeCharge(
  state: 'waived' | 'written_off',
  input: { chargeId: string; reason: string; actor: Actor; audit?: AuditNote; now?: Date },
): Promise<{ ok: true } | Fail> {
  const now = input.now ?? new Date()
  const reason = input.reason.trim().slice(0, 200)
  if (!reason) return fail('Say why — it goes on the record beside your name.')
  try {
    return await transact(async (tx) => {
      const held = await tx
        .select({ id: collectionAttemptCharges.id })
        .from(collectionAttemptCharges)
        .where(and(eq(collectionAttemptCharges.chargeId, input.chargeId), isNull(collectionAttemptCharges.releasedAt)))
        .limit(1)
      if (held.length) return fail('Somebody is collecting that right now. Let that finish first.')

      const [c] = await tx
        .select({ appliedPaise: charges.appliedPaise })
        .from(charges)
        .where(eq(charges.id, input.chargeId))
        .limit(1)
        .for('update')
      if (!c) return fail('That charge has gone.')
      if (state === 'waived' && c.appliedPaise > 0) {
        return fail('Money has already gone onto that charge. Correct the amount instead of waiving it.')
      }

      const done = await tx
        .update(charges)
        .set({ state, stateReason: reason, stateAt: now, stateByUserId: input.actor.userId, updatedAt: now })
        .where(and(eq(charges.id, input.chargeId), eq(charges.state, 'locked')))
        .returning({ id: charges.id })
      if (!done.length) return fail('That charge is already closed. Nothing was changed.')
      await note(tx, input.actor, input.audit)
      return { ok: true as const }
    })
  } catch (e) {
    return refuse(e)
  }
}

/**
 * Value given, not money received — goodwill, a rained-off night, a correction
 * the venue is eating. It settles a charge and never appears in the bank, which
 * is why the day-end tally shows it in its own column: the moment a credit
 * lands in the cash line, the cash line stops matching the drawer.
 */
export async function grantCredit(input: {
  playerId: string
  venueId: string
  amountPaise: number
  reason: string
  sourcePaymentId?: string | null
  actor: Actor
  audit?: AuditNote
  now?: Date
}): Promise<{ ok: true; creditId: string; usedPaise: number } | Fail> {
  const now = input.now ?? new Date()
  const amount = Math.round(input.amountPaise)
  const reason = input.reason.trim().slice(0, 200)
  if (!Number.isFinite(amount) || amount <= 0) return fail('Put in an amount above zero.')
  if (amount > MAX_MONEY_PAISE) return fail('That is more than this app will credit in one go.')
  if (!reason) return fail('Say what the credit is for — the player will ask.')
  try {
    return await transact(async (tx) => {
      const id = newId('cr')
      await tx.insert(credits).values({
        id,
        venueId: input.venueId,
        playerId: input.playerId,
        amountPaise: amount,
        reason,
        sourcePaymentId: input.sourcePaymentId ?? null,
        actorLabel: input.actor.label,
        createdByUserId: input.actor.userId,
        createdAt: now,
        updatedAt: now,
      })
      const used = await spendCredit(tx, id, now, input.actor.label)
      await note(tx, input.actor, input.audit)
      return { ok: true as const, creditId: id, usedPaise: used }
    })
  } catch (e) {
    return refuse(e)
  }
}

/**
 * Money going back out, against one payment. Not a negative payment: it has its
 * own row, its own reason and, once there is a gateway, its own provider id.
 * Only money that is not already spoken for can go back.
 */
export async function refundPayment(input: {
  paymentId: string
  amountPaise: number
  reason: string
  actor: Actor
  audit?: AuditNote
  now?: Date
}): Promise<{ ok: true; refundId: string } | Fail> {
  const now = input.now ?? new Date()
  const amount = Math.round(input.amountPaise)
  const reason = input.reason.trim().slice(0, 200)
  if (!Number.isFinite(amount) || amount <= 0) return fail('Put in an amount above zero.')
  if (!reason) return fail('Say what the refund is for — it goes on the record.')
  try {
    return await transact(async (tx) => {
      const [p] = await tx
        .select({
          amountPaise: payments.amountPaise,
          allocatedPaise: payments.allocatedPaise,
          refundedPaise: payments.refundedPaise,
          state: payments.state,
        })
        .from(payments)
        .where(eq(payments.id, input.paymentId))
        .limit(1)
        .for('update')
      if (!p) return fail('That payment has gone.')
      if (p.state !== 'succeeded') return fail('That payment never arrived, so there is nothing to send back.')
      const spare = p.amountPaise - p.allocatedPaise - p.refundedPaise
      if (amount > spare) {
        return fail('That is more than is left on the payment. Take it off the charges it is paying for first.')
      }
      const id = newId('ref')
      await tx.insert(refunds).values({
        id,
        paymentId: input.paymentId,
        amountPaise: amount,
        reason,
        // Cash back across the desk is done the moment it is handed over. A
        // gateway refund gets its state from the gateway, in stage 4.
        state: 'succeeded',
        actorLabel: input.actor.label,
        createdByUserId: input.actor.userId,
        createdAt: now,
        settledAt: now,
      })
      await tx
        .update(payments)
        .set({ refundedPaise: sql`${payments.refundedPaise} + ${amount}`, updatedAt: now })
        .where(eq(payments.id, input.paymentId))
      await note(tx, input.actor, input.audit)
      return { ok: true as const, refundId: id }
    })
  } catch (e) {
    return refuse(e)
  }
}

// ─────────────────── collecting: attempts and reservations ───────────────────

/**
 * Claim a set of charges for one attempt at collecting them.
 *
 * Every reservation for an attempt goes in ONE insert, so a partial claim
 * aborts the whole thing and the caller re-selects. The set of charges and the
 * amount to be collected are the same fact; letting them drift apart is how a
 * player gets debited for a charge somebody else already took.
 *
 * The transaction ends here, deliberately. Whatever happens next — a card
 * reader, a payment link, a human counting notes — happens with no transaction
 * held, and its outcome comes back through `settleAttempt` or `releaseAttempt`.
 */
export async function openAttempt(input: {
  playerId: string
  venueId: string
  kind: 'desk' | 'link' | 'mandate'
  chargeIds: readonly string[]
  actor: Actor
  now?: Date
}): Promise<{ ok: true; attemptId: string; amountPaise: number; count: number } | Fail> {
  const now = input.now ?? new Date()
  const wanted = [...new Set(input.chargeIds)]
  if (!wanted.length) return fail('Pick at least one thing to collect.')

  try {
    return await transact(async (tx) => {
      const open = await tx
        .select({ id: charges.id, due: DUE, cooldownUntil: charges.cooldownUntil })
        .from(charges)
        .where(
          and(
            eq(charges.playerId, input.playerId),
            eq(charges.venueId, input.venueId),
            eq(charges.state, 'locked'),
            inArray(charges.id, wanted),
            sql`${charges.amountPaise} + ${charges.adjustPaise} > ${charges.appliedPaise}`,
          ),
        )
        .orderBy(asc(charges.createdAt), asc(charges.id))
        .for('update')

      if (open.length !== wanted.length) {
        return fail('Some of that is already settled or has changed. Have another look and try again.')
      }
      // A cooldown is set when a collection route failed for a definite reason.
      // A host standing in front of the player may always try again; a link or
      // a debit may not, or the failure just repeats on a timer.
      if (input.kind !== 'desk') {
        const cooling = open.filter((c) => c.cooldownUntil && c.cooldownUntil.getTime() > now.getTime())
        if (cooling.length) return fail('That was tried a moment ago and did not go through. Give it a few minutes.')
      }
      const total = open.reduce((n, c) => n + Number(c.due), 0)
      if (total <= 0) return fail('There is nothing left to collect on that.')

      const attemptId = newId('att')
      await tx.insert(collectionAttempts).values({
        id: attemptId,
        venueId: input.venueId,
        playerId: input.playerId,
        kind: input.kind,
        state: 'created',
        amountPaise: total,
        createdByUserId: input.actor.userId,
        createdAt: now,
      })
      await tx.insert(collectionAttemptCharges).values(
        open.map((c) => ({
          id: newId('res'),
          attemptId,
          chargeId: c.id,
          amountPaise: Number(c.due),
          reservedAt: now,
        })),
      )
      await tx.update(collectionAttempts).set({ state: 'reserved' }).where(eq(collectionAttempts.id, attemptId))

      return { ok: true as const, attemptId, amountPaise: total, count: open.length }
    })
  } catch (e) {
    return refuse(e)
  }
}

/**
 * The money arrived. Record it, put it on the charges this attempt holds, and
 * let go — all three in one transaction, so there is never an instant where a
 * charge is neither settled nor reserved and something else could take it.
 *
 * Less than the reserved amount is fine: somebody may have paid part of it by
 * link in the gap. More is not — an attempt never collects upward.
 */
export async function settleAttempt(input: {
  attemptId: string
  method: Method
  amountPaise?: number
  receivedAt?: Date
  note?: string | null
  actor: Actor
  audit?: AuditNote
  now?: Date
}): Promise<{ ok: true; paymentId: string; allocatedPaise: number; leftOverPaise: number } | Fail> {
  const now = input.now ?? new Date()
  try {
    return await transact(async (tx) => {
      const [att] = await tx
        .select({
          id: collectionAttempts.id,
          venueId: collectionAttempts.venueId,
          playerId: collectionAttempts.playerId,
          amountPaise: collectionAttempts.amountPaise,
          state: collectionAttempts.state,
        })
        .from(collectionAttempts)
        .where(eq(collectionAttempts.id, input.attemptId))
        .limit(1)
        .for('update')
      if (!att) return fail('That collection has gone.')
      if (att.state !== 'reserved' && att.state !== 'submitting' && att.state !== 'submitted') {
        return fail('That collection is already finished. Nothing was taken twice.')
      }

      const held = await tx
        .select({ id: collectionAttemptCharges.id, chargeId: collectionAttemptCharges.chargeId })
        .from(collectionAttemptCharges)
        .where(
          and(eq(collectionAttemptCharges.attemptId, att.id), isNull(collectionAttemptCharges.releasedAt)),
        )
      if (!held.length) return fail('That collection is no longer holding anything.')

      // A gateway payment is `initiated` until the gateway says otherwise, so
      // settling one here would release every reservation while applying
      // nothing — the one instant this function exists to prevent. Stage 4
      // resolves a gateway attempt from its webhook, not from a host's tap.
      if (input.method === 'gateway') {
        return fail('A card or link payment is settled when the gateway confirms it, not from here.')
      }

      const amount = Math.round(input.amountPaise ?? att.amountPaise)
      if (!Number.isFinite(amount) || amount <= 0) return fail('Put in an amount above zero.')
      if (amount > att.amountPaise) {
        return fail('That is more than this collection is for. Take the smaller amount, or start again.')
      }

      const paymentId = newId('pay')
      await tx.insert(payments).values({
        id: paymentId,
        venueId: att.venueId,
        playerId: att.playerId,
        amountPaise: amount,
        method: input.method,
        initiator: 'host',
        state: 'succeeded',
        receivedAt: input.receivedAt ?? now,
        attemptId: att.id,
        note: input.note ?? null,
        createdByUserId: input.actor.userId,
        createdAt: now,
        updatedAt: now,
      })

      // Only onto what this attempt holds — the one caller allowed past the
      // "skip anything reserved" filter, because these are its own.
      const spent = await allocate(
        tx,
        paymentId,
        now,
        input.actor.label,
        held.map((h) => h.chargeId),
      )

      await tx
        .update(collectionAttemptCharges)
        .set({ releasedAt: now, releaseReason: 'collected' })
        .where(and(eq(collectionAttemptCharges.attemptId, att.id), isNull(collectionAttemptCharges.releasedAt)))
      await tx
        .update(collectionAttempts)
        .set({ state: 'succeeded', resolvedAt: now })
        .where(eq(collectionAttempts.id, att.id))

      await note(tx, input.actor, input.audit)
      return { ok: true as const, paymentId, allocatedPaise: spent, leftOverPaise: amount - spent }
    })
  } catch (e) {
    return refuse(e)
  }
}

/**
 * Let go of the charges without collecting.
 *
 * A definite failure releases with a reason and puts a short cooldown on the
 * charges so the next thing along does not immediately try the same route.
 * There is no elapsed-time rule anywhere that releases a reservation on its
 * own: an outcome releases it, or a named human does. Freezing ₹900 costs a
 * message; collecting it twice costs the player's trust.
 */
export async function releaseAttempt(input: {
  attemptId: string
  reason: string
  state?: 'failed' | 'unknown'
  cooldownMinutes?: number
  now?: Date
}): Promise<{ ok: true; released: number } | Fail> {
  const now = input.now ?? new Date()
  const reason = input.reason.trim().slice(0, 200) || 'released'
  try {
    return await transact(async (tx) => {
      const [att] = await tx
        .select({
          id: collectionAttempts.id,
          state: collectionAttempts.state,
          playerId: collectionAttempts.playerId,
          venueId: collectionAttempts.venueId,
        })
        .from(collectionAttempts)
        .where(eq(collectionAttempts.id, input.attemptId))
        .limit(1)
        .for('update')
      if (!att) return fail('That collection has gone.')
      if (att.state === 'succeeded') return fail('That one was collected. It cannot be given back here.')

      // `unknown` keeps its hold on purpose — the outcome is not known, so
      // nothing else may touch those charges until somebody finds out.
      if (input.state === 'unknown') {
        await tx
          .update(collectionAttempts)
          .set({ state: 'unknown', outcomeNote: reason })
          .where(eq(collectionAttempts.id, att.id))
        return { ok: true as const, released: 0 }
      }

      const gone = await tx
        .update(collectionAttemptCharges)
        .set({ releasedAt: now, releaseReason: reason })
        .where(and(eq(collectionAttemptCharges.attemptId, att.id), isNull(collectionAttemptCharges.releasedAt)))
        .returning({ chargeId: collectionAttemptCharges.chargeId })

      if (input.cooldownMinutes && gone.length) {
        await tx
          .update(charges)
          .set({ cooldownUntil: new Date(now.getTime() + input.cooldownMinutes * 60_000), updatedAt: now })
          .where(
            inArray(
              charges.id,
              gone.map((g) => g.chargeId),
            ),
          )
      }

      await tx
        .update(collectionAttempts)
        .set({ state: 'failed', outcomeNote: reason, resolvedAt: now })
        .where(eq(collectionAttempts.id, att.id))

      // A charge that was unreachable while it was held may have had money
      // waiting on account the whole time. Letting go is the moment it lands.
      if (gone.length) await applyOnAccount(tx, att.playerId, att.venueId, now, 'the desk')

      return { ok: true as const, released: gone.length }
    })
  } catch (e) {
    return refuse(e)
  }
}

/**
 * Taking money at the desk, through the same interlock a gateway will use.
 *
 * Two transactions, not one, and that is the point of doing it this way for
 * cash. Between them sits the part that is not a database write — the host
 * counting notes, a phone showing a QR — and the reservation is what stops the
 * other host's phone collecting the same ₹300 while it happens.
 */
export async function collectAtDesk(input: {
  playerId: string
  venueId: string
  chargeIds: readonly string[]
  method: Method
  amountPaise?: number
  note?: string | null
  actor: Actor
  audit?: AuditNote
  now?: Date
}): Promise<{ ok: true; paymentId: string; allocatedPaise: number; leftOverPaise: number } | Fail> {
  const held = await openAttempt({
    playerId: input.playerId,
    venueId: input.venueId,
    kind: 'desk',
    chargeIds: input.chargeIds,
    actor: input.actor,
    now: input.now,
  })
  if (!held.ok) return held

  let done: { ok: true; paymentId: string; allocatedPaise: number; leftOverPaise: number } | Fail
  try {
    done = await settleAttempt({
      attemptId: held.attemptId,
      method: input.method,
      amountPaise: input.amountPaise,
      note: input.note,
      actor: input.actor,
      audit: input.audit,
      now: input.now,
    })
  } catch (e) {
    // A throw between the two transactions is the one way a reservation is
    // stranded: the hold is committed, nothing releases it, and the charge
    // becomes uncollectable and unwaivable for good. The hold exists to stop a
    // double collection, and nothing was collected here, so let it go.
    await releaseAttempt({ attemptId: held.attemptId, reason: 'the collection failed', now: input.now })
    throw e
  }
  if (!done.ok) {
    // Nothing was collected, so the charges go back where anybody can reach them.
    await releaseAttempt({ attemptId: held.attemptId, reason: 'not collected', now: input.now })
  }
  return done
}

// ───────────────────────────── reading it back ─────────────────────────────

/** postgres.js hands back an array, PGlite an object with rows. Both are real Postgres. */
function rowsOf<T>(res: unknown): T[] {
  const r = res as { rows?: T[] } | T[]
  return Array.isArray(r) ? r : (r.rows ?? [])
}

export type Balance = {
  playerId: string
  /** What is still owed on open charges. Never negative. */
  owedPaise: number
  /** Money in hand that has not found a charge yet, plus unused credit. */
  onAccountPaise: number
  /** Owed less on account. Positive means they owe; negative means we hold theirs. */
  balancePaise: number
  openCharges: number
  oldestOpenAt: Date | null
}

const ZERO = (playerId: string): Balance => ({
  playerId,
  owedPaise: 0,
  onAccountPaise: 0,
  balancePaise: 0,
  openCharges: 0,
  oldestOpenAt: null,
})

/**
 * What a set of players owe — read from `player_balances`, which is a view over
 * the rows and nothing else.
 *
 * There is no balance column anywhere, and this is the only function that
 * computes one. A stored balance is a number that can quietly disagree with the
 * rows it claims to summarise; two ways of deriving it is the same bug with an
 * extra step.
 */
export async function balancesFor(playerIds: readonly string[], venueId: string): Promise<Map<string, Balance>> {
  const ids = [...new Set(playerIds)].filter(Boolean)
  const out = new Map<string, Balance>(ids.map((id) => [id, ZERO(id)]))
  if (!ids.length) return out

  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
  const res = await db.execute(sql`
    select "player_id", "owed_paise", "on_account_paise", "balance_paise", "open_charges", "oldest_open_at"
    from "player_balances"
    where "venue_id" = ${venueId} and "player_id" in (${list})
  `)
  for (const r of rowsOf<{
    player_id: string
    owed_paise: number | string
    on_account_paise: number | string
    balance_paise: number | string
    open_charges: number | string
    oldest_open_at: string | Date | null
  }>(res)) {
    out.set(r.player_id, {
      playerId: r.player_id,
      owedPaise: Number(r.owed_paise),
      onAccountPaise: Number(r.on_account_paise),
      balancePaise: Number(r.balance_paise),
      openCharges: Number(r.open_charges),
      oldestOpenAt: r.oldest_open_at ? new Date(r.oldest_open_at) : null,
    })
  }
  return out
}

export async function balanceFor(playerId: string, venueId: string): Promise<Balance> {
  const all = await balancesFor([playerId], venueId)
  return all.get(playerId) ?? ZERO(playerId)
}

export type OpenCharge = {
  id: string
  reason: string
  amountPaise: number
  adjustPaise: number
  appliedPaise: number
  duePaise: number
  createdAt: Date
  sessionId: string | null
  /** Somebody is collecting it right now, so nothing else may. */
  heldByAttemptId: string | null
}

/** What is still collectable from one player, oldest first — the desk's list. */
export async function openChargesFor(playerId: string, venueId: string): Promise<OpenCharge[]> {
  const list = await db
    .select({
      id: charges.id,
      reason: charges.reason,
      amountPaise: charges.amountPaise,
      adjustPaise: charges.adjustPaise,
      appliedPaise: charges.appliedPaise,
      createdAt: charges.createdAt,
      sessionId: charges.sessionId,
      heldByAttemptId: collectionAttemptCharges.attemptId,
    })
    .from(charges)
    .leftJoin(
      collectionAttemptCharges,
      and(eq(collectionAttemptCharges.chargeId, charges.id), isNull(collectionAttemptCharges.releasedAt)),
    )
    .where(
      and(
        eq(charges.playerId, playerId),
        eq(charges.venueId, venueId),
        eq(charges.state, 'locked'),
        sql`${charges.amountPaise} + ${charges.adjustPaise} > ${charges.appliedPaise}`,
      ),
    )
    .orderBy(asc(charges.createdAt), asc(charges.id))

  return list.map((c) => ({ ...c, duePaise: c.amountPaise + c.adjustPaise - c.appliedPaise }))
}

/**
 * The oldest thing each of these players still owes for — one query, not one
 * per person.
 *
 * The collections screen wants to say what the debt is FOR and link to the
 * night it came from. Doing that with a read per debtor is a hundred queries on
 * a page render against a single pooled connection, which is the shape that
 * looks fine on a laptop and falls over on the host.
 */
export async function oldestOpenChargeFor(
  playerIds: readonly string[],
  venueId: string,
): Promise<Map<string, { chargeId: string; reason: string; sessionId: string | null; createdAt: Date }>> {
  const ids = [...new Set(playerIds)].filter(Boolean)
  const out = new Map<string, { chargeId: string; reason: string; sessionId: string | null; createdAt: Date }>()
  if (!ids.length) return out

  const list = sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  )
  const res = await db.execute(sql`
    select distinct on (c."player_id")
      c."player_id", c."id" as "charge_id", c."reason", c."session_id", c."created_at"
    from "charges" c
    where c."venue_id" = ${venueId}
      and c."player_id" in (${list})
      and c."state" = 'locked'
      and c."amount_paise" + c."adjust_paise" > c."applied_paise"
    order by c."player_id", c."created_at" asc, c."id" asc
  `)
  for (const r of rowsOf<{
    player_id: string
    charge_id: string
    reason: string
    session_id: string | null
    created_at: string | Date
  }>(res)) {
    out.set(r.player_id, {
      chargeId: r.charge_id,
      reason: r.reason,
      sessionId: r.session_id,
      createdAt: new Date(r.created_at),
    })
  }
  return out
}

export type SessionCharge = {
  participationId: string
  chargeId: string
  /** WHO OWES, which for a guest is the inviter — never who played. */
  payerPlayerId: string
  amountPaise: number
  adjustPaise: number
  appliedPaise: number
  duePaise: number
  state: ChargeRow['state']
  priceSource: string
  priceNote: string | null
}

/** Every charge one night produced, keyed by the participation that earned it. */
export async function sessionMoney(sessionId: string): Promise<Map<string, SessionCharge>> {
  const list = await db
    .select({
      participationId: charges.participationId,
      chargeId: charges.id,
      payerPlayerId: charges.playerId,
      amountPaise: charges.amountPaise,
      adjustPaise: charges.adjustPaise,
      appliedPaise: charges.appliedPaise,
      state: charges.state,
      priceSource: charges.priceSource,
      priceNote: charges.priceNote,
    })
    .from(charges)
    .where(and(eq(charges.sessionId, sessionId), eq(charges.origin, 'participation')))

  const out = new Map<string, SessionCharge>()
  for (const c of list) {
    if (!c.participationId) continue
    out.set(c.participationId, {
      ...c,
      participationId: c.participationId,
      duePaise: c.amountPaise + c.adjustPaise - c.appliedPaise,
    })
  }
  return out
}

export type Provisional = {
  participationId: string
  displayName: string
  payerPlayerId: string
  paise: number
  source: 'session' | 'override'
  note: string | null
  /** Will be billed when the night locks. `absent` will not. */
  billable: boolean
}

/**
 * What tonight is going to cost, before it becomes a fact — m6.
 *
 * A pure function of the roster, so the screen that shows it and the code that
 * writes the charges cannot disagree: both call `effectivePrice`. Moving a
 * dispute to before the money moves is the cheapest dispute handling there is,
 * and it only works if the number shown is the number written.
 */
export function provisionalFor(
  session: { pricePaise: number },
  roster: ReadonlyArray<{
    id: string
    displayName: string
    payerPlayerId: string
    state: string
    priceOverridePaise: number | null
    priceNote: string | null
  }>,
): { lines: Provisional[]; totalPaise: number } {
  const lines = roster
    .filter((r) => r.state === 'checked_in' || r.state === 'played')
    .map((r) => {
      const price = effectivePrice(session, r)
      return {
        participationId: r.id,
        displayName: r.displayName,
        payerPlayerId: r.payerPlayerId,
        paise: price.paise,
        source: price.source,
        note: price.note,
        billable: true,
      }
    })
  return { lines, totalPaise: lines.reduce((n, l) => n + l.paise, 0) }
}

export type DayTally = {
  /** Money in, by how it came in. Cash matches the drawer; the rest matches a statement. */
  byMethod: Array<{ method: string; paise: number; count: number }>
  takenPaise: number
  /** Value given rather than received. Never in the cash line. */
  creditedPaise: number
  refundedPaise: number
  /** What the night's charges came to, and what is still out. */
  chargedPaise: number
  owedPaise: number
  charges: number
}

/**
 * The day-end tally, split by method — m4.
 *
 * Cash has to match the drawer and the gateway has to match the settlement
 * record. The moment one number stands for both, a shortfall in one is hidden
 * by a surplus in the other and nobody trusts the app again.
 */
export async function dayTally(venueId: string, from: Date, until: Date): Promise<DayTally> {
  const [byMethod, credited, refunded, raised] = await Promise.all([
    db
      .select({
        method: payments.method,
        paise: sql<number>`coalesce(sum(${payments.amountPaise}), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(payments)
      .where(
        and(
          eq(payments.venueId, venueId),
          eq(payments.state, 'succeeded'),
          gte(payments.receivedAt, from),
          lt(payments.receivedAt, until),
        ),
      )
      .groupBy(payments.method)
      .orderBy(asc(payments.method)),
    db
      .select({ paise: sql<number>`coalesce(sum(${credits.amountPaise}), 0)` })
      .from(credits)
      .where(and(eq(credits.venueId, venueId), gte(credits.createdAt, from), lt(credits.createdAt, until))),
    db
      .select({ paise: sql<number>`coalesce(sum(${refunds.amountPaise}), 0)` })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(
        and(
          eq(payments.venueId, venueId),
          eq(refunds.state, 'succeeded'),
          gte(refunds.createdAt, from),
          lt(refunds.createdAt, until),
        ),
      ),
    db
      .select({
        paise: sql<number>`coalesce(sum(${charges.amountPaise} + ${charges.adjustPaise}), 0)`,
        owed: sql<number>`coalesce(sum(case when ${charges.state} = 'locked' then ${charges.amountPaise} + ${charges.adjustPaise} - ${charges.appliedPaise} else 0 end), 0)`,
        count: sql<number>`count(*)`,
      })
      .from(charges)
      .where(and(eq(charges.venueId, venueId), gte(charges.createdAt, from), lt(charges.createdAt, until))),
  ])

  const lines = byMethod.map((m) => ({ method: m.method, paise: Number(m.paise), count: Number(m.count) }))
  return {
    byMethod: lines,
    takenPaise: lines.reduce((n, m) => n + m.paise, 0),
    creditedPaise: Number(credited[0]?.paise ?? 0),
    refundedPaise: Number(refunded[0]?.paise ?? 0),
    chargedPaise: Number(raised[0]?.paise ?? 0),
    owedPaise: Number(raised[0]?.owed ?? 0),
    charges: Number(raised[0]?.count ?? 0),
  }
}

export type LedgerEntry =
  | { kind: 'charge'; id: string; at: Date; paise: number; what: string; state: ChargeRow['state'] }
  | { kind: 'adjustment'; id: string; at: Date; paise: number; what: string; chargeId: string }
  | { kind: 'payment'; id: string; at: Date; paise: number; what: string; method: string }
  | { kind: 'credit'; id: string; at: Date; paise: number; what: string }
  | { kind: 'refund'; id: string; at: Date; paise: number; what: string }

/**
 * One player's money, newest first, as a list of things that happened.
 *
 * Every line is a row that was written once and never edited, which is what
 * makes this answerable: "why does she owe ₹300" has an answer made of
 * timestamps and names rather than of a number somebody recalculated.
 */
export async function ledgerFor(playerId: string, venueId: string, limit = 60): Promise<LedgerEntry[]> {
  const [cs, adj, pays, crs, refs] = await Promise.all([
    db
      .select({
        id: charges.id,
        at: charges.createdAt,
        paise: charges.amountPaise,
        what: charges.reason,
        state: charges.state,
      })
      .from(charges)
      .where(and(eq(charges.playerId, playerId), eq(charges.venueId, venueId)))
      .orderBy(desc(charges.createdAt))
      .limit(limit),
    db
      .select({
        id: chargeAdjustments.id,
        at: chargeAdjustments.at,
        paise: chargeAdjustments.deltaPaise,
        what: chargeAdjustments.reason,
        chargeId: chargeAdjustments.chargeId,
      })
      .from(chargeAdjustments)
      .innerJoin(charges, eq(charges.id, chargeAdjustments.chargeId))
      .where(and(eq(charges.playerId, playerId), eq(charges.venueId, venueId)))
      .orderBy(desc(chargeAdjustments.at))
      .limit(limit),
    db
      .select({
        id: payments.id,
        at: payments.receivedAt,
        paise: payments.amountPaise,
        method: payments.method,
        note: payments.note,
      })
      .from(payments)
      .where(and(eq(payments.playerId, playerId), eq(payments.venueId, venueId), eq(payments.state, 'succeeded')))
      .orderBy(desc(payments.receivedAt))
      .limit(limit),
    db
      .select({ id: credits.id, at: credits.createdAt, paise: credits.amountPaise, what: credits.reason })
      .from(credits)
      .where(and(eq(credits.playerId, playerId), eq(credits.venueId, venueId)))
      .orderBy(desc(credits.createdAt))
      .limit(limit),
    db
      .select({ id: refunds.id, at: refunds.createdAt, paise: refunds.amountPaise, what: refunds.reason })
      .from(refunds)
      .innerJoin(payments, eq(payments.id, refunds.paymentId))
      .where(and(eq(payments.playerId, playerId), eq(payments.venueId, venueId), eq(refunds.state, 'succeeded')))
      .orderBy(desc(refunds.createdAt))
      .limit(limit),
  ])

  const all: LedgerEntry[] = [
    ...cs.map((c) => ({ kind: 'charge' as const, ...c })),
    ...adj.map((a) => ({ kind: 'adjustment' as const, ...a })),
    ...pays.map((p) => ({
      kind: 'payment' as const,
      id: p.id,
      at: p.at,
      paise: p.paise,
      method: p.method,
      what: p.note ?? 'Paid',
    })),
    ...crs.map((c) => ({ kind: 'credit' as const, ...c })),
    ...refs.map((r) => ({ kind: 'refund' as const, ...r })),
  ]
  return all.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit)
}

export type Drift = {
  /** Which counter disagrees — the five the CHECKs depend on. */
  table: 'charge' | 'charge_adjust' | 'payment' | 'payment_refund' | 'credit'
  id: string
  stored: number
  fromRows: number
}

/**
 * Do the settlement counters still agree with the rows they summarise?
 *
 * The counters exist because a CHECK cannot aggregate another table, and a
 * constraint only guards a number somebody maintains. One code path that
 * inserts an application without moving the counter and the guarantees stop
 * guaranteeing anything — silently, because the constraint still passes.
 *
 * So this asks the rows. A test runs it after every path in this file, and the
 * host's money screen shows it: an empty answer is the whole point.
 */
export async function moneyDrift(venueId: string): Promise<Drift[]> {
  const res = await db.execute(sql`
    select 'charge' as "table", c."id", c."applied_paise" as "stored",
           coalesce((select sum(a."amount_paise") from "charge_applications" a where a."charge_id" = c."id"), 0) as "from_rows"
    from "charges" c
    where c."venue_id" = ${venueId}
      and c."applied_paise" <> coalesce((select sum(a."amount_paise") from "charge_applications" a where a."charge_id" = c."id"), 0)
    union all
    select 'charge_adjust', c."id", c."adjust_paise",
           coalesce((select sum(j."delta_paise") from "charge_adjustments" j where j."charge_id" = c."id"), 0)
    from "charges" c
    where c."venue_id" = ${venueId}
      and c."adjust_paise" <> coalesce((select sum(j."delta_paise") from "charge_adjustments" j where j."charge_id" = c."id"), 0)
    union all
    select 'payment', p."id", p."allocated_paise",
           coalesce((select sum(a."amount_paise") from "charge_applications" a where a."payment_id" = p."id"), 0)
    from "payments" p
    where p."venue_id" = ${venueId}
      and p."allocated_paise" <> coalesce((select sum(a."amount_paise") from "charge_applications" a where a."payment_id" = p."id"), 0)
    union all
    select 'payment_refund', p."id", p."refunded_paise",
           coalesce((select sum(r."amount_paise") from "refunds" r where r."payment_id" = p."id" and r."state" = 'succeeded'), 0)
    from "payments" p
    where p."venue_id" = ${venueId}
      and p."refunded_paise" <> coalesce((select sum(r."amount_paise") from "refunds" r where r."payment_id" = p."id" and r."state" = 'succeeded'), 0)
    union all
    select 'credit', k."id", k."applied_paise",
           coalesce((select sum(a."amount_paise") from "charge_applications" a where a."credit_id" = k."id"), 0)
    from "credits" k
    where k."venue_id" = ${venueId}
      and k."applied_paise" <> coalesce((select sum(a."amount_paise") from "charge_applications" a where a."credit_id" = k."id"), 0)
  `)
  return rowsOf<{ table: Drift['table']; id: string; stored: number | string; from_rows: number | string }>(res).map(
    (r) => ({ table: r.table, id: r.id, stored: Number(r.stored), fromRows: Number(r.from_rows) }),
  )
}

export type Debtor = Balance & { name: string; phone: string | null }

/**
 * Everybody who owes the venue money, longest-waiting first.
 *
 * Venue-wide rather than per-night on purpose: a debt does not belong to the
 * Tuesday it came from, it belongs to a person, and the screen that chases it
 * has to show somebody who owes for a game three weeks ago and has not been
 * back since.
 */
export async function debtorsFor(venueId: string, limit = 100): Promise<Debtor[]> {
  const res = await db.execute(sql`
    select b."player_id", b."owed_paise", b."on_account_paise", b."balance_paise",
           b."open_charges", b."oldest_open_at", p."name", p."phone"
    from "player_balances" b
    join "players" p on p."id" = b."player_id"
    where b."venue_id" = ${venueId} and b."balance_paise" > 0 and p."deleted_at" is null
    order by b."oldest_open_at" asc nulls last, b."balance_paise" desc
    limit ${limit}
  `)
  return rowsOf<{
    player_id: string
    owed_paise: number | string
    on_account_paise: number | string
    balance_paise: number | string
    open_charges: number | string
    oldest_open_at: string | Date | null
    name: string
    phone: string | null
  }>(res).map((r) => ({
    playerId: r.player_id,
    owedPaise: Number(r.owed_paise),
    onAccountPaise: Number(r.on_account_paise),
    balancePaise: Number(r.balance_paise),
    openCharges: Number(r.open_charges),
    oldestOpenAt: r.oldest_open_at ? new Date(r.oldest_open_at) : null,
    name: r.name,
    phone: r.phone,
  }))
}
