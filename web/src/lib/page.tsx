import { useEffect, useLayoutEffect } from 'react'
import { markPending } from '@/api/use-rpc'
import { NetRule, Notice, Wordmark } from '@/components/ui'

/**
 * The bits every ported screen needs and Next used to hand out for free: the
 * `metadata` title, `loading.tsx`, `error.tsx` and `not-found.tsx`.
 */

/** The reference's per-page `metadata.title`. */
export function useTitle(title: string) {
  useEffect(() => {
    document.title = title
  }, [title])
}

/**
 * The first 2.6 seconds — the reference's `loading.tsx`, shrunk to something a
 * page can render inside its own layout while its RPC is in the air. On venue
 * 3G a blank screen reads as "the link is broken"; this says the wait is
 * normal and shows the shape of what is coming.
 */
export function Loading({ lines = 3 }: { lines?: number }) {
  // A placeholder on screen counts as a load in flight (see markPending),
  // and it is counted before paint so nothing can read the page between
  // one screen's data arriving and the next screen's request leaving.
  useLayoutEffect(() => {
    markPending(1)
    return () => markPending(-1)
  }, [])
  return (
    <div className="flex flex-col gap-4">
      <p role="status" className="text-body text-text-2">
        Loading. On venue Wi-Fi this takes a moment.
      </p>
      <div aria-hidden className="flex animate-pulse flex-col gap-3">
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className="h-28 rounded-card border border-line-strong bg-paper shadow-card" />
        ))}
      </div>
    </div>
  )
}

/** The public shell's version of the same thing, ink band and all. */
export function PublicLoading() {
  useLayoutEffect(() => {
    markPending(1)
    return () => markPending(-1)
  }, [])
  return (
    <div className="min-h-dvh bg-ground">
      <header className="masthead relative overflow-hidden bg-ink px-4 pt-6 pb-6 text-white">
        <div className="mx-auto w-full max-w-5xl xl:max-w-6xl">
          <Wordmark />
          <div aria-hidden className="animate-pulse">
            <div className="mt-3 h-8 w-4/5 max-w-md rounded-control bg-white/15" />
            <div className="mt-2.5 h-4 w-3/5 max-w-xs rounded-control bg-white/10" />
          </div>
        </div>
        <NetRule className="absolute inset-x-0 bottom-0" />
      </header>
      <div className="mx-auto w-full max-w-5xl px-4 pt-6 xl:max-w-6xl">
        <Loading />
      </div>
    </div>
  )
}

/**
 * What replaces the screen when a load fails — the reference's `error.tsx`,
 * minus Next's hex digest. What happened, what it probably is, and the way
 * back.
 */
export function LoadError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <Notice
      tone="alert"
      title="This page didn’t load"
      detail="It is usually the connection rather than the day. Nothing at the venue has changed because of this, and no score has been lost."
      action={
        <button
          type="button"
          onClick={retry}
          className="tap-lg w-full rounded-control bg-ink px-5 text-[18px] font-bold text-white"
        >
          Try again
        </button>
      }
    >
      {error}
    </Notice>
  )
}

/**
 * A link that leads nowhere: last month's tournament forwarded through the
 * group chat one Sunday too late, or a character that fell off the end.
 */
export function NotFoundCard({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-title text-text">There’s nothing at this link</h1>
      <p className="text-body text-text-2">
        {children ??
          'It is probably an older tournament that has since been taken down, or a link that lost a character being passed on.'}
      </p>
    </div>
  )
}
