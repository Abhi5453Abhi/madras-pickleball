/**
 * Turning a WhatsApp message into a player list — SPEC A2.
 *
 * The list already exists, in a group chat. This parses that, not a CSV: strip
 * numbering, bullets and emoji, one name per line, a 10-digit number is a phone.
 * It never rejects a paste — anything it can't read comes back flagged for the
 * admin to fix in the review table.
 *
 * The cleverer inference (splitting "Arun / Deepa" into a pair, reading gender
 * and skill) waits until we have real lists from the venue's group to test
 * against. Writing a parser against an imagined format produces a parser for an
 * imagined format.
 *
 * Pure. Tested.
 */

export type ParsedRow = {
  raw: string
  name: string
  phone: string | null
  /** Something the admin should look at before importing. */
  warning?: string
}

const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}]/gu

/**
 * 10-digit Indian mobile, with or without a +91 or 0 prefix, and tolerating the
 * spaces and hyphens people actually type ("+91 98400 12345").
 */
const PHONE = /(?:\+?\s*91[\s-]*)?0?\s*([6-9](?:[\s-]*\d){9})/

export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** E.164 where we can be confident; otherwise null and the raw value is kept. */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null
  const digits = input.replace(/\D/g, '')
  const ten = digits.slice(-10)
  if (ten.length !== 10 || !/^[6-9]/.test(ten)) return null
  return `+91${ten}`
}

export function parsePlayerList(text: string): ParsedRow[] {
  const rows: ParsedRow[] = []

  for (const line of text.split(/\r?\n/)) {
    const raw = line
    let s = line.replace(EMOJI, ' ')

    // Leading list markers: "1.", "1)", "-", "*", "•"
    s = s.replace(/^\s*(?:\d{1,3}\s*[.)\]-]|[-*•·—])\s*/, '')
    // Trailing paid markers people add: ✅ (already stripped), "paid", "(paid)"
    s = s.replace(/\(?\bpaid\b\)?/gi, ' ')
    s = s.replace(/\s+/g, ' ').trim()

    if (!s) continue

    let phone: string | null = null
    const m = s.match(PHONE)
    if (m) {
      phone = normalizePhone(m[0])
      s = s.replace(m[0], ' ').replace(/\s+/g, ' ').trim()
    }

    // Anything left that is mostly digits isn't a name.
    const name = s.replace(/[,;|]+$/, '').trim()
    if (!name) {
      rows.push({ raw, name: '', phone, warning: 'No name on this line' })
      continue
    }

    const row: ParsedRow = { raw, name, phone }
    if (/[/&+]| and /i.test(name)) {
      row.warning = 'Two names on this line — is this a pair?'
    } else if (name.length < 2) {
      row.warning = 'Very short name'
    } else if (!/[a-z]/i.test(name)) {
      row.warning = 'Doesn’t look like a name'
    }
    rows.push(row)
  }

  return rows
}

/**
 * "Ravi S", "S Ravi", "Ravi" and "Ravi Shankar" are, more often than not, one
 * man typing his name four ways into a group chat. Two name keys look like the
 * same person when every word of the shorter one is a whole word, or the start
 * of a word, in the longer one — and at least one of them is a whole word, so a
 * pair of initials does not match everybody.
 *
 * It is a flag for the organiser, never a decision: "Ravi Kumar" and "Ravi
 * Shankar" share a first name and are two people, and this says so.
 */
export function looksLikeSamePerson(a: string, b: string): boolean {
  if (!a || !b) return false
  if (a === b) return true
  const wa = a.split(' ')
  const wb = b.split(' ')
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  const unused = [...long]
  let whole = false
  for (const w of short) {
    const i = unused.findIndex((u) => u === w || u.startsWith(w) || w.startsWith(u))
    if (i === -1) return false
    if (unused[i] === w) whole = true
    unused.splice(i, 1)
  }
  return whole
}

/** Flags rows that look like the same human, so the roster stays one row per person. */
export function findDuplicates(
  rows: ParsedRow[],
  existing: Array<{ id: string; name: string; nameKey: string; phoneKey: string | null }>,
): Map<number, { id: string; name: string; on: 'phone' | 'name' }> {
  const byPhone = new Map(existing.filter((e) => e.phoneKey).map((e) => [e.phoneKey!, e]))
  const byName = new Map(existing.map((e) => [e.nameKey, e]))
  const out = new Map<number, { id: string; name: string; on: 'phone' | 'name' }>()

  rows.forEach((row, i) => {
    const phoneKey = normalizePhone(row.phone)
    if (phoneKey && byPhone.has(phoneKey)) {
      const hit = byPhone.get(phoneKey)!
      out.set(i, { id: hit.id, name: hit.name, on: 'phone' })
      return
    }
    const nameKey = normalizeName(row.name)
    if (nameKey && byName.has(nameKey)) {
      const hit = byName.get(nameKey)!
      out.set(i, { id: hit.id, name: hit.name, on: 'name' })
    }
  })

  return out
}
