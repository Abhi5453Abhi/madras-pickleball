'use client'

import { useActionState, useMemo, useState } from 'react'
import { quickStart, type QuickState } from './actions'
import { Button, Input, Label, Notice } from '@/components/ui'
import { parsePlayerList } from '@/lib/parse-players'

const SHAPES = [
  { key: 'open_doubles', label: 'Doubles', hint: 'anyone with anyone' },
  { key: 'mens_doubles', label: "Men's Doubles", hint: '' },
  { key: 'womens_doubles', label: "Women's Doubles", hint: '' },
  { key: 'singles', label: 'Singles', hint: 'one v one' },
]

export function QuickForm({ defaultName }: { defaultName: string }) {
  const [state, action, pending] = useActionState(quickStart, {} as QuickState)
  const [shape, setShape] = useState('open_doubles')
  const [paste, setPaste] = useState('')

  // Same parser the server uses, so the count on screen is the count it imports.
  const parsed = useMemo(() => parsePlayerList(paste).filter((r) => r.name), [paste])
  const teamSize = shape === 'singles' ? 1 : 2
  const teamCount = Math.floor(parsed.length / teamSize)
  const leftOver = parsed.length - teamCount * teamSize

  return (
    <form action={action} className="flex flex-col gap-5">
      {state.error ? <Notice>{state.error}</Notice> : null}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="name">What are you calling it?</Label>
        <Input id="name" name="name" defaultValue={defaultName} required />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1.5 text-sm font-semibold text-ink">What are they playing?</legend>
        <input type="hidden" name="shape" value={shape} />
        <div className="grid grid-cols-2 gap-2">
          {SHAPES.map((s) => (
            <button
              key={s.key}
              type="button"
              onClick={() => setShape(s.key)}
              aria-pressed={shape === s.key}
              className={`tap-lg rounded-xl border px-3 text-left text-sm font-semibold transition-colors ${
                shape === s.key
                  ? 'border-ink bg-ink text-white'
                  : 'border-line-strong bg-paper text-ink hover:bg-ground'
              }`}
            >
              <span className="block">{s.label}</span>
              {s.hint ? (
                <span
                  className={`block text-xs font-normal ${shape === s.key ? 'text-white/70' : 'text-muted'}`}
                >
                  {s.hint}
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="players">Paste the list from WhatsApp</Label>
        <textarea
          id="players"
          name="players"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          rows={8}
          placeholder={'1. Ravi Kumar\n2. Priya S 9840012345\n3. Karthik\n…'}
          className="w-full rounded-xl border border-line-strong bg-paper p-3.5 font-mono text-sm text-ink placeholder:text-muted/60 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none"
        />
        <p className="text-xs text-muted">
          Numbering, bullets, ticks and phone numbers are all fine — they get stripped.
        </p>
      </div>

      {parsed.length > 0 ? (
        <p className="rounded-xl bg-accent-soft px-3.5 py-3 text-sm font-medium text-accent">
          {parsed.length} player{parsed.length === 1 ? '' : 's'} · {teamCount} team
          {teamCount === 1 ? '' : 's'}
          {leftOver > 0 ? ` · ${leftOver} left over, added as a substitute` : ''}
        </p>
      ) : null}

      <Button type="submit" disabled={pending || teamCount < 2}>
        {pending ? 'Setting it up…' : 'Start'}
      </Button>
      <p className="-mt-2 text-center text-xs text-muted">
        Pairs randomly and creates the matches. You can change all of it afterwards.
      </p>
    </form>
  )
}
