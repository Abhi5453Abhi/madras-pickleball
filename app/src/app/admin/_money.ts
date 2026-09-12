import { rupees } from '@/lib/display'
import type { SessionCharge } from '@/server/money'

/**
 * How a charge is said out loud, in one place.
 *
 * The Tonight screen and the game screen were each spelling this out for
 * themselves and drifting apart on the row that matters most: a coach billed
 * ₹0 read as "free" on one and "₹0 · paid" on the other. Nothing was ever paid
 * on a ₹0 charge — there was nothing to pay — so it never says "paid", at
 * either end.
 *
 * The override note rides with the amount wherever the amount appears, because
 * "₹0" on its own is the billing bug this app exists to make impossible to
 * confuse with a decision.
 */
export function chargeWords(c: SessionCharge): string {
  const net = c.amountPaise + c.adjustPaise
  const note = c.priceSource === 'override' && c.priceNote ? ` · ${c.priceNote}` : ''
  const said = `${net === 0 ? 'free' : rupees(net)}${note}`

  if (c.state === 'waived') return `${said} · waived`
  if (c.state === 'written_off') return `${said} · written off`
  if (net === 0) return said
  if (c.duePaise <= 0) return `${said} · paid`
  if (c.appliedPaise > 0) return `${said} · ${rupees(c.duePaise)} still owed`
  return `${said} · not paid yet`
}
