'use client'

import { useActionState } from 'react'
import { Button, Input } from '@/components/ui'
import { signUp, type SignupState } from './actions'

/**
 * A stable id for this browser, read at the moment of sending rather than on
 * mount, so there is no effect and nothing to hydrate. Best effort by design:
 * a private window or cleared storage simply means the organiser sorts it out,
 * which they were always going to have to do.
 */
function deviceId(): string {
  const KEY = 'mpb.device'
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) return saved
    const made = crypto.randomUUID().replace(/-/g, '')
    localStorage.setItem(KEY, made)
    return made
  } catch {
    return ''
  }
}

export function SignupForm({ token, doubles }: { token: string; doubles: boolean }) {
  const [state, action, pending] = useActionState<SignupState, FormData>(signUp, {})

  if (state.ok) {
    return (
      <div className="rounded-card border border-line-key bg-paper p-4 shadow-card">
        <p className="text-section text-text">
          {state.alreadyIn ? 'You’re already on the list.' : 'You’re on the list.'}
        </p>
        <p className="mt-1 text-body text-text-2">
          {doubles
            ? 'The organiser sorts the pairs before the day. Ask your partner to sign up too and put your name down.'
            : 'The organiser makes the schedule before the day.'}
        </p>
      </div>
    )
  }

  return (
    <form
      action={(formData) => {
        formData.set('deviceId', deviceId())
        action(formData)
      }}
      className="flex flex-col gap-5"
    >
      <input type="hidden" name="token" value={token} />

      {state.error ? (
        <p role="alert" className="rounded-control bg-alert-soft px-3.5 py-3 text-body font-medium text-alert">
          {state.error}
        </p>
      ) : null}

      <label className="block">
        <span className="text-row text-text">Your name</span>
        <Input name="name" required autoComplete="name" className="mt-2 h-14" placeholder="Deepak Raj" />
      </label>

      <label className="block">
        <span className="text-row text-text">
          Phone <span className="font-normal text-text-3">· optional</span>
        </span>
        <Input
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          className="mt-2 h-14"
          placeholder="98400 12345"
        />
      </label>

      {doubles ? (
        <label className="block">
          <span className="text-row text-text">Playing with someone?</span>
          <Input name="partnerName" autoComplete="off" className="mt-2 h-14" placeholder="Their name" />
          <span className="mt-1.5 block text-meta text-text-3">
            If you leave this blank the organiser pairs you up.
          </span>
        </label>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Sending…' : 'Sign me up'}
      </Button>
    </form>
  )
}
