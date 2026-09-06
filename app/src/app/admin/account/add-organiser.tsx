'use client'

import { useActionState } from 'react'
import { Input, Notice } from '@/components/ui'
import { ROW_BUTTON } from '../_ui'
import { addOrganiserAction, type AddOrganiserState } from './actions'

/**
 * One line, one button. The temporary PIN is shown here, once, and only
 * here — it never travels in a URL.
 */
export function AddOrganiserForm() {
  const [state, action, pending] = useActionState<AddOrganiserState, FormData>(addOrganiserAction, {
    done: 0,
  })
  return (
    <div className="flex flex-col gap-3">
      {state.pin ? (
        <Notice tone="done" title={`${state.name} is in`}>
          Their PIN is <b className="num text-text">{state.pin}</b>. Tell them now — it is not shown
          again — and they choose their own the first time they sign in.
        </Notice>
      ) : null}
      <form key={state.done} action={action} className="flex gap-2">
        <Input
          name="name"
          placeholder="Add an organiser — their name"
          aria-label="Add an organiser"
          autoComplete="off"
          maxLength={60}
          required
          className="h-14 min-w-0 flex-1 placeholder:text-[14px]"
        />
        <button className={`${ROW_BUTTON} shrink-0`} disabled={pending}>
          {pending ? 'Adding…' : 'Add'}
        </button>
      </form>
      {state.error ? (
        <p role="alert" className="text-body font-medium text-alert">
          {state.error}
        </p>
      ) : null}
    </div>
  )
}
