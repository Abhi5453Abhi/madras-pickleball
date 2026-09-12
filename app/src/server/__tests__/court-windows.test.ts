import { describe, expect, it } from 'vitest'
import {
  dayKeysBetween,
  gaps,
  lastSlot,
  resolveWindows,
  slotFloor,
  tournamentWindows,
} from '../courts'

/**
 * The arithmetic that decides what a holder gets.
 *
 * `resolveWindows` is the single place the check and the write agree about what
 * is being taken, so every way it can be wrong is a court double-booked or a
 * refusal nobody caused. It needs no database, which means it can be pinned
 * down exactly — every case below is one a reviewer found by reading.
 */

const t = (iso: string) => new Date(iso)
const w = (a: string, b: string) => ({ from: t(a), until: t(b) })
/** 19:00–21:00 IST on the 15th, in UTC. */
const SEVEN = '2026-09-15T13:30:00Z'
const NINE = '2026-09-15T15:30:00Z'

describe('what a holder gets on one court', () => {
  it('leaves a game that is overrunning exactly where it is', () => {
    // 21:10, on a game booked until 21:00 that nobody has ended. Anchoring on
    // a hold that is *running* rather than one that has *begun* made this
    // resolve to nothing — and "no window" was then read as "no hold", which
    // took every court off a game that was still being played on them.
    const had = [{ heldFrom: t(SEVEN), heldUntil: t(NINE) }]
    const out = resolveWindows([w(SEVEN, NINE)], had, t('2026-09-15T15:40:00Z'))
    expect(out.length).toBe(1)
    expect(out[0].from.toISOString()).toBe(t(SEVEN).toISOString())
    expect(out[0].until.toISOString()).toBe(t(NINE).toISOString())
  })

  it('does not drag an old start along when the game moves later', () => {
    const had = [{ heldFrom: t(SEVEN), heldUntil: t(NINE) }]
    const out = resolveWindows([w('2026-09-15T16:30:00Z', '2026-09-15T17:30:00Z')], had, t('2026-09-15T14:00:00Z'))
    expect(out.length).toBe(1)
    expect(out[0].from.toISOString()).toBe('2026-09-15T16:30:00.000Z')
  })

  it('starts a new court in this quarter hour when nothing is in the way', () => {
    const out = resolveWindows([w(SEVEN, '2026-09-15T17:30:00Z')], [], t('2026-09-15T15:35:00Z'))
    expect(out[0].from.toISOString()).toBe('2026-09-15T15:30:00.000Z')
  })

  it('walks past the quarter hours somebody else owns', () => {
    // A block that ended at 21:05 still owns 21:00. Refusing outright left the
    // venue with no way forward for ten minutes; the answer it wants is
    // "you have it from 21:30".
    const taken = new Set([t('2026-09-15T15:30:00Z').getTime(), t('2026-09-15T15:45:00Z').getTime()])
    const out = resolveWindows([w(SEVEN, '2026-09-15T17:30:00Z')], [], t('2026-09-15T15:35:00Z'), taken)
    expect(out[0].from.toISOString()).toBe('2026-09-15T16:00:00.000Z')
  })

  it('resolves to nothing when the hours have gone, or when none of them are free', () => {
    expect(resolveWindows([w('2026-09-15T10:00:00Z', '2026-09-15T11:00:00Z')], [], t('2026-09-15T15:40:00Z')).length).toBe(0)
    const every = new Set<number>()
    for (let x = t('2026-09-15T15:30:00Z').getTime(); x < t('2026-09-15T17:30:00Z').getTime(); x += 900_000) every.add(x)
    expect(resolveWindows([w(SEVEN, '2026-09-15T17:30:00Z')], [], t('2026-09-15T15:35:00Z'), every).length).toBe(0)
  })

  it('matches a multi-day holder’s windows by overlap, never by position', () => {
    // had = [Mon, Tue]; asked = [Tue, Wed, Thu]. Matched by index, Monday's
    // hold anchored Tuesday's window into a thirty-hour hold that collided
    // with the next one in the same INSERT.
    const had = [
      { heldFrom: t('2026-09-14T03:30:00Z'), heldUntil: t('2026-09-14T09:30:00Z') },
      { heldFrom: t('2026-09-15T03:30:00Z'), heldUntil: t('2026-09-15T09:30:00Z') },
    ]
    const asked = [
      w('2026-09-15T03:30:00Z', '2026-09-15T09:30:00Z'),
      w('2026-09-16T03:30:00Z', '2026-09-16T09:30:00Z'),
      w('2026-09-17T03:30:00Z', '2026-09-17T09:30:00Z'),
    ]
    const out = resolveWindows(asked, had, t('2026-09-16T04:30:00Z'))
    const overlapping = out.some((a, i) => out.some((b, j) => i !== j && a.from < b.until && b.from < a.until))
    expect(overlapping).toBe(false)
    expect(out.every((x) => x.until.getTime() - x.from.getTime() <= 24 * 3600_000)).toBe(true)
  })
})

