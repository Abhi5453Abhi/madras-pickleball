/**
 * How money and names are rendered. Pure, tested.
 *
 * The rupee helpers exist because a daily game has a price and the tournament
 * side never did — every amount in this app is integer paise, and this is the
 * only place it becomes a string.
 */

/**
 * First name and last initial — what the public games page shows.
 *
 * The link gets forwarded into WhatsApp groups, so the page has to answer "is
 * Suresh playing?" without being a directory of the venue's members (SPEC-v4 §8).
 * Case is left as the person typed it; only the initial is raised, because
 * correcting someone's capitalisation is not this function's business and
 * `toUpperCase` on a Tamil initial is a no-op anyway.
 */
export function publicName(full: string): string {
  const parts = full.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return 'Someone'
  const first = parts[0]
  if (parts.length === 1) return first
  const initial = [...parts[parts.length - 1]][0]
  return initial ? `${first} ${initial.toUpperCase()}.` : first
}

const WHOLE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 0,
})
const PAISE = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

/**
 * "₹300", or "₹300.50" when it isn't a round rupee. Indian digit grouping, so
 * a lakh reads ₹1,00,000 rather than ₹100,000.
 */
export function rupees(paise: number): string {
  const n = Math.trunc(paise)
  const negative = n < 0
  const abs = Math.abs(n)
  const body = abs % 100 === 0 ? WHOLE.format(abs / 100) : PAISE.format(abs / 100)
  return negative ? `−${body}` : body
}

/** "₹300" with no currency symbol — for a column that already has one in its head. */
export function rupeesPlain(paise: number): string {
  const abs = Math.abs(Math.trunc(paise))
  const s = abs % 100 === 0 ? String(abs / 100) : (abs / 100).toFixed(2)
  return Math.trunc(paise) < 0 ? `−${s}` : s
}

/**
 * ₹1,00,000. The column is a 32-bit integer, so an unbounded parse turns a
 * fat-fingered price into `integer out of range` at the database rather than a
 * sentence on the form.
 */
export const MAX_PAISE = 10_000_000

/** Whole rupees to paise, for a form field. Returns null on anything that isn't money. */
export function paiseFromRupeeInput(raw: string): number | null {
  const s = raw.trim().replace(/[₹,\s]/g, '')
  if (s === '') return 0
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null
  const [whole, frac = ''] = s.split('.')
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  if (!Number.isSafeInteger(paise) || paise > MAX_PAISE) return null
  return paise
}

/** "12/16" — spots taken out of capacity. */
export function spotsLabel(taken: number, capacity: number): string {
  return `${taken}/${capacity}`
}

/**
 * "Court 3" / "Courts 3 and 4" / "2 courts".
 *
 * Names when we know them, a count when we do not — a game seeded or made
 * before courts were real has a number and nothing else, and "0 courts" is
 * worse than saying nothing.
 */
export function courtsLabel(names: readonly string[], count: number): string {
  if (names.length === 1) return names[0]
  if (names.length > 1) {
    const short = names.map((n) => n.replace(/^Court\s+/i, ''))
    return `Courts ${short.slice(0, -1).join(', ')} and ${short[short.length - 1]}`
  }
  return count === 1 ? '1 court' : `${count} courts`
}
