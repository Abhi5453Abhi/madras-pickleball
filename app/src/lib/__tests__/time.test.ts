import { describe, expect, it } from 'vitest'
import { hhmmFromMinutes, minutesOfDay, venueClock, venueTime } from '../time'

/**
 * The venue is always +05:30, so every case here is a literal in and a literal
 * out. These helpers decide what a court screen says a court is free until,
 * which is the one sentence on that screen anybody reads.
 */

const at = (iso: string) => new Date(iso)

describe('venueClock', () => {
  it('says a time the way a sentence says it', () => {
    expect(venueClock(at('2026-09-15T13:30:00Z'))).toBe('7:00 pm')
    expect(venueClock(at('2026-09-15T03:30:00Z'))).toBe('9:00 am')
  })

  it('names midnight and noon, which "12:00 am" does not', () => {
    // The end of a Tuesday evening, not an early Wednesday morning.
    expect(venueClock(at('2026-09-15T18:30:00Z'))).toBe('midnight')
    expect(venueClock(at('2026-09-15T06:30:00Z'))).toBe('noon')
    // A minute either side keeps its number.
    expect(venueClock(at('2026-09-15T18:31:00Z'))).toBe('12:01 am')
    expect(venueClock(at('2026-09-15T18:29:00Z'))).toBe('11:59 pm')
  })

  it('leaves the grid clock alone', () => {
    expect(venueTime(at('2026-09-15T18:30:00Z'))).toBe('00:00')
    expect(venueTime(at('2026-09-15T13:30:00Z'))).toBe('19:00')
  })
})

describe('minutesOfDay', () => {
  it('reads a time input', () => {
    expect(minutesOfDay('19:00')).toBe(1140)
    expect(minutesOfDay('00:00')).toBe(0)
    expect(minutesOfDay('9:05')).toBe(545)
    expect(minutesOfDay(' 23:45 ')).toBe(1425)
  })

  it('takes 24:00 as the end of the day, which is a thing a closing time is', () => {
    expect(minutesOfDay('24:00')).toBe(1440)
    expect(minutesOfDay('24:30')).toBeNull()
  })

  it('refuses anything that is not a time, rather than becoming NaN', () => {
    expect(minutesOfDay('')).toBeNull()
    expect(minutesOfDay('half seven')).toBeNull()
    expect(minutesOfDay('19:60')).toBeNull()
    expect(minutesOfDay('19-00')).toBeNull()
    expect(minutesOfDay('25:00')).toBeNull()
  })
})

describe('hhmmFromMinutes', () => {
  it('round-trips what a time input gave us', () => {
    for (const hhmm of ['00:00', '06:15', '12:00', '19:00', '23:45']) {
      expect(hhmmFromMinutes(minutesOfDay(hhmm)!)).toBe(hhmm)
    }
  })
})
