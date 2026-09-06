import { clsx } from 'clsx'
import type { ReactNode } from 'react'

/**
 * Organiser-side primitives.
 *
 * What is left here is what only exists behind a login: the attention block,
 * and the link shapes every organiser screen is built from. `Confirm` and
 * `Meter` used to live here and now come from `@/components/ui` — the court
 * screen had the same two problems.
 */

type AttentionTone = 'alert' | 'accent' | 'waiting'

const ATTN: Record<AttentionTone, { edge: string; word: string }> = {
  alert: { edge: 'bg-alert', word: 'text-alert' },
  accent: { edge: 'bg-accent-line', word: 'text-accent-hi' },
  waiting: { edge: 'bg-waiting', word: 'text-waiting' },
}

/**
 * One thing that needs the organiser, with the button that deals with it on the
 * same row. Never colour alone: the tone is carried by a word as well as by the
 * left edge.
 */
export function AttentionRow({
  tone,
  what,
  where,
  action,
}: {
  tone: AttentionTone
  /** What has happened, in the words you would say out loud. */
  what: ReactNode
  /** Which court, which pair, how long — the part that makes it actionable. */
  where?: ReactNode
  action: ReactNode
}) {
  const t = ATTN[tone]
  return (
    // Stacked on a phone, side by side from `sm`. Squeezing "Hari Venkatesh /
    // Arun Prakash v Ganesh Iyer / Bala Murugan" into the 160px left over
    // beside a button turned one line into seven — the names are the reason
    // the row is actionable, so they get the width and the button goes under.
    <li className="relative flex flex-col gap-2.5 bg-paper px-4 py-3.5 pl-5 sm:flex-row sm:items-center sm:gap-3">
      <span aria-hidden className={clsx('absolute inset-y-2 left-0 w-[4px] rounded-r-full', t.edge)} />
      <div className="min-w-0 sm:flex-1">
        <p className={clsx('text-row', t.word)}>{what}</p>
        {where ? <p className="mt-0.5 text-meta text-text-2">{where}</p> : null}
      </div>
      <div className="w-full sm:ml-auto sm:w-auto sm:shrink-0">{action}</div>
    </li>
  )
}

export function Attention({ children, count }: { children: ReactNode; count: number }) {
  if (count === 0) return null
  return (
    <section aria-labelledby="needs-you" className="flex flex-col gap-3">
      <div>
        <h2 id="needs-you" className="text-section text-text">
          Needs you now
        </h2>
        <div aria-hidden className="mt-1.5 h-[3px] w-10 rounded-full bg-accent-line" />
      </div>
      <div className="-mx-4 overflow-hidden border-y border-line-strong shadow-card sm:mx-0 sm:rounded-card sm:border">
        <ul className="divide-y divide-line">{children}</ul>
      </div>
    </section>
  )
}

/** The one big button on a screen. A link, not a form, so it prefetches. */
export const PRIMARY_LINK =
  'tap-lg flex w-full items-center justify-center rounded-control bg-ink px-5 text-[19px] font-bold text-white'

/**
 * Everything else that navigates: 56px, bounded, readable at arm's length.
 * line-key, not line-strong — an outlined control has no fill, so its border is
 * the only thing saying where to press.
 */
export const SECONDARY_LINK =
  'tap flex items-center justify-center rounded-control border border-line-key bg-paper px-3 text-center text-[16px] font-semibold text-text'

/** A small ink button inside a row — "Settle it", "Enter". */
export const ROW_BUTTON =
  'tap inline-flex items-center justify-center rounded-control bg-ink px-4 text-[16px] font-bold text-white'

/** The one place terracotta becomes a filled button: an idle court. */
export const ROW_BUTTON_ACCENT =
  'tap inline-flex items-center justify-center rounded-control bg-accent px-4 text-[16px] font-bold text-white shadow-key active:translate-y-px active:shadow-none'
