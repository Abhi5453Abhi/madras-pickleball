'use client'

import { useSyncExternalStore } from 'react'

/**
 * "On for 12 min", not "Started 19:31".
 *
 * A spectator wants the length of the match, not a clock reading they have to
 * subtract from — and the number has to keep moving, because the page only
 * re-renders when the tournament's stream version changes and a match in
 * progress may not move that for half an hour.
 *
 * One timer for every card on the page, not one per card, and it is torn down
 * when the last card unsubscribes. `useSyncExternalStore` rather than state
 * written by an effect: the server's clock is the hydration snapshot and the
 * browser's clock takes over afterwards, which is the honest order — the
 * viewer's watch is the one they are comparing against.
 */

const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | null = null
// Zero on the server, so `serverSnapshot` and the hydration render agree; a
// real reading in the browser, so the first post-hydration render is already
// the viewer's own clock rather than one tick behind it.
let clientNow = typeof window === 'undefined' ? 0 : Date.now()

function subscribe(onChange: () => void) {
  listeners.add(onChange)
  if (!timer) {
    clientNow = Date.now()
    // Thirty seconds: the number only changes once a minute, and a tighter
    // interval is forty phones waking up for nothing.
    timer = setInterval(() => {
      clientNow = Date.now()
      for (const l of listeners) l()
    }, 30_000)
  }
  return () => {
    listeners.delete(onChange)
    if (listeners.size === 0 && timer) {
      clearInterval(timer)
      timer = null
    }
  }
}

const snapshot = () => clientNow
const serverSnapshot = () => 0

export function Elapsed({
  startedAt,
  serverMinutes,
}: {
  /** Epoch milliseconds — a Date does not survive the client boundary as one. */
  startedAt: number
  /** Computed on the server, used until the browser's own clock is available. */
  serverMinutes: number
}) {
  const now = useSyncExternalStore(subscribe, snapshot, serverSnapshot)
  const minutes = now ? Math.max(0, Math.round((now - startedAt) / 60_000)) : serverMinutes
  return <>{minutes < 1 ? 'Just gone on' : `On for ${minutes} min`}</>
}
