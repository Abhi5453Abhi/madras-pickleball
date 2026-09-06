'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * A phone left open on the board updates on its own.
 *
 * Polls one small string — the sum of today's tournaments' stream versions —
 * every five seconds and refetches the page only when it moves. The same
 * shape as the public page's refresh, for the same reason: a naive
 * `router.refresh()` every few seconds re-runs a dozen queries per phone to
 * find out nothing changed. Once a minute it refreshes regardless, because
 * "on for 52 min" is a fact about the clock, not the database.
 *
 * Only while the tab is visible; coming back to the tab checks at once.
 */
export function BoardRefresh({ version }: { version: string }) {
  const router = useRouter()

  useEffect(() => {
    let stopped = false
    let ticks = 0

    async function tick() {
      if (stopped || document.visibilityState !== 'visible') return
      ticks += 1
      try {
        const res = await fetch('/admin/live/version', { cache: 'no-store' })
        if (!res.ok) return
        const data = (await res.json()) as { v: string }
        if (data.v !== version || ticks % 12 === 0) router.refresh()
      } catch {
        /* offline for a moment — try again next tick */
      }
    }

    const id = setInterval(tick, 5000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      stopped = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [version, router])

  return null
}
