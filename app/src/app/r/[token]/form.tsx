'use client'

import { useActionState } from 'react'
import { Button, Input, NetRule } from '@/components/ui'
import { register, type RegState } from './actions'

type Cat = { id: string; name: string; discipline: string; needsPartner: boolean }

export function RegisterForm({ token, categories }: { token: string; categories: Cat[] }) {
  const [state, action, pending] = useActionState<RegState, FormData>(register, {})

  if (state.ok) {
    return (
      <div className="rounded-card border border-line-strong bg-paper p-5 shadow-card">
        <p className="text-title text-text">
          {state.alreadyIn ? 'You’re already in.' : 'You’re in the list.'}
        </p>
        <p className="mt-2 text-body text-text-2">
          {state.alreadyIn
            ? 'The organiser has already added you to the draw.'
            : 'The organiser checks the list before the draw. If you named a partner, ask them to sign up too — a pair only counts when you’ve both put each other down.'}
        </p>
      </div>
    )
  }

  const doublesCats = categories.filter((c) => c.needsPartner)

  return (
    <form action={action} className="flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />

      {state.error ? (
        <p role="alert" className="rounded-control bg-alert-soft px-3.5 py-3 text-body font-medium text-alert">
          {state.error}
        </p>
      ) : null}

      <label className="block">
        <span className="text-section text-text">Your name</span>
        <Input name="name" required autoComplete="name" className="mt-2 h-14" placeholder="Ravi Kumar" />
      </label>

      <label className="block">
        <span className="text-section text-text">Phone</span>
        <span className="mt-0.5 block text-meta text-text-3">
          Optional. Only the organiser sees it — it never goes on the public page.
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

      <NetRule />

      <fieldset>
        <legend className="text-section text-text">What do you want to play?</legend>
        <div className="mt-3 flex flex-col gap-2">
          {categories.map((c) => (
            <label
              key={c.id}
              className="tap-lg flex items-center gap-3 rounded-control border border-line-strong bg-paper px-4"
            >
              <input
                type="checkbox"
                name="categoryIds"
                value={c.id}
                className="size-6 accent-[var(--color-ink)]"
              />
              <span className="text-row text-text">{c.name}</span>
            </label>
          ))}
          {categories.length === 0 ? (
            <p className="text-body text-text-2">
              The organiser hasn’t opened any categories yet. Try again shortly.
            </p>
          ) : null}
        </div>
      </fieldset>

      {doublesCats.length ? (
        <label className="block">
          <span className="text-section text-text">Playing with someone?</span>
          <span className="mt-0.5 block text-meta text-text-3">
            Put their name in and ask them to put yours. If you leave this blank the organiser
            will pair you with someone.
          </span>
          <Input name="partnerName" className="mt-2 h-14" placeholder="Priya S" />
        </label>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Sending…' : 'Sign me up'}
      </Button>
    </form>
  )
}
