'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * The games list and one game's page both update on their own.
 *
 * Polls one small value — a version — and refetches only when it moves. Same
 * shape and the same reasons as the tournament page's `LiveRefresh`: a naive
 * `router.refresh()` every few seconds re-runs every query on the page, per
 * phone, to find out that nothing changed.
 *
 * The version is compared as a string because the list's number is a composite
 * ("how many games : the sum of their counters") and one game's is a plain
 * integer. Both must come from the same function the page rendered with.
 *
 * Only while the tab is visible; coming back to the tab checks at once, because
 * that is the moment the page is most likely to be stale.
 */
export function GamesRefresh({
  endpoint,
  version,
  mode,
}: {
  endpoint: string
  version: string | number
  mode: 'live' | 'idle' | 'off'
}) {
  const router = useRouter()

  useEffect(() => {
    if (mode === 'off') return
    let stopped = false
    const interval = mode === 'live' ? 5000 : 30000
    const mine = String(version)

    async function tick() {
      if (stopped || document.visibilityState !== 'visible') return
      try {
        const res = await fetch(endpoint, { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as { v: string | number }
        if (String(data.v) !== mine) router.refresh()
      } catch {
        /* offline for a moment — try again next tick */
      }
    }

    const id = setInterval(tick, interval)
    document.addEventListener('visibilitychange', tick)
    return () => {
      stopped = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [endpoint, version, mode, router])

  return null
}
