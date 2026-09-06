import { clsx } from 'clsx'
import type { ComponentProps, ReactNode } from 'react'

/**
 * The rule that keeps this from becoming a stack of identical white boxes:
 *
 *   A CARD is a bounded, self-contained object — one tournament, one court, one
 *   match in focus. It may be a link target.
 *
 *   A SECTION is an editorial grouping — "Mixed Doubles", "Round 1". It gets a
 *   heading and a terracotta tick, and its rows sit on ONE full-bleed panel.
 *
 * Never nest a card in a card. When you reach for one, you want a SectionHead
 * and a Panel of rows.
 */

export function Card({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={clsx(
        'rounded-card border border-line-strong bg-paper shadow-card',
        className,
      )}
      {...rest}
    />
  )
}

/**
 * A list container. Full-bleed at phone width, because 32px of side chrome is
 * 32px stolen from someone's name; boxed from `sm` up.
 */
export function Panel({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      className={clsx(
        '-mx-4 overflow-hidden border-y border-line-strong bg-paper shadow-card',
        'sm:mx-0 sm:rounded-card sm:border',
        className,
      )}
      {...rest}
    />
  )
}

export function SectionHead({
  title,
  meta,
  action,
}: {
  title: string
  meta?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex items-end justify-between gap-3">
      <div>
        <h2 className="text-section text-text">{title}</h2>
        <div aria-hidden className="mt-1.5 h-[3px] w-10 rounded-full bg-accent-line" />
        {meta ? <p className="mt-1.5 text-meta text-text-3">{meta}</p> : null}
      </div>
      {action}
    </div>
  )
}

export function Label({ className, ...rest }: ComponentProps<'label'>) {
  return <label className={clsx('block text-row text-text', className)} {...rest} />
}

export function Input({ className, ...rest }: ComponentProps<'input'>) {
  return (
    <input
      className={clsx(
        'tap w-full rounded-control border border-line-strong bg-paper px-3.5 text-body text-text',
        'placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none',
        className,
      )}
      {...rest}
    />
  )
}

type ButtonProps = ComponentProps<'button'> & {
  /** `accent` is reserved for an idle court's call to action — see the court board. */
  variant?: 'primary' | 'secondary' | 'accent' | 'quiet'
}

export function Button({ className, variant = 'primary', ...rest }: ButtonProps) {
  return (
    <button
      className={clsx(
        'tap-lg inline-flex items-center justify-center gap-2 rounded-control px-5 text-[18px] font-bold',
        'transition-colors duration-100 active:translate-y-px',
        'disabled:cursor-not-allowed disabled:opacity-60 disabled:active:translate-y-0',
        variant === 'primary' && 'bg-ink text-white hover:bg-ink-2 active:shadow-none',
        variant === 'secondary' && 'border border-line-strong bg-paper text-text hover:bg-ground',
        variant === 'accent' && 'bg-accent text-white shadow-key hover:bg-accent-hi active:shadow-none',
        variant === 'quiet' && 'text-link hover:text-text',
        className,
      )}
      {...rest}
    />
  )
}

export function Notice({
  tone = 'alert',
  children,
}: {
  tone?: 'alert' | 'info' | 'waiting'
  children: ReactNode
}) {
  return (
    <p
      role="alert"
      className={clsx(
        'rounded-control px-3.5 py-3 text-body font-medium',
        tone === 'alert' && 'bg-alert-soft text-alert',
        tone === 'info' && 'bg-accent-soft text-accent-hi',
        tone === 'waiting' && 'bg-waiting-soft text-waiting',
      )}
    >
      {children}
    </p>
  )
}

export type Status = 'live' | 'waiting' | 'done' | 'ready' | 'alert'

const PILL: Record<Status, string> = {
  live: 'bg-live-soft text-live-text',
  waiting: 'bg-waiting-soft text-waiting',
  done: 'bg-done-soft text-text-2',
  ready: 'bg-ink text-white',
  alert: 'bg-alert-soft text-alert',
}

/** Never colour alone: a status is always a colour and a word. */
export function StatusPill({ state, children }: { state: Status; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'font-score inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1',
        'text-eyebrow uppercase',
        PILL[state],
      )}
    >
      {state === 'live' ? <span aria-hidden className="size-2 rounded-full bg-live" /> : null}
      {children}
    </span>
  )
}

const SPINE: Record<Status, string> = {
  live: 'bg-live',
  waiting: 'bg-waiting',
  done: 'bg-line-strong',
  ready: 'bg-ink',
  alert: 'bg-alert',
}

/** 3px × the row height. Same information as a 10px dot, fifteen times the area. */
export function StatusSpine({ state }: { state: Status }) {
  return (
    <span
      aria-hidden
      className={clsx('absolute inset-y-3 left-0 w-[3px] rounded-r-full', SPINE[state])}
    />
  )
}

export const COURT_COLORS: Record<string, string> = {
  blue: 'bg-court-blue',
  orange: 'bg-court-orange',
  teal: 'bg-court-teal',
  violet: 'bg-court-violet',
  clay: 'bg-court-clay',
  indigo: 'bg-court-indigo',
}

/**
 * Every representation of a court carries its colour, so checking a phone
 * against the card on the net post stops requiring reading.
 */
export function CourtSwatch({ colorKey }: { colorKey: string }) {
  return (
    <span aria-hidden className={clsx('size-2.5 shrink-0 rounded-[3px]', COURT_COLORS[colorKey] ?? 'bg-court-blue')} />
  )
}

