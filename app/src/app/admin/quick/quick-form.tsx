'use client'

import { clsx } from 'clsx'
import { useActionState, useMemo, useState } from 'react'
import { quickStart, type QuickState } from './actions'
import { Input, Label, Notice } from '@/components/ui'
import { parsePlayerList } from '@/lib/parse-players'
import { estimateDay, leagueMatchCount, minutesPerMatch } from '@/lib/estimate'
import { formatDuration, venueTime } from '@/lib/time'

// "Men's Doubles · men only" is the label twice. A hint only earns its line
// where the label leaves a real question.
const SHAPES = [
  { key: 'open_doubles', label: 'Doubles', hint: 'anyone with anyone' },
  { key: 'mens_doubles', label: "Men's Doubles", hint: '' },
  { key: 'womens_doubles', label: "Women's Doubles", hint: '' },
  { key: 'singles', label: 'Singles', hint: 'one v one' },
]

/**
 * SPEC A2. The 90-second path, and the only one a new organiser will have used
 * before their first Sunday — so it says what it is about to do at every step
 * rather than after Start.
 *
 * The two things it now tells you that it did not: the names it actually read
 * out of the paste (a parser that silently drops a line is worse than one that
 * refuses), and how long the day it is about to create will take. That second
 * number is the one SPEC A3 exists for; showing it after the draw is built is
 * showing it too late to act on.
 */
export function QuickForm({ defaultName, courts }: { defaultName: string; courts: number }) {
  const [state, action, pending] = useActionState(quickStart, {} as QuickState)
  const [shape, setShape] = useState('open_doubles')
  const [paste, setPaste] = useState('')

  // Same parser the server uses, so the count on screen is the count it imports.
  const parsed = useMemo(() => parsePlayerList(paste).filter((r) => r.name), [paste])
  const teamSize = shape === 'singles' ? 1 : 2
  const teamCount = Math.floor(parsed.length / teamSize)
  const leftOver = parsed.length - teamCount * teamSize
  const enough = teamCount >= 2

  // Quick Play always makes a league with a final — mirror `quickStart`, or
  // this promises a day the server will not build.
  const day = useMemo(() => {
    if (!enough) return null
    const { matches } = leagueMatchCount(teamCount, 'final_only')
    return estimateDay({
      categories: [
        {
          name: 'Quick play',
          matchCount: matches,
          minutesPerMatch: minutesPerMatch({ bestOf: 3, pointsToWin: 11 }),
          minMatchesPerEntry: teamCount - 1,
        },
      ],
      courts,
      startAt: new Date(),
    })
  }, [enough, teamCount, courts])

  return (
    <form action={action} className="flex flex-col gap-6">
      {state.error ? <Notice>{state.error}</Notice> : null}

      <div className="flex flex-col gap-2">
        <Label htmlFor="name">What are you calling it?</Label>
        <Input id="name" name="name" defaultValue={defaultName} required />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-2 text-row text-text">What are they playing?</legend>
        <input type="hidden" name="shape" value={shape} />
        <div className="grid grid-cols-2 gap-2">
          {SHAPES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setShape(s.key)}
              aria-pressed={shape === s.key}
              // A fixed height on all four, not `tap-lg`: "Women's Doubles"
              // wraps to two lines at 390px and made the second row of the
              // grid taller than the first.
              className={clsx(
                'flex min-h-[84px] flex-col justify-center rounded-control border px-3.5 py-2 text-left transition-colors',
                shape === s.key
                  ? 'border-ink bg-ink text-white'
                  : 'border-line-strong bg-paper text-text hover:bg-ground',
              )}
            >
              <span className="block text-row text-balance">{s.label}</span>
              {s.hint ? (
                <span
                  className={clsx(
                    'mt-0.5 block text-meta',
                    shape === s.key ? 'text-on-ink-2' : 'text-text-3',
                  )}
                >
                  {s.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label htmlFor="players">Paste the list from the group chat</Label>
        <textarea
          id="players"
          name="players"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={8}
          placeholder={'1. Ravi Kumar\n2. Priya S 9840012345\n3. Karthik\n…'}
          className="w-full rounded-control border border-line-strong bg-paper p-3.5 font-mono text-body text-text placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none"
        />
        <p className="text-meta text-text-3">
          Numbering, bullets, ticks and phone numbers are all fine — they get stripped. Nothing is
          ever rejected.
        </p>
      </div>

      {parsed.length > 0 ? (
        <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
          <p className="num text-row text-text">
            {parsed.length} player{parsed.length === 1 ? '' : 's'} · {teamCount}{' '}
            {teamSize === 1 ? 'entrant' : 'pair'}
            {teamCount === 1 ? '' : 's'}
          </p>
          {leftOver > 0 ? (
            <p className="mt-1 text-meta text-waiting">
              {leftOver === 1 ? 'One name is' : `${leftOver} names are`} left over — they go on the
              substitutes list, not into a pair.
            </p>
          ) : null}

          {/* A parser that quietly drops a line is worse than one that refuses,
              so the names it read are on screen before Start is tapped. */}
          <p className="mt-2 text-meta text-text-2">
            {parsed
              .slice(0, 12)
              .map((p) => p.name)
              .join(' · ')}
            {parsed.length > 12 ? ` · and ${parsed.length - 12} more` : ''}
          </p>

          {day ? (
            <p className="num mt-3 border-t border-line pt-3 text-body text-text">
              {day.totalMatches} matches across {courts} court{courts === 1 ? '' : 's'} —{' '}
              {formatDuration(day.minutes)}, finishing about{' '}
              <span className="font-bold">{day.finishAt ? venueTime(day.finishAt) : '—'}</span>.
              Everyone plays at least {teamCount - 1} match{teamCount - 1 === 1 ? '' : 'es'}.
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        <button
          type="submit"
          disabled={pending || !enough}
          className="tap-xl w-full rounded-control bg-ink px-5 text-[20px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? 'Setting it up…' : 'Start'}
        </button>
        <p className="text-center text-meta text-text-2">
          {enough
            ? 'Pairs everyone at random, makes the draw and goes live. You can change all of it afterwards.'
            : `Paste at least ${teamSize * 2} names — ${parsed.length} so far.`}
        </p>
      </div>
    </form>
  )
}
