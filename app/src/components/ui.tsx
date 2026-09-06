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
        // line-key, not line-strong: an empty text field is a target whose
        // border is the only thing saying where it is.
        'tap w-full rounded-control border border-line-key bg-paper px-3.5 text-body text-text',
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
        // line-key: an outlined button has no fill, so the border IS the target.
        variant === 'secondary' && 'border border-line-key bg-paper text-text hover:bg-ground',
        variant === 'accent' && 'bg-accent text-white shadow-key hover:bg-accent-hi active:shadow-none',
        variant === 'quiet' && 'text-link hover:text-text',
        className,
      )}
      {...rest}
    />
  )
}

type NoticeTone = 'alert' | 'info' | 'waiting'

const NOTICE_FLAT: Record<NoticeTone, string> = {
  alert: 'bg-alert-soft text-alert',
  info: 'bg-accent-soft text-accent-hi',
  waiting: 'bg-waiting-soft text-waiting',
}

const NOTICE_BLOCK: Record<NoticeTone, { edge: string; word: string }> = {
  alert: { edge: 'border-alert/40 bg-alert-soft', word: 'text-alert' },
  info: { edge: 'border-accent/35 bg-accent-soft', word: 'text-accent-hi' },
  waiting: { edge: 'border-waiting/45 bg-waiting-soft', word: 'text-waiting' },
}

/**
 * Something went wrong, or something is happening that the reader has to know
 * about. Two shapes, and which one you get is decided by what you pass:
 *
 *   Sentence only          → a tinted paragraph. Unchanged.
 *   `title` / `detail` /   → a bounded block: a word for the tone, the
 *   `action`                 sentence in ink, and the way out.
 *
 * The block exists because the interesting failures all have a recovery — a
 * submit that did not save can be retried, a stale screen can be reloaded — and
 * a message that names the problem and then leaves the person holding the phone
 * with nothing to press is only half of the sentence. `action` is a slot rather
 * than a button prop so it can be a `Button`, a `Link` or a `form`; whatever it
 * is, give it `w-full`.
 *
 * Body copy in ink, not in the tone's own colour: 16:1 against the tint instead
 * of 5.2:1, and the tone is already doing its job in the word above.
 */
export function Notice({
  tone = 'alert',
  title,
  detail,
  action,
  children,
}: {
  tone?: NoticeTone
  /** The tone in a word — "That didn't save", "Under review". */
  title?: ReactNode
  /** The quieter line under the sentence — what has NOT gone wrong. */
  detail?: ReactNode
  /** The way out. Rendered under the text, full width. */
  action?: ReactNode
  children: ReactNode
}) {
  if (!title && !detail && !action) {
    return (
      <p role="alert" className={clsx('rounded-control px-3.5 py-3 text-body font-medium', NOTICE_FLAT[tone])}>
        {children}
      </p>
    )
  }

  const t = NOTICE_BLOCK[tone]
  return (
    <div role="alert" className={clsx('rounded-card border-2 p-4', t.edge)}>
      {title ? (
        <p className={clsx('font-score text-eyebrow uppercase', t.word)}>{title}</p>
      ) : null}
      <p className={clsx('text-body text-text', title && 'mt-1.5')}>{children}</p>
      {detail ? <p className="mt-1.5 text-meta text-text-2">{detail}</p> : null}
      {action ? <div className="mt-3">{action}</div> : null}
    </div>
  )
}

/**
 * A destructive or surprising action, in two taps — promoted out of the admin
 * screens because the court card has exactly the same problem.
 *
 * Every caller fires something that changes the day: a walkover is awarded, a
 * live match loses its start time, a dispute pins a red alert on the
 * organiser's board and stops the winners advancing. One tap in the sun with a
 * paddle in the other hand is not consent, and an undo that costs a page load
 * is not a substitute for being told first.
 *
 * `details` rather than a dialog: no JavaScript, no focus trap to get wrong,
 * and tapping the summary again is the cancel. The summary says what the button
 * is FOR; the sentence inside says what it will DO.
 *
 * `size` is the venue, not the taste: `md` is a 56px organiser control at a
 * desk, `lg` is a 72px control used on court, where the brief's own floor is
 * higher and the border has to be findable rather than tidy.
 */