/**
 * A pickleball court from above: a rectangle, two kitchen lines, and the net.
 * Two hundred bytes, no asset, and nobody else uses it.
 */
export function CourtMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="none">
      <rect
        x="2.5"
        y="4.5"
        width="19"
        height="15"
        rx="2.5"
        stroke="currentColor"
        strokeWidth="1.75"
      />
      <path d="M9 4.5v15M15 4.5v15" stroke="currentColor" strokeWidth="1.25" opacity=".5" />
      <path d="M12 3.4v17.2" stroke="var(--color-accent-line)" strokeWidth="2" />
    </svg>
  )
}

export function NetRule({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('net-rule', className)} />
}

/** Plain English on screen, never a raw enum (SPEC D4). */
export function statusWords(status: string): { label: string; state: Status } {
  switch (status) {
    case 'live':
      return { label: 'Live', state: 'live' }
    case 'completed':
      return { label: 'Finished', state: 'done' }
    case 'archived':
      return { label: 'Archived', state: 'done' }
    case 'registration':
      return { label: 'Taking entries', state: 'waiting' }
    case 'draft':
      return { label: 'Not started', state: 'waiting' }
    case 'ready':
      return { label: 'Ready', state: 'ready' }
    default:
      return { label: 'Waiting', state: 'waiting' }
  }
}

/**
 * A team is two people, and at this venue their names are long: "Karthik
 * Subramanian / Sathish Kumar" is 35 characters and wraps mid-name at 390px,
 * which reads as one mangled string rather than as two players. Stacking the
 * two names is the same information, one fewer act of decoding, and it makes
 * the row height predictable instead of dependent on whose name it is.
 */
export function splitTeam(name: string | null | undefined): string[] {
  if (!name) return []
  return name
    .split(/\s+\/\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function TeamName({
  name,
  players,
  className,
  muted,
  size = 'row',
}: {
  name: string | null
  /** Preferred when the caller has them — the team name is only a join of these. */
  players?: string[]
  className?: string
  muted?: boolean
  /** `section` for the live court cards, which are read from further away. */
  size?: 'row' | 'section'
}) {
  const parts = players?.length ? players : splitTeam(name)
  if (!parts.length)
    return <span className={clsx('text-row text-text-3', className)}>To be decided</span>
  return (
    <span className={clsx('block', className)}>
      {parts.map((p, i) => (
        <span
          key={`${p}-${i}`}
          className={clsx(
            'block break-words',
            size === 'section' ? 'text-section' : 'text-row',
            muted ? 'text-text-3' : 'text-text',
          )}
        >
          {p}
        </span>
      ))}
    </span>
  )
}

type TagTone = 'neutral' | 'waiting' | 'alert' | 'accent' | 'live'

const TAG: Record<TagTone, string> = {
  neutral: 'border-line-strong bg-sunken text-text-2',
  waiting: 'border-waiting/35 bg-waiting-soft text-waiting',
  alert: 'border-alert/35 bg-alert-soft text-alert',
  // accent-hi, not accent: terracotta on its own soft tint is 4.1:1, and a
  // 14px tag is not large text.
  accent: 'border-accent/35 bg-accent-soft text-accent-hi',
  live: 'border-live/35 bg-live-soft text-live-text',
}

/**
 * A row-level note — "Not confirmed yet", "Under review", "Through". Smaller
 * than a StatusPill and it wraps with the text it belongs to, which a pill
 * pinned to the right edge cannot do next to a name that already wraps.
 *
 * 14px is the floor: the accent is never allowed below it.
 */
export function Tag({ tone = 'neutral', children }: { tone?: TagTone; children: ReactNode }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-meta font-semibold',
        TAG[tone],
      )}
    >
      {children}
    </span>
  )
}

function Chevron() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className="chev size-5 shrink-0" fill="none">
      <path d="M5 8l5 5 5-5" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

/**
 * "Show the rest" that costs nothing when it is closed and needs no JavaScript
 * to open. The content stays in the document, so find-in-page and a screen
 * reader's own search still reach it.
 */
export function Disclosure({
  summary,
  meta,
  children,
  className,
  id,
}: {
  summary: string
  meta?: string
  children: ReactNode
  className?: string
  id?: string
}) {
  return (
    <details id={id} className={clsx('group', className)}>
      <summary className="tap flex items-center gap-3 rounded-control border border-line-strong bg-paper px-4 text-left shadow-card">
        <span className="min-w-0 flex-1">
          <span className="block text-row text-text">{summary}</span>
          {meta ? <span className="block text-meta text-text-3">{meta}</span> : null}
        </span>
        <span aria-hidden className="text-text-2">
          <Chevron />
        </span>
      </summary>
      <div className="pt-3">{children}</div>
    </details>
  )
}

/**
 * Most visits to this page happen before the first match and after the last
 * one, so an empty state is the main state, not an afterthought.
 */
export function EmptyState({
  title,
  children,
  tone = 'quiet',
}: {
  title: string
  children?: ReactNode
  tone?: 'quiet' | 'accent'
}) {
  return (
    <div
      className={clsx(
        'rounded-card border px-4 py-5',
        tone === 'accent'
          ? 'border-accent/30 bg-accent-soft'
          : 'hatched border-line-strong bg-paper',
      )}
    >
      <p className="text-section text-text">{title}</p>
      {children ? <div className="mt-1.5 text-body text-text-2">{children}</div> : null}
    </div>
  )
}
