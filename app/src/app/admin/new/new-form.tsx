'use client'

import { clsx } from 'clsx'
import { useActionState, useMemo, useState } from 'react'
import { createTournamentAction, type NewState } from './actions'
import { Input, Label, Notice } from '@/components/ui'
import { minutesOfDay } from '@/lib/time'
import type { CourtCalendar } from '@/server/events'

const GENDERS = [
  { key: 'mens', label: "Men's" },
  { key: 'womens', label: "Women's" },
  { key: 'mixed', label: 'Mixed' },
  { key: 'any', label: 'Open' },
] as const

const DISCIPLINES = [
  { key: 'singles', label: 'Singles' },
  { key: 'doubles', label: 'Doubles' },
] as const

const FORMATS = [
  { key: 'none', label: 'Everyone plays everyone' },
  { key: 'final_only', label: 'League, then top 2 play a final' },
  { key: 'semis_and_final', label: 'League, then top 4 play semis and final' },
] as const

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** "2026-09-15" plus n days, as a calendar date. UTC arithmetic, so exact. */
function addDays(dayKey: string, n: number): string {
  const [y, m, d] = dayKey.split('-').map(Number)
  if (!y || !m || !d) return dayKey
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** "9:00 am–3:00 pm", or "all day" when it is the whole of one. */
function span(fromMin: number, untilMin: number): string {
  if (fromMin <= 0 && untilMin >= 24 * 60) return 'all day'
  return `${clock(fromMin)}–${clock(untilMin)}`
}

function clock(min: number): string {
  const h24 = Math.floor(min / 60) % 24
  const m = min % 60
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'am' : 'pm'}`
}

function categoryName(gender: string, discipline: string) {
  const g = GENDERS.find((x) => x.key === gender)?.label ?? ''
  return `${g} ${discipline === 'singles' ? 'Singles' : 'Doubles'}`
}

/**
 * Everything the schedule needs, nothing else. Courts are picked here but can
 * be changed right up to the start; a court another tournament holds that day
 * is shown, named, and not pickable.
 */
export function NewForm({
  calendar,
  todayKey,
  nowMin,
}: {
  calendar: CourtCalendar
  todayKey: string
  /** Minutes into today at the venue. Everything before it has gone. */
  nowMin: number
}) {
  const [state, action, pending] = useActionState(createTournamentAction, {} as NewState)
  const [gender, setGender] = useState<string>('mens')
  const [discipline, setDiscipline] = useState<string>('doubles')
  const [format, setFormat] = useState<string>('final_only')
  const [date, setDate] = useState<string>(todayKey)
  const [name, setName] = useState<string>('')
  const [nameTouched, setNameTouched] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [days, setDays] = useState<string>('1')
  const [courtsFrom, setCourtsFrom] = useState<string>('')
  const [courtsUntil, setCourtsUntil] = useState<string>('')

  // The name writes itself from the category and the month until the
  // organiser types their own; then it is theirs.
  const suggested = useMemo(() => {
    const m = Number(date.slice(5, 7))
    const month = MONTHS[m - 1] ?? ''
    return `${categoryName(gender, discipline)}${month ? ` — ${month}` : ''}`
  }, [gender, discipline, date])
  const shownName = nameTouched ? name : suggested

  // The hours asked for, as minutes of the day. Both blank means the whole of
  // it, which is what a tournament held before it could hold part of one.
  const want = useMemo(() => {
    const asked =
      !courtsFrom && !courtsUntil
        ? { fromMin: 0, untilMin: 24 * 60 }
        : (() => {
            const fromMin = minutesOfDay(courtsFrom)
            const untilMin = minutesOfDay(courtsUntil)
            return fromMin === null || untilMin === null || untilMin <= fromMin
              ? null
              : { fromMin, untilMin }
          })()
    if (!asked) return { kind: 'bad' as const }
    // On today, the hours that have gone are not hours anybody is competing
    // for: a court a finished tournament held all morning is free this
    // evening, and greying it out would be a lie the server disagrees with.
    // Only TODAY is clipped — day two of a weekend is entirely in the future.
    if (date !== todayKey) return { kind: 'ok' as const, ...asked, askedFromMin: asked.fromMin }
    const fromMin = Math.max(asked.fromMin, nowMin)
    return fromMin < asked.untilMin
      ? { kind: 'ok' as const, fromMin, untilMin: asked.untilMin, askedFromMin: asked.fromMin }
      : { kind: 'gone' as const }
  }, [courtsFrom, courtsUntil, date, todayKey, nowMin])

  // Every day it runs, not just the first: a court free on Saturday and taken
  // on Sunday is not a court a weekend tournament can have.
  const dayKeys = useMemo(() => {
    const count = Math.min(Math.max(Math.round(Number(days) || 1), 1), 14)
    return Array.from({ length: count }, (_, i) => addDays(date, i))
  }, [date, days])

  // Whoever is in the way of THOSE hours, per court. A court held nine to three
  // is not in the way of a seven o'clock game, which is the whole point.
  const clashByCourt = useMemo(() => {
    const map = new Map<string, { holderName: string; label: string }>()
    if (want.kind !== 'ok') return map
    const wanted = new Set(dayKeys)
    for (const h of calendar.held) {
      if (!wanted.has(h.dayKey)) continue
      // "Now" only clips the day that is actually today; day two is asked
      // about in full, or a weekend tournament misses tomorrow morning.
      const fromMin = h.dayKey === todayKey ? want.fromMin : want.askedFromMin
      if (h.untilMin <= fromMin || h.fromMin >= want.untilMin) continue
      if (!map.has(h.courtId)) map.set(h.courtId, { holderName: h.holderName, label: span(h.fromMin, h.untilMin) })
    }
    return map
  }, [calendar.held, dayKeys, todayKey, want])

  // The greyed chip already names who holds the court; one sentence says why.
  const anyHeld = calendar.courts.some((c) => clashByCourt.has(c.id))

  function toggleCourt(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  }

  // A court picked before the hours changed may now be somebody else's. Keeping
  // it selected would post a court the server is about to refuse.
  const pickedFree = picked.filter((id) => !clashByCourt.has(id))

  return (
    <form action={action} className="flex flex-col gap-6">
      {state.error ? <Notice>{state.error}</Notice> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">Name</Label>
        <Input
          id="name"
          name="name"
          value={shownName}
          onChange={(e) => {
            setNameTouched(true)
            setName(e.target.value)
          }}
          required
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="date">Date</Label>
        <Input
          id="date"
          name="date"
          type="date"
          value={date}
          min={todayKey}
          onChange={(e) => {
            setDate(e.target.value)
            // A court held on the new day cannot stay picked.
            setPicked([])
          }}
          required
        />
        <div className="flex items-end gap-3">
          <div>
            <Label htmlFor="days">Days</Label>
            <Input
              id="days"
              name="days"
              type="number"
              min={1}
              max={14}
              value={days}
              onChange={(e) => setDays(e.target.value)}
              className="mt-2 w-24"
            />
          </div>
          <p className="pb-3 text-meta text-text-3">
            {Number(days) > 1
              ? `It holds its courts on all ${days} days.`
              : 'A tournament that runs over a weekend holds its courts on both days.'}
          </p>
        </div>
      </div>

      <Chips
        legend="Who plays"
        name="gender"
        value={gender}
        onChange={setGender}
        options={GENDERS}
        cols={4}
      />

      <Chips
        legend="Singles or doubles"
        name="discipline"
        value={discipline}
        onChange={setDiscipline}
        options={DISCIPLINES}
        cols={2}
      />

      <div className="flex flex-col gap-2">
        <Chips
          legend="Format"
          name="format"
          value={format}
          onChange={setFormat}
          options={FORMATS}
          cols={1}
        />
        <p className="text-meta text-text-3">
          If two teams tie on wins, whoever scored more points goes through. Matches are best of 3 games to 11.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-row text-text">Courts</legend>
        {pickedFree.map((id) => (
          <input key={id} type="hidden" name="courts" value={id} />
        ))}
        <div className="flex flex-wrap gap-2">
          {calendar.courts.map((c) => {
            const held = clashByCourt.get(c.id)
            const on = pickedFree.includes(c.id)
            return (
              <button
                key={c.id}
                type="button"
                disabled={!!held}
                onClick={() => toggleCourt(c.id)}
                aria-pressed={on}
                className={clsx(
                  'tap inline-flex items-center gap-2 rounded-full border px-3.5 text-[16px] font-semibold transition-colors',
                  held
                    ? 'cursor-not-allowed border-line bg-sunken text-text-3'
                    : on
                      ? 'border-ink bg-ink text-white'
                      : 'border-line-key bg-paper text-text hover:bg-ground',
                )}
              >
                {c.name}
                {held ? (
                  <span className="font-normal">
                    · {held.holderName} {held.label}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>
        <div className="mt-1 flex flex-wrap items-end gap-3">
          <div>
            <Label htmlFor="courtsFrom">On court from</Label>
            <Input
              id="courtsFrom"
              name="courtsFrom"
              type="time"
              value={courtsFrom}
              onChange={(e) => setCourtsFrom(e.target.value)}
              className="mt-2"
            />
          </div>
          <div>
            <Label htmlFor="courtsUntil">until</Label>
            <Input
              id="courtsUntil"
              name="courtsUntil"
              type="time"
              value={courtsUntil}
              onChange={(e) => setCourtsUntil(e.target.value)}
              className="mt-2"
            />
          </div>
        </div>
        <p className="text-meta text-text-3">
          {pickedFree.length
            ? `${pickedFree.length} court${pickedFree.length === 1 ? '' : 's'} picked. `
            : 'Pick the courts it plays on. '}
          {want.kind === 'bad'
            ? 'Those hours don’t read as a start and a finish.'
            : want.kind === 'gone'
              ? 'Those hours have already gone today. Pick a later finish, or another day.'
              : anyHeld
              ? 'A greyed court is somebody else’s during those hours — change the hours, or take it off them.'
              : 'Leave the hours blank to hold them all day. You can change any of this until the start.'}
        </p>
      </fieldset>

      <div className="flex flex-col gap-2">
        <button
          type="submit"
          disabled={pending}
          className="tap-xl w-full rounded-control bg-ink px-5 text-[20px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Making it…' : 'Create'}
        </button>
      </div>
    </form>
  )
}

function Chips<T extends string>({
  legend,
  name,
  value,
  onChange,
  options,
  cols,
}: {
  legend: string
  name: string
  value: string
  onChange: (v: T) => void
  options: ReadonlyArray<{ key: T; label: string }>
  cols: 1 | 2 | 4
}) {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-2 text-row text-text">{legend}</legend>
      <input type="hidden" name={name} value={value} />
      <div
        className={clsx(
          'grid gap-2',
          cols === 4 && 'grid-cols-2 sm:grid-cols-4',
          cols === 2 && 'grid-cols-2',
          cols === 1 && 'grid-cols-1',
        )}
      >
        {options.map((o) => {
          const on = o.key === value
          return (
            <button
              key={o.key}
              type="button"
              onClick={() => onChange(o.key)}
              aria-pressed={on}
              className={clsx(
                'tap rounded-control border px-3.5 text-left text-[16px] font-semibold transition-colors',
                on ? 'border-ink bg-ink text-white' : 'border-line-key bg-paper text-text hover:bg-ground',
              )}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </fieldset>
  )
}
