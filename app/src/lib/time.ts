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
