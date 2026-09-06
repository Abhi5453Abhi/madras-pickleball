import { clsx } from 'clsx'
import type { ReactNode } from 'react'

/**
 * Organiser-side primitives.
 *
 * These live here rather than in `src/components/ui.tsx` because they are only
 * ever used behind a login: the attention block, the two-step confirm and the
 * three link shapes every organiser screen is built from. `Confirm` is the one
 * worth promoting if the integrator wants it shared — the court page has the
 * same problem.
 */

/**
 * A destructive or surprising action, in two taps.
 *
 * Every button here fires a server action that changes the day: a walkover is
 * awarded, a live match loses its start time, a link everybody in the group
 * chat is holding stops working. One tap in the sun with a paddle in the other
 * hand is not consent, and an undo that costs a page load and a reason string
 * is not a substitute for being told first.
 *
 * `details` rather than a dialog: no JavaScript, no focus trap to get wrong,
 * and tapping the summary again is the cancel. The summary text says what the
 * button is FOR; the sentence inside says what it will DO.
 */
export function Confirm({
  label,
  question,
  children,
  className,
}: {
  label: ReactNode
  /** What will happen, in a sentence, before it happens. */
  question: ReactNode
  /** The real form, with the real submit button inside it. */
  children: ReactNode
  className?: string
}) {
  return (
    <details className={clsx('group min-w-0', className)}>
      <summary className="tap flex items-center justify-center rounded-control border border-line-strong bg-paper px-3.5 text-center text-[16px] font-semibold text-text-2">
        {label}
      </summary>
      <div className="mt-2 rounded-control border border-line-strong bg-sunken p-3.5">
        <p className="text-body text-text">{question}</p>
        <div className="mt-3">{children}</div>
        <p className="mt-2 text-meta text-text-3">Tap the button above again to leave it alone.</p>
      </div>
    </details>
  )
}

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

/**
 * How far through the day it is. A bar rather than a percentage: the organiser
 * is reading it at arm's length while walking, and "two thirds" is the whole
 * content of the number.
 */
export function Meter({ done, total }: { done: number; total: number }) {
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={`${done} of ${total} matches played`}
      className="h-2 w-full overflow-hidden rounded-full bg-sunken"
    >
      <div className="h-full rounded-full bg-ink" style={{ width: `${pct}%` }} />
    </div>
  )
}

/** The one big button on a screen. A link, not a form, so it prefetches. */
export const PRIMARY_LINK =
  'tap-lg flex w-full items-center justify-center rounded-control bg-ink px-5 text-[19px] font-bold text-white'

/** Everything else that navigates: 56px, bounded, readable at arm's length. */
export const SECONDARY_LINK =
  'tap flex items-center justify-center rounded-control border border-line-strong bg-paper px-3 text-center text-[16px] font-semibold text-text'

/** A small ink button inside a row — "Settle it", "Enter". */
export const ROW_BUTTON =
  'tap inline-flex items-center justify-center rounded-control bg-ink px-4 text-[16px] font-bold text-white'

/** The one place terracotta becomes a filled button: an idle court. */
export const ROW_BUTTON_ACCENT =
  'tap inline-flex items-center justify-center rounded-control bg-accent px-4 text-[16px] font-bold text-white shadow-key active:translate-y-px active:shadow-none'
