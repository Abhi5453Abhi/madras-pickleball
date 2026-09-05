'use client'

import { useActionState } from 'react'
import { changePassword, type PwState } from './actions'
import { Button, Input, Label, Notice } from '@/components/ui'

export function PasswordForm() {
  const [state, action, pending] = useActionState(changePassword, {} as PwState)

  return (
    <form action={action} className="flex flex-col gap-4">
      {state.error ? <Notice>{state.error}</Notice> : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="current">Current password</Label>
        <Input id="current" name="current" type="password" autoComplete="current-password" required />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="next">New password</Label>
        <Input id="next" name="next" type="password" autoComplete="new-password" required />
        <p className="text-xs text-muted">At least 10 characters.</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="confirm">Repeat new password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : 'Change password'}
      </Button>
    </form>
  )
}
