'use client'

import { useActionState } from 'react'
import { changePassword, type PwState } from './actions'
import { Button, Input, Label, Notice } from '@/components/ui'

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePassword, {} as PwState)

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.error ? <Notice>{state.error}</Notice> : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="current">Current password</Label>
        <Input id="current" name="current" type="password" autoComplete="current-password" required />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="next">New password</Label>
        <Input
          id="next"
          name="next"
          type="password"
          autoComplete="new-password"
          minLength={10}
          aria-describedby="pw-hint"
          required
        />
        <p id="pw-hint" className="text-meta text-text-2">
          At least 10 characters. Three words you will remember beats eight you will not.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm">Type it again</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Change password'}
      </Button>
    </form>
  )
}
