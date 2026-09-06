'use client'

import { useActionState, useRef, useState } from 'react'
import { Card, Input } from '@/components/ui'
import { ROW_BUTTON } from '../../../_ui'
import { addByHand, type AddState } from './actions'

/**
 * The sign-up link, with the two things the organiser does with it: copy it,
 * or send it straight to WhatsApp. Copy is a client component because the
 * clipboard is; everything else on the screen is a form.
 */
export function LinkCard({ shown, full }: { shown: string; full: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'select'>('no')
  const text = useRef<HTMLParagraphElement>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(full)
      setCopied('yes')
    } catch {
      // Blocked in plenty of in-app browsers. Select the text instead, so a
      // long press does what the button could not.
      const el = text.current
      if (el) {
        const range = document.createRange()
        range.selectNodeContents(el)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      setCopied('select')
    }
  }

  return (
    <Card className="p-4">
      <p className="font-score text-eyebrow text-text-2 uppercase">Sign-up link</p>
      <p ref={text} className="num mt-1 text-body break-all text-text-2 select-all">
        {shown}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={copy} className={ROW_BUTTON}>
          {copied === 'yes' ? 'Copied' : 'Copy'}
        </button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(`Sign up here — name, phone, and who you want to play with: ${full}`)}`}
          target="_blank"
          rel="noreferrer"
          className="tap inline-flex items-center justify-center rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text"
        >
          Send on WhatsApp
        </a>
      </div>
      {copied === 'select' ? (
        <p className="mt-2 text-meta text-text-2">Copying is blocked here — the link is selected, so hold and copy.</p>
      ) : null}
    </Card>
  )
}

/**
 * One line, one button. The form is keyed on how many have gone in, so a
 * successful add gives back an empty box without any effect or reset call.
 */
export function AddPlayerForm({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState<AddState, FormData>(addByHand, { done: 0 })
  return (
    <form key={state.done} action={action} className="flex flex-col gap-2">
      <input type="hidden" name="slug" value={slug} />
      <div className="flex gap-2">
        <Input
          name="text"
          required
          autoComplete="off"
          enterKeyHint="done"
          aria-label="Add a player"
          placeholder="Add a player — name, phone optional"
          className="h-14 min-w-0 flex-1 placeholder:text-[14px]"
        />
        <button className={`${ROW_BUTTON} shrink-0`} disabled={pending}>
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {state.error ? (
        <p role="alert" className="text-body font-medium text-alert">
          {state.error}
        </p>
      ) : null}
    </form>
  )
}
