'use client'

import { useState } from 'react'

/**
 * Pass the game on. Not a bare link — the text carries the time, the courts,
 * the price and how many are in, because that is what makes somebody in the
 * group chat decide to come.
 */
export function ShareGame({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const url = typeof window !== 'undefined' ? window.location.href : ''
  const message = `${text} ${url}`

  async function copy() {
    try {
      await navigator.clipboard.writeText(message)
      setCopied(true)
    } catch {
      // Clipboard is blocked in some in-app browsers. The link is in the
      // address bar; there is nothing useful to say about it.
    }
  }

  return (
    <div className="flex flex-wrap gap-2">
      <a
        href={`https://wa.me/?text=${encodeURIComponent(message)}`}
        target="_blank"
        rel="noreferrer"
        className="tap inline-flex flex-1 items-center justify-center gap-2 rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text"
      >
        <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
          <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm5.71 14.16c-.24.68-1.19 1.25-1.94 1.4-.5.1-1.16.19-3.38-.72-2.84-1.17-4.67-4.05-4.81-4.24-.14-.19-1.16-1.54-1.16-2.95 0-1.4.73-2.09 1-2.38.24-.26.53-.32.71-.32h.51c.16 0 .38-.03.6.46.24.55.79 1.9.86 2.04.07.14.11.31.02.5-.09.19-.14.31-.28.48-.14.16-.29.36-.41.49-.14.14-.28.29-.12.57.16.28.71 1.17 1.53 1.9 1.05.94 1.94 1.24 2.22 1.38.28.14.44.12.6-.07.16-.19.68-.79.86-1.06.18-.28.36-.23.6-.14.24.09 1.55.73 1.81.86.26.14.44.2.5.32.06.11.06.65-.18 1.33z" />
        </svg>
        Share on WhatsApp
      </a>
      <button
        type="button"
        onClick={copy}
        className="tap inline-flex items-center justify-center rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