export function Confirm({
  label,
  question,
  detail,
  children,
  cancelHint = 'Tap the button above again to leave it alone.',
  size = 'md',
  className,
}: {
  /** What the control is for. Shown closed. */
  label: ReactNode
  /** What will happen, in a sentence, before it happens. */
  question: ReactNode
  /** A second line where the sentence is not the whole story. */
  detail?: ReactNode
  /** The real form, with the real submit button inside it. */
  children: ReactNode
  /** Pass `false` where the surrounding copy already says how to back out. */
  cancelHint?: ReactNode | false
  size?: 'md' | 'lg'
  className?: string
}) {
  return (
    <details className={clsx('group min-w-0', className)}>
      <summary
        className={clsx(
          'flex items-center justify-center rounded-control bg-paper text-center',
          size === 'lg'
            ? 'tap-xl border-2 border-line-key px-4 text-[18px] font-bold text-text'
            : 'tap border border-line-key px-3.5 text-[16px] font-semibold text-text-2',
        )}
      >
        {label}
      </summary>
      <div className="mt-2 rounded-control border border-line-strong bg-sunken p-3.5">
        <p className="text-body text-text">{question}</p>
        {detail ? <p className="mt-1.5 text-meta text-text-2">{detail}</p> : null}
        <div className="mt-3">{children}</div>
        {cancelHint ? <p className="mt-2 text-meta text-text-3">{cancelHint}</p> : null}
      </div>
    </details>
  )
}

/**
 * How far through something it is. A bar rather than a percentage: it is read
 * at arm's length while walking, and "two thirds" is the whole content of the
 * number.
 *
 * `label` is what a screen reader says, so it carries the unit the bar cannot
 * draw — "18 of 27 matches played", not "18 of 27".
 */
export function Meter({
  done,
  total,
  label,
  tone = 'ink',
  className,
}: {
  done: number
  total: number
  label?: string
  /** `accent` for a countdown the reader is waiting on, `ink` for progress. */
  tone?: 'ink' | 'accent'
  className?: string
}) {
  const pct = total > 0 ? Math.round((Math.min(Math.max(done, 0), total) / total) * 100) : 0
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={done}
      aria-label={label ?? `${done} of ${total}`}
      className={clsx('h-2 w-full overflow-hidden rounded-full bg-sunken', className)}
    >
      <div
        className={clsx('h-full rounded-full', tone === 'accent' ? 'bg-accent' : 'bg-ink')}
        style={{ width: `${pct}%` }}
      />
    </div>
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

const SWATCH: Record<'sm' | 'md' | 'lg', string> = {
  /** In a line of text, beside the court's name. */
  sm: 'size-2.5 rounded-[3px]',
  /** A row's own identity, read at arm's length. */
  md: 'size-5 rounded-[4px]',
  /** The court card in the net post header — checkable from a metre away. */
  lg: 'size-9 rounded-[6px]',
}

/**
 * Every representation of a court carries its colour, so checking a phone
 * against the card on the net post stops requiring reading.
 *
 * It takes a size because the distance changes: 10px is right next to a name in
 * a list, and wrong as the thing a pair squints at from the baseline to be sure
 * they are about to put a score on their own court. `aria-hidden` at every
 * size — the court's name is always beside it, and the system never leans on
 * colour alone.
 */
export function CourtSwatch({
  colorKey,
  size = 'sm',
  onInk,
  className,
}: {
  colorKey: string
  size?: 'sm' | 'md' | 'lg'
  /** On the ink band. Court indigo on navy is otherwise a hole, not a square. */
  onInk?: boolean
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={clsx(
        'court-swatch shrink-0',
        SWATCH[size],
        COURT_COLORS[colorKey] ?? 'bg-court-blue',
        onInk && 'ring-2 ring-white/45',
        className,
      )}
    />
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

/**
 * The venue lockup, on ink. One definition, because the front door and every
 * tournament page carry the same one and they had drifted a size apart.
 *
 * It grows with the band it sits in. At 390px it is deliberately quieter than
 * the tournament name below it — the reader knows where they are and came for
 * the day, not the brand — but at 1280px the band is three times as wide and a
 * 19px eyebrow in it reads as a smudge, which is what it was doing.
 */
export function Wordmark({ className }: { className?: string }) {
  return (
    <div className={clsx('flex items-center gap-2 sm:gap-2.5', className)}>
      <CourtMark className="size-6 shrink-0 text-white sm:size-7" />
      <span className="font-score text-[20px] font-bold tracking-[0.04em] text-accent-on-ink uppercase sm:text-[23px]">
        Madras Pickleball
      </span>
    </div>
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

/**
 * The caret on anything that opens. The `chev` class is what the stylesheet
 * rotates when the parent `details` opens and what print removes, so a caller
 * adding a size or a colour must keep it — pass `className`, don't replace it.
 */
export function Chevron({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={clsx('chev size-5 shrink-0', className)} fill="none">
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
      {/* line-key: a summary is a 56px target on a busy page, and the box is
          the only thing that says so. */}
      <summary className="tap flex items-center gap-3 rounded-control border border-line-key bg-paper px-4 text-left shadow-card">
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
