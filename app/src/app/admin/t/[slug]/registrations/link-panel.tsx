'use client'

import { useActionState, useState } from 'react'
import { Button } from '@/components/ui'
import { makeLink, type LinkState } from './actions'

/**
 * The link is only ever shown once. Copy and Share are both here because the
 * organiser is on a phone and the destination is WhatsApp.
 *
 * Replacing a live link kills the one that is already in the group chat, so it
 * takes two taps and the second one says what it will do. Making the FIRST one
 * takes one tap, because nothing is lost by it.
 */
export function LinkPanel({ slug, hasActive }: { slug: string; hasActive: boolean }) {
  const [state, action, pending] = useActionState<LinkState, FormData>(makeLink, {})
  const [copied, setCopied] = useState(false)
  const [armed, setArmed] = useState(false)

  const full =
    state.link && typeof window !== 'undefined' ? `${window.location.origin}${state.link}` : null

  if (full) {
    return (
      <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
        <p className="text-section text-text">Here it is — copy it now</p>
        <p className="mt-1 text-meta text-text-3">
          It isn&rsquo;t stored anywhere you can read it back. If you lose it, make a new one.
        </p>
        <p className="num mt-3 rounded-control bg-sunken px-3 py-3 text-body break-all text-text">
          {full}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            type="button"
            className="flex-1 basis-[9rem]"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(full)
                setCopied(true)
              } catch {
                // Clipboard is blocked in plenty of in-app browsers. The link
                // is on screen and selectable, so this is a label, not a wall.
                setCopied(false)
              }
            }}
          >
            {copied ? 'Copied' : 'Copy link'}
          </Button>
          <a
            href={`https://wa.me/?text=${encodeURIComponent(`Sign up for this Sunday: ${full}`)}`}
            target="_blank"
            rel="noreferrer"
            className="tap-lg inline-flex flex-1 basis-[9rem] items-center justify-center rounded-control border border-line-strong bg-paper px-5 text-[18px] font-bold text-text"
          >
            Send on WhatsApp
          </a>
        </div>
      </div>
    )
  }

  return (
    <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
      <p className="text-section text-text">
        {hasActive ? 'Sign-ups are open' : 'Let players sign themselves up'}
      </p>
      <p className="mt-1 text-body text-text-2">
        {hasActive
          ? 'A link is already out there. It was shown once and cannot be read back — if you have lost it, make a new one.'
          : 'One link for the group chat. They put in their name, what they want to play, and who they’re playing with.'}
      </p>
      {state.error ? (
        <p role="alert" className="mt-3 text-body font-medium text-alert">
          {state.error}
        </p>
      ) : null}

      {hasActive && !armed ? (
        <Button type="button" variant="secondary" className="mt-3" onClick={() => setArmed(true)}>
          Make a new link
        </Button>
      ) : (
        <form action={action}>
          <input type="hidden" name="slug" value={slug} />
          {hasActive ? (
            <p className="mt-3 rounded-control bg-waiting-soft px-3.5 py-3 text-body font-medium text-waiting">
              The link already in the group chat stops working the moment this one is made. Anyone
              who has already filled it in stays on the list.
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="mt-3">
            {pending ? 'Making it…' : hasActive ? 'Yes — replace the old one' : 'Make the sign-up link'}
          </Button>
        </form>
      )}
    </div>
  )
}
