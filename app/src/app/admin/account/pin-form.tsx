'use client'

import { useActionState } from 'react'
import { changePin, type PinState } from './actions'
import { Button, Label, Notice } from '@/components/ui'

const FIELD =
  'tap w-full rounded-control border border-line-key bg-paper px-3.5 text-center font-score text-[24px] font-bold tracking-[0.35em] text-text placeholder:tracking-[0.35em] placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none'

function PinField({ id, name, label, autoComplete }: { id: string; name: string; label: string; autoComplete: string }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        name={name}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        minLength={6}
        autoComplete={autoComplete}
        placeholder="••••••"
        className={FIELD}
        required
      />
    </div>
  )
}

export function PinForm({ forced }: { forced?: boolean }) {
  const [state, action, pending] = useActionState(changePin, {} as PinState)

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.error ? <Notice>{state.error}</Notice> : null}
      <PinField id="current" name="current" label="Current PIN" autoComplete="current-password" />
      <PinField id="next" name="next" label="New PIN" autoComplete="new-password" />
      <PinField id="confirm" name="confirm" label="Type it again" autoComplete="new-password" />
      <p className="text-meta text-text-2">
        Six digits. Not your birthday, not 123456 — it is the only thing between the internet and
        your scores.
      </p>
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : forced ? 'Save my PIN' : 'Change PIN'}
      </Button>
    </form>
  )
}
