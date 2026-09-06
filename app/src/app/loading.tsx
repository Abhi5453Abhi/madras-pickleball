import { NetRule, Wordmark } from '@/components/ui'

/**
 * The first 2.6 seconds.
 *
 * On venue 3G the public page was a blank white screen for that long with
 * nothing to say it was working — which on a phone, outdoors, reads as "the
 * link is broken" and gets someone to close the tab and ask at the desk.
 *
 * So this is not a spinner. It is the shape of the page that is coming: the
 * ink band lands immediately with the venue's name on it, and three card
 * outlines say where the courts will be. Two things follow from that. It has
 * to be tiny — it ships in the same first bytes it is meant to fill — and it
 * has to be honest about the fact that the wait is normal here.
 *
 * `animate-pulse` needs no guard: the reduced-motion block in globals.css
 * flattens every animation on the site to 0.01ms, so a viewer who has asked
 * for stillness gets a still skeleton.
 */
export default function Loading() {
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
        <p role="status" className="text-body text-text-2">
          Loading. On venue Wi-Fi this takes a moment.
        </p>
        <div aria-hidden className="mt-4 flex animate-pulse flex-col gap-3">
          <div className="h-28 rounded-card border border-line-strong bg-paper shadow-card" />
          <div className="h-28 rounded-card border border-line-strong bg-paper shadow-card" />
          <div className="h-28 rounded-card border border-line-strong bg-paper shadow-card" />
        </div>
      </div>
    </div>
  )
}
