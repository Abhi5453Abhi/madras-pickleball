'use client'

import { useActionState, useState } from 'react'
import { Button } from '@/components/ui'
import { makeLink, type LinkState } from './actions'

/**
 * The link is only ever shown once. Copy and Share are both here because the
 * organiser is on a phone and the destination is WhatsApp.
 */
export function LinkPanel({ slug, hasActive }: { slug: string; hasActive: boolean }) {
  const [state, action, pending] = useActionState<LinkState, FormData>(makeLink, {})
  const [copied, setCopied] = useState(false)

  const full =
    state.link && typeof window !== 'undefined' ? `${window.location.origin}${state.link}` : null

  return (
    <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
      {full ? (
        <>
          <p className="text-section text-text">Here it is — copy it now</p>
          <p className="mt-1 text-meta text-text-3">
            It isn’t stored anywhere you can read it back. If you lose it, make a new one.
          </p>
          <p className="num mt-3 break-all rounded-control bg-sunken px-3 py-3 text-body text-text">
            {full}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(full)
                  setCopied(true)
                } catch {
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
              className="tap-lg inline-flex items-center rounded-control border border-line-strong bg-paper px-5 text-[18px] font-bold text-text"
            >
              Send on WhatsApp
            </a>
          </div>
        </>
      ) : (
        <form action={action}>
          <input type="hidden" name="slug" value={slug} />
          <p className="text-section text-text">
            {hasActive ? 'Sign-ups are open' : 'Let players sign themselves up'}
          </p>
          <p className="mt-1 text-body text-text-2">
            {hasActive
              ? 'A link is already live. Making a new one closes the old one immediately.'
              : 'One link for the group chat. They put in their name, what they want to play, and who they’re playing with.'}
          </p>
          {state.error ? (
            <p role="alert" className="mt-3 text-body font-medium text-alert">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" disabled={pending} className="mt-3">
            {pending ? 'Making it…' : hasActive ? 'Make a new link' : 'Make the sign-up link'}
          </Button>
        </form>
      )}
    </div>
  )
}
