'use client'

import { useActionState } from 'react'
import { login, type LoginState } from './actions'
import { Button, Label } from '@/components/ui'

const initial: LoginState = {}

/**
 * One field. Six digits, numeric keyboard, big and centred so it can be typed
 * with a thumb while holding a clipboard. The field is a password field so
 * the digits are dots on a phone that other people are looking at.
 */
export function LoginForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState(login, initial)

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="pin">PIN</Label>
        <input
          id="pin"
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          minLength={6}
          enterKeyHint="go"
          autoFocus
          required
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? 'pin-error' : undefined}
          className={[
            'tap-lg w-full rounded-control border bg-paper px-3.5 text-center font-score text-[28px] font-bold tracking-[0.4em] text-text',
            'placeholder:tracking-[0.4em] placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none',
            state.error ? 'border-alert' : 'border-line-key',
          ].join(' ')}
          placeholder="••••••"
        />
      </div>
      {state.error ? (
        <p id="pin-error" role="alert" className="text-row text-alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Sign in'}
      </Button>
    </form>
  )
}
