import { useEffect, useRef } from 'react'
import { version } from './rpc'

/**
 * A phone left open on a board updates on its own — the reference's
 * `live-refresh.tsx` and `admin/live/refresh.tsx`, which were the same shape
 * for the same reason.
 *
 * It polls one small opaque string and refetches the page only when it moves.
 * Naive polling of the whole payload is ~230,000 calls and ~46GB of egress in
 * a single tournament day, per the reference's own note.
 *
 * Three speeds, because the cost is per phone in the venue:
 *   live — something is on court, and a score can change any second
 *   idle — nothing on court; the next thing is a court being filled
 *   off  — everything has been played, so nothing will ever move again
 *
 * `everyTicks` refreshes regardless every N ticks: on the venue board "on for
 * 52 min" is a fact about the clock, not the database.
 *
 * Only while the tab is visible. A phone in a pocket polls nothing, and coming
 * back to the tab checks at once — that is the moment the page is most likely
 * to be stale, and waiting up to thirty seconds to find out is what makes it
 * feel dead.
 */
export function useVersionPoll(
  path: 'today' | `t/${string}` | 'venue' | null,
  current: string | null | undefined,
  mode: 'live' | 'idle' | 'off',
  onMoved: () => void,
  everyTicks = 0,
) {
  // The callback and the version change on every render of the page that owns
  // them; re-arming the interval each time would reset the five seconds and,
  // on a busy board, mean it never actually fires. So they are kept in refs
  // that the interval reads, and written in an effect rather than during
  // render — a ref written while rendering is a value React is free to throw
  // away.
  const moved = useRef(onMoved)
  // The venue board has no version in its payload, so `current` is null on the
  // first render and the first poll adopts what it finds rather than treating
  // "I did not know yet" as "it moved".
  const seen = useRef<string | null | undefined>(current)
  useEffect(() => {
    moved.current = onMoved
    if (current !== null && current !== undefined) seen.current = current
  })

  useEffect(() => {
    if (!path || mode === 'off') return
    let stopped = false
    let ticks = 0
    const interval = mode === 'live' ? 5000 : 30000

    async function tick() {
      if (stopped || document.visibilityState !== 'visible') return
      ticks += 1
      const v = await version(path!)
      if (stopped) return
      if (v === null) return
      const known = seen.current
      seen.current = v
      if (known === null || known === undefined) return
      if (v !== known || (everyTicks > 0 && ticks % everyTicks === 0)) moved.current()
    }

    const id = setInterval(tick, interval)
    document.addEventListener('visibilitychange', tick)
    return () => {
      stopped = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [path, mode, everyTicks])
}
