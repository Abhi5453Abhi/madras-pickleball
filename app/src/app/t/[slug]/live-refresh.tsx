'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Polls one integer — `tournaments.stream_version` — and only refetches the
 * page when it moves. Naive 5s polling of the whole payload is ~230,000
 * function calls and ~46GB of egress in a single tournament day (SPEC A9).
 *
 * Three speeds, because the cost is per phone in the venue:
 *   live — something is on court, and a score can change any second
 *   idle — nothing on court; the next thing to happen is a court being filled
 *   off  — every match has been played, so nothing will ever move again
 *
 * Only while the tab is visible. A phone in a pocket polls nothing.
 */
export function LiveRefresh({
  slug,
  version,
  mode,
}: {
  slug: string
  version: number
  mode: 'live' | 'idle' | 'off'
}) {
  const router = useRouter()

  useEffect(() => {
    if (mode === 'off') return
    let stopped = false
    const interval = mode === 'live' ? 5000 : 30000

    async function tick() {
      if (stopped || document.visibilityState !== 'visible') return
      try {
        const res = await fetch(`/api/public/t/${slug}/version`, { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as { v: number }
        if (data.v !== version) router.refresh()
      } catch {
        /* offline for a moment — try again next tick */
      }
    }

    const id = setInterval(tick, interval)
    // Coming back to the tab is the moment the page is most likely to be stale,
    // and waiting up to 30s to find that out is what makes it feel dead.
    document.addEventListener('visibilitychange', tick)
    return () => {
      stopped = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [slug, version, mode, router])

  return null
}
