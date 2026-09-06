'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

/**
 * Polls one integer — `tournaments.stream_version` — and only refetches the
 * page when it moves. Naive 5s polling of the whole payload is ~230,000
 * function calls and ~46GB of egress in a single tournament day (SPEC A9).
 *
 * Only while the tab is visible, and slowly when nothing is live.
 */
export function LiveRefresh({
  slug,
  version,
  active,
}: {
  slug: string
  version: number
  active: boolean
}) {
  const router = useRouter()

  useEffect(() => {
    let stopped = false
    const interval = active ? 5000 : 30000

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
    document.addEventListener('visibilitychange', tick)
    return () => {
      stopped = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [slug, version, active, router])

  return null
}
