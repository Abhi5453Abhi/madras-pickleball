'use client'

import { useState } from 'react'

/**
 * "Share" on a phone opens the share sheet — WhatsApp is the first thing on
 * it, which is where every tournament here lives. On a laptop, where there
 * is no sheet, it copies the link and says so. Either way the link is the
 * public page: read-only, no sign-in.
 */
export function ShareButton({ path, title }: { path: string; title: string }) {
  const [said, setSaid] = useState<string | null>(null)

  async function share() {
    const url = `${window.location.origin}${path}`
    try {
      if (navigator.share) {
        await navigator.share({ title, text: `${title} — live scores and results`, url })
        return
      }
      await navigator.clipboard.writeText(url)
      setSaid('Link copied')
      setTimeout(() => setSaid(null), 2000)
    } catch {
      // Cancelled the sheet, or no clipboard: the link itself still works.
      window.open(url, '_blank', 'noopener')
    }
  }

  return (
    <button
      type="button"
      onClick={share}
      className="tap -mr-1 inline-flex shrink-0 items-center gap-1 px-2 text-[16px] font-bold text-link"
    >
      {said ?? 'Share'} {said ? null : <span aria-hidden>↗</span>}
    </button>
  )
}
