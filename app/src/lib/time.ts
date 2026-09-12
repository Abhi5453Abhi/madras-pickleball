/**
 * Store UTC, render Asia/Kolkata, never use the server's local date for "today".
 * Vercel runs UTC and every load-bearing time here is local (SPEC A9).
 */
export const VENUE_TZ = 'Asia/Kolkata'

const timeFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: VENUE_TZ,
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const clockFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: VENUE_TZ,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
})

const dateFmt = new Intl.DateTimeFormat('en-IN', {
  timeZone: VENUE_TZ,
  weekday: 'short',
  day: 'numeric',
  month: 'short',
})

const dayKeyFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: VENUE_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

/** "16:34" in venue time. */
export function venueTime(d: Date | string): string {
  return timeFmt.format(typeof d === 'string' ? new Date(d) : d)
}

/**
 * "3:00 pm" in venue time — how this app says a time inside a sentence, where
 * venueTime's "15:00" belongs to a grid or a range.
 *
 * Midnight and noon get their names. A court held "till 12:00 am" reads as an
 * early morning nobody meant, and on the day view a court free "06:00–00:00"
 * reads as a range that ends before it starts.
 */
export function venueClock(d: Date | string): string {
  const at = typeof d === 'string' ? new Date(d) : d
  const hhmm = venueTime(at)
  if (hhmm === '00:00') return 'midnight'
  if (hhmm === '12:00') return 'noon'
  return clockFmt.format(at)
}

/** "Sun, 14 Sep" in venue time. */
export function venueDate(d: Date | string): string {
  return dateFmt.format(typeof d === 'string' ? new Date(d) : d)
}

/** "2026-09-14" in venue time — the only correct basis for "today's matches". */
export function venueDayKey(d: Date | string = new Date()): string {
  return dayKeyFmt.format(typeof d === 'string' ? new Date(d) : d)
}

export function minutesBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 60000)
}

/** "7 hrs 34" / "45 min" */
export function formatDuration(totalMinutes: number): string {
  const m = Math.max(0, Math.round(totalMinutes))
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem === 0 ? `${h} hr${h === 1 ? '' : 's'}` : `${h} hr${h === 1 ? '' : 's'} ${rem}`
}

/** "12 min ago" — used on live court cards. */
export function elapsedLabel(since: Date | string, now: Date = new Date()): string {
  const m = minutesBetween(typeof since === 'string' ? new Date(since) : since, now)
  if (m < 1) return 'just started'
  return `${m} min`
}

/**
 * The instant that ends today AT THE VENUE, as UTC. `d.setHours(23,59,...)` is
 * the server's midnight: on a UTC host that is 05:29 the next morning in
 * Chennai, so a court card printed at 9am would keep working overnight.
 */
export function endOfVenueDay(from: Date = new Date()): Date {
  const key = venueDayKey(from) // YYYY-MM-DD at the venue
  // +05:30 is fixed: India has no daylight saving and one offset nationwide.
  return new Date(`${key}T23:59:59+05:30`)
}

/** The instant a venue day starts, as UTC. */
export function startOfVenueDay(from: Date = new Date()): Date {
  return new Date(`${venueDayKey(from)}T00:00:00+05:30`)
}

/**
 * A venue-local date and time as the instant it actually is.
 *
 * `new Date('2026-09-15T19:00')` is the *server's* seven o'clock, which on a
 * UTC host is half past midnight in Chennai. India has one offset nationwide
 * and no daylight saving, so +05:30 is a constant rather than a lookup.
 *
 * Returns null for anything that isn't a date and a time, so a hand-typed form
 * value can be checked rather than becoming an Invalid Date three layers down.
 */
export function venueInstant(dayKey: string, hhmm: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dayKey) || !/^\d{2}:\d{2}$/.test(hhmm)) return null
  const d = new Date(`${dayKey}T${hhmm}:00+05:30`)
  return Number.isNaN(d.getTime()) ? null : d
}

/** "19:00" in venue time — what a time input wants back. */
export function venueTimeValue(d: Date): string {
  return venueTime(d)
}

/**
 * "19:00" → 1140, minutes from the start of a venue day. Null for anything
 * that is not a time, so a hand-typed form value can be checked rather than
 * silently becoming NaN.
 */
export function minutesOfDay(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 24 || min > 59 || (h === 24 && min !== 0)) return null
  return h * 60 + min
}

/** 1140 → "19:00", what a time input wants. */
export function hhmmFromMinutes(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
