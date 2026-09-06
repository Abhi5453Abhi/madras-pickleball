import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { CourtMark, NetRule, TeamName, Wordmark } from '@/components/ui'

/**
 * The public pages' shared pieces: the ink band at the top, and one court.
 *
 * A court card carries its colour on the left edge — the same colour as the
 * card on the net post — so "which court is that" is answered without reading.
 * Never colour alone: the name is always on the card too.
 */

const COURT_EDGE: Record<string, string> = {
  blue: 'border-l-court-blue',
  orange: 'border-l-court-orange',
  teal: 'border-l-court-teal',
  violet: 'border-l-court-violet',
  clay: 'border-l-court-clay',
  indigo: 'border-l-court-indigo',
}

export function CourtCard({
  name,
  colorKey,
  label,
  live,
}: {
  name: string
  colorKey: string
  /**
   * The small word on the right — the round, or which tournament holds it.
   * Empty when nobody holds the court today.
   */
  label: string
  /** The match on it. Null means the court is free. */
  live: { nameA: string | null; playersA: string[]; nameB: string | null; playersB: string[] } | null
}) {
  return (
    <article
      className={clsx(
        'rounded-card border border-l-[5px] border-line-strong shadow-card',
        COURT_EDGE[colorKey] ?? 'border-l-court-blue',
        live ? 'bg-paper' : 'border-l-dashed bg-ground',
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-2.5 pb-0.5">
        <span className="font-score text-[17px] font-bold tracking-[0.06em] text-text uppercase">
          {name}
        </span>
        <span className="truncate text-meta text-text-3">{label || 'Free'}</span>
      </div>
      {live ? (
        <div className="px-4 pt-1 pb-3">
          <TeamName name={live.nameA} players={live.playersA} />
          <span className="my-0.5 block text-meta font-normal text-text-3">against</span>
          <TeamName name={live.nameB} players={live.playersB} />
        </div>
      ) : label ? (
        // Held by a tournament, nothing on it: the next match in its order
        // goes here.
        <p className="px-4 pt-0.5 pb-2.5 text-body text-text-3">Free</p>
      ) : (
        <div className="pb-2" />
      )}
    </article>
  )
}

/** The band. Brand, a title, one line under it — and the paused notice slot. */
export function Masthead({ title, sub }: { title: ReactNode; sub: ReactNode }) {
  return (
    <header className="masthead relative overflow-hidden bg-ink px-4 pt-5 pb-5 text-white">
      <CourtMark className="pointer-events-none absolute -right-8 -bottom-12 w-56 text-white opacity-[0.07] print:hidden" />
      <div className="mx-auto w-full max-w-3xl">
        <Wordmark />
        <h1 className="mt-2 text-hero">{title}</h1>
        <p className="num mt-1 text-body text-on-ink-2">{sub}</p>
      </div>
      <NetRule className="absolute inset-x-0 bottom-0" />
    </header>
  )
}

/** Small caps over a section. `live` is the one green on the page. */
export function Eyebrow({
  children,
  live,
  count,
}: {
  children: ReactNode
  live?: boolean
  count?: number
}) {
  return (
    <h2
      className={clsx(
        'font-score text-eyebrow uppercase',
        live ? 'text-live-text' : 'text-text-2',
      )}
    >
      {children}
      {count !== undefined ? (
        <small className="num ml-1.5 font-normal normal-case text-text-3">{count}</small>
      ) : null}
    </h2>
  )
}

/** "Court 1, Court 2" is how the database says it; "Courts 1, 2" is how a person does. */
export function courtsLabel(names: string[]) {
  if (!names.length) return 'no courts'
  const nums = names.map((n) => /^Court (\d+)$/.exec(n)?.[1])
  if (names.length > 1 && nums.every(Boolean)) return `Courts ${nums.join(', ')}`
  return names.join(', ')
}