describe('the grid', () => {
  it('floors to the quarter hour and keeps the last slot inside the window', () => {
    expect(slotFloor(t('2026-09-15T13:37:00Z')).toISOString()).toBe('2026-09-15T13:30:00.000Z')
    expect(lastSlot(t(NINE)).toISOString()).toBe('2026-09-15T15:15:00.000Z')
  })
})

describe('the gaps between holds', () => {
  const from = t('2026-09-15T00:00:00Z')
  const until = t('2026-09-16T00:00:00Z')

  it('charges a five-minute hold its whole quarter hour', () => {
    const out = gaps([{ heldFrom: t('2026-09-15T13:35:00Z'), heldUntil: t('2026-09-15T13:40:00Z') }], from, until)
    expect(out.length).toBe(2)
    expect(out[0].until.toISOString()).toBe('2026-09-15T13:30:00.000Z')
    expect(out[1].from.toISOString()).toBe('2026-09-15T13:45:00.000Z')
  })

  it('merges overlapping holds into one busy stretch', () => {
    const out = gaps(
      [
        { heldFrom: t('2026-09-15T03:30:00Z'), heldUntil: t('2026-09-15T09:30:00Z') },
        { heldFrom: t('2026-09-15T08:00:00Z'), heldUntil: t('2026-09-15T11:00:00Z') },
      ],
      from,
      until,
    )
    expect(out.length).toBe(2)
  })

  it('gives the whole window back when nothing is on', () => {
    expect(gaps([], from, until).length).toBe(1)
  })
})

describe('the days a tournament runs', () => {
  it('walks forward only, inclusively, and stops at a fortnight and a half', () => {
    expect(dayKeysBetween('2026-09-19', '2026-09-21').length).toBe(3)
    expect(dayKeysBetween('2026-09-21', '2026-09-19').length).toBe(0)
    expect(dayKeysBetween('2026-09-01', '2026-12-01').length).toBe(31)
  })

  it('makes whole days that abut exactly, so day two does not fight day one', () => {
    const ws = tournamentWindows(t('2026-09-19T02:30:00Z'), t('2026-09-20T02:30:00Z'), null)
    expect(ws.length).toBe(2)
    expect(ws[0].until.getTime()).toBe(ws[1].from.getTime())
  })
})

describe('a day that is already over', () => {
  const NOW = t('2026-09-15T06:00:00Z')

  it('keeps the hold exactly as it was truncated, rather than resurrecting the hours', () => {
    // Day one ran 09:00–15:00 and was truncated to 12:30 when the tournament
    // finished. Re-saving its courts on day two must not put 15:00 back — and
    // must not then ask whether 12:30–15:00 is free, because a court that is
    // free right now would be refused over yesterday afternoon.
    const had = [{ heldFrom: t('2026-09-14T03:30:00Z'), heldUntil: t('2026-09-14T07:00:00Z') }]
    const out = resolveWindows([w('2026-09-14T03:30:00Z', '2026-09-14T09:30:00Z')], had, NOW)
    expect(out.length).toBe(1)
    expect(out[0].until.toISOString()).toBe('2026-09-14T07:00:00.000Z')
  })

  it('takes nothing on a day it was never on', () => {
    expect(resolveWindows([w('2026-09-14T03:30:00Z', '2026-09-14T09:30:00Z')], [], NOW).length).toBe(0)
  })

  it('resolves a three-day tournament mid-run into three windows that do not overlap', () => {
    const had = [
      { heldFrom: t('2026-09-14T03:30:00Z'), heldUntil: t('2026-09-14T07:00:00Z') },
      { heldFrom: t('2026-09-15T03:30:00Z'), heldUntil: t('2026-09-15T09:30:00Z') },
    ]
    const asked = [
      w('2026-09-14T03:30:00Z', '2026-09-14T09:30:00Z'),
      w('2026-09-15T03:30:00Z', '2026-09-15T09:30:00Z'),
      w('2026-09-16T03:30:00Z', '2026-09-16T09:30:00Z'),
    ]
    const out = resolveWindows(asked, had, NOW)
    expect(out.length).toBe(3)
    expect(out[0].until.toISOString()).toBe('2026-09-14T07:00:00.000Z')
    expect(out[1].from.toISOString()).toBe('2026-09-15T03:30:00.000Z')
    expect(out[2].from.toISOString()).toBe('2026-09-16T03:30:00.000Z')
    const overlapping = out.some((a, i) => out.some((b, j) => i !== j && a.from < b.until && b.from < a.until))
    expect(overlapping).toBe(false)
  })
})
