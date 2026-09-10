'use client'

import { useActionState, useRef, useState } from 'react'
import { Card } from '@/components/ui'
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
          aria-label="Send on WhatsApp"
          className="tap inline-flex items-center justify-center rounded-control border border-line-key bg-paper px-3.5 text-text"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden="true">
            <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm5.71 14.16c-.24.68-1.19 1.25-1.94 1.4-.5.1-1.16.19-3.38-.72-2.84-1.17-4.67-4.05-4.81-4.24-.14-.19-1.16-1.54-1.16-2.95 0-1.4.73-2.09 1-2.38.24-.26.53-.32.71-.32h.51c.16 0 .38-.03.6.46.24.55.79 1.9.86 2.04.07.14.11.31.02.5-.09.19-.14.31-.28.48-.14.16-.29.36-.41.49-.14.14-.28.29-.12.57.16.28.71 1.17 1.53 1.9 1.05.94 1.94 1.24 2.22 1.38.28.14.44.12.6-.07.16-.19.68-.79.86-1.06.18-.28.36-.23.6-.14.24.09 1.55.73 1.81.86.26.14.44.2.5.32.06.11.06.65-.18 1.33z" />
          </svg>
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
        {/* A textarea, not an input: the list from the group chat is one
            name per line, and an input would flatten it into one long name.
            It grows only when a paste brings more than one line. */}
        <textarea
          name="text"
          required
          autoComplete="off"
          enterKeyHint="done"
          aria-label="Add a player, or paste a list"
          placeholder="Add a player, or paste a list"
          rows={1}
          onInput={(e) => {
            const el = e.currentTarget
            const lines = el.value.split('\n').length
            el.rows = Math.min(8, Math.max(1, lines))
          }}
          onKeyDown={(e) => {
            // Enter adds one name; a pasted list keeps its newlines.
            if (e.key === 'Enter' && !e.shiftKey && !e.currentTarget.value.includes('\n')) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          className="tap min-w-0 flex-1 resize-none rounded-control border border-line-key bg-paper px-3.5 py-[15px] text-body leading-[26px] text-text placeholder:text-[14px] placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none"
        />
        <button className={`${ROW_BUTTON} shrink-0 self-start`} disabled={pending}>
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
