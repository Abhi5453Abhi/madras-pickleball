'use client'

import { useState } from 'react'
import { normalizePhone } from '@/lib/parse-players'

/**
 * The public link for a game, and the message that goes with it.
 *
 * Built from `window.location.origin` rather than an environment variable,
 * because the host opens this on a phone at the venue and whatever host name
 * they reached the app by is the one the link has to work from.
 */
export function GameLink({ path, share }: { path: string; share: string }) {
  const [copied, setCopied] = useState(false)
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const url = `${origin}${path}`
  const message = `${share} ${url}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
    } catch {
      // Blocked in some in-app browsers. The box below still shows the link to
      // copy by hand, which is what people do anyway.
    }
  }

  return (
    <div className="flex flex-col gap-2.5">
      <p className="num overflow-x-auto rounded-control border border-line bg-sunken px-3 py-2.5 text-meta whitespace-nowrap text-text-2">
        {url || path}
      </p>
      <div className="flex flex-wrap gap-2">
        <a
          href={`https://wa.me/?text=${encodeURIComponent(message)}`}
          target="_blank"
          rel="noreferrer"
          className="tap inline-flex flex-1 items-center justify-center rounded-control bg-ink px-4 text-[16px] font-bold text-white"
        >
          Send to the group
        </a>
        <button
          type="button"
          onClick={copy}
          className="tap inline-flex items-center justify-center rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}

/**
 * One person, one message. `phone` opens a direct chat where we have a number
 * and the group picker where we do not — the host is the delivery channel in
 * stage 1, so this is the confirmation gate's actual send button.
 */
export function Nudge({
  phone,
  text,
  path,
  label,
}: {
  phone: string | null
  text: string
  path: string
  label: string
}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : ''
  const message = `${text} ${origin}${path}`
  // The normalised number, not the raw string somebody typed: a phone that
  // never normalised is not one WhatsApp can open a chat with, and guessing at
  // its digits addresses the message to nobody in particular.
  const e164 = normalizePhone(phone)
  const href = e164
    ? `https://wa.me/${e164.replace(/\D/g, '')}?text=${encodeURIComponent(message)}`
    : `https://wa.me/?text=${encodeURIComponent(message)}`
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="tap inline-flex w-full items-center justify-center rounded-control bg-ink px-4 text-[16px] font-bold text-white sm:w-auto"
    >
      {label}
    </a>
  )
}
