import { clsx } from 'clsx'
import { useMemo, useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { Discipline, FinalsStage, Gender, Output } from '@/api/contract'
import { useAction, useRpc } from '@/api/use-rpc'
import { Chevron, CourtSwatch, Input, Label, Notice } from '@/components/ui'
import { venueDayKey } from '@/lib/time'
import { Loading, LoadError, useTitle } from '@/lib/page'

type Calendar = Output<'events.courtCalendar'>

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
  { key: 'final_only', label: '…then the top 2 play a final' },
  { key: 'semis_and_final', label: '…then the top 4 play semis and a final' },
] as const

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

function categoryName(gender: string, discipline: string) {
  const g = GENDERS.find((x) => x.key === gender)?.label ?? ''
  return `${g} ${discipline === 'singles' ? 'Singles' : 'Doubles'}`
}

export function NewTournamentPage() {
  useTitle('New tournament · Madras Pickleball')
  const calendar = useRpc('events.courtCalendar', {})

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          to="/admin"
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          Tournaments
        </Link>
        <h1 className="mt-1 text-title text-text">New tournament</h1>
      </header>
      {calendar.state === 'loading' ? <Loading /> : null}
      {calendar.state === 'ready' ? (
        <NewForm calendar={calendar.data} todayKey={venueDayKey(new Date())} />
      ) : null}
      {calendar.state === 'error' || calendar.state === 'missing' ? (
        <LoadError error={calendar.error} retry={() => void calendar.reload(false)} />
      ) : null}
    </div>
  )
}

/**
 * Everything the schedule needs, nothing else. Courts are picked here but can
 * be changed right up to the start; a court another tournament holds that day
 * is shown, named, and not pickable.
 */
function NewForm({ calendar, todayKey }: { calendar: Calendar; todayKey: string }) {
  const { run, pending } = useAction()
  const [error, setError] = useState<string | null>(null)
  const [gender, setGender] = useState<string>('mens')
  const [discipline, setDiscipline] = useState<string>('doubles')
  const [format, setFormat] = useState<string>('final_only')
  const [date, setDate] = useState<string>(todayKey)
  const [name, setName] = useState<string>('')
  const [nameTouched, setNameTouched] = useState(false)
  const [picked, setPicked] = useState<string[]>([])

  // The name writes itself from the category and the month until the
  // organiser types their own; then it is theirs.
  const suggested = useMemo(() => {
    const m = Number(date.slice(5, 7))
    const month = MONTHS[m - 1] ?? ''
    return `${categoryName(gender, discipline)}${month ? ` — ${month}` : ''}`
  }, [gender, discipline, date])
  const shownName = nameTouched ? name : suggested

  const heldToday = useMemo(() => {
    const map = new Map<string, { name: string }>()
    for (const h of calendar.held) if (h.dayKey === date) map.set(h.courtId, h)
    return map
  }, [calendar.held, date])

  // The greyed chip already names who holds the court; one sentence says why.
  const anyHeld = calendar.courts.some((c) => heldToday.has(c.id))

  function toggleCourt(id: string) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('events.createEvent', {
      name: shownName.trim(),
      date,
      gender: gender as Gender,
      discipline: discipline as Discipline,
      format: format as FinalsStage,
      courts: picked,
    })
    // On success `useAction` follows the redirect the server hands back.
    if (!res.ok) setError(res.error)
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      {error ? <Notice>{error}</Notice> : null}

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
      </div>

      <Chips legend="Who plays" name="gender" value={gender} onChange={setGender} options={GENDERS} cols={4} />

      <Chips
        legend="Singles or doubles"
        name="discipline"
        value={discipline}
        onChange={setDiscipline}
        options={DISCIPLINES}
        cols={2}
      />

      <div className="flex flex-col gap-2">
        <Chips legend="Format" name="format" value={format} onChange={setFormat} options={FORMATS} cols={1} />
        <p className="text-meta text-text-3">
          Level on wins? Most points scored goes through. Best of 3 games to 11.
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-row text-text">Courts</legend>
        <div className="flex flex-wrap gap-2">
          {calendar.courts.map((c) => {
            const held = heldToday.get(c.id)
            const on = picked.includes(c.id)
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
                <CourtSwatch colorKey={c.colorKey} size="md" onInk={on} />
                {c.name}
                {held ? <span className="font-normal">· {held.name}</span> : null}
              </button>
            )
          })}
        </div>
        <p className="text-meta text-text-3">
          {picked.length ? `${picked.length} court${picked.length === 1 ? '' : 's'} picked. ` : 'Pick the courts it plays on. '}
          {anyHeld
            ? 'A greyed court belongs to another tournament that day — take it off there to use it here.'
            : 'You can change them until the start.'}
        </p>
      </fieldset>

      <div className="flex flex-col gap-2">
        <button
          type="submit"
          disabled={pending}
          className="tap-xl w-full rounded-control bg-ink px-5 text-[20px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Making it…' : 'Create · opens sign-ups'}
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
