import { clsx } from 'clsx'
import type { ReactNode } from 'react'
import { StatusPill, StatusSpine, type Status } from './ui'

export type MatchRowProps = {
  nameA: string | null
  nameB: string | null
  /** Rendered where a slot is unresolved — "Winner of Semi-final 1", never "TBD". */
  placeholderA?: string
  placeholderB?: string
  gamesWonA: number
  gamesWonB: number
  winnerSide: 'A' | 'B' | null
  hasScore: boolean
  state: Status
  stateLabel: string
  /** Numerals — the scoreline. Rendered in the condensed face. */
  meta?: string
  /** Words — category, round, court. Rendered in the UI face, never condensed. */
  sub?: ReactNode
  /** A Tag or two: "Not confirmed yet", "Under review". */
  note?: ReactNode
}

/**
 * A match row has to read as two sides and a result, not as a two-line label.
 * The two game counts sit on the same baselines as the two names, so the row is
 * itself a small scoreboard: a score is numerals, a state is a pill, and
 * peripheral vision can sort a list of forty without reading any of it.
 *
 * Names WRAP rather than truncate. "Karthik Subramanian / Sathish Kumar" is a
 * real entry here, and truncating it to "Karthik Subramanian / Sat…" hides the
 * half a player is looking for. Two lines is bounded; a lost name is not.
 */
export function MatchRow(props: MatchRowProps) {
  const { winnerSide, hasScore } = props
  const aWon = winnerSide === 'A'
  const bWon = winnerSide === 'B'

  return (
    <div className="relative flex min-h-[76px] items-center gap-3 px-4 py-3">
      <StatusSpine state={props.state} />
      <div className="min-w-0 flex-1">
        {props.sub ? <p className="mb-1 text-meta text-text-3">{props.sub}</p> : null}
        <p
          className={clsx(
            'line-clamp-2 text-row break-words',
            hasScore && !aWon ? 'text-text-3' : 'text-text',
            aWon && 'font-bold',
          )}
        >
          {props.nameA ?? props.placeholderA ?? 'To be decided'}
          {aWon ? <span className="sr-only"> — won</span> : null}
        </p>
        {/* Four names in two stacks with nothing between them is four pairs at
            a glance rather than two — the same ambiguity the live court cards
            had. Same gesture, one weight down: the net rule broken at one
            third, with a "v" standing in the gap. Neutral rather than
            terracotta: at row scale, seven times on one screen, the accent
            stops being structure and becomes decoration.

            Only on a fixture. A row that HAS a score already says which two
            things these are — two game counts on the two names' own baselines,
            the winner in bold — and pushing the second name down by 22px to
            make that point again is what breaks it. */}
        {hasScore ? null : (
          <span className="my-1 flex items-center gap-2">
            <span aria-hidden className="h-px shrink-0 basis-[26%] bg-line-strong" />
            <span aria-hidden className="font-score text-[14px] leading-none font-bold text-text-3">
              v
            </span>
            <span className="sr-only">versus</span>
            <span aria-hidden className="h-px flex-1 bg-line-strong" />
          </span>
        )}
        <p
          className={clsx(
            'line-clamp-2 text-row break-words',
            hasScore && !bWon ? 'text-text-3' : 'text-text',
            bWon && 'font-bold',
          )}
        >
          {props.nameB ?? props.placeholderB ?? 'To be decided'}
          {bWon ? <span className="sr-only"> — won</span> : null}
        </p>
        {props.meta ? (
          <p className="num mt-1 text-meta text-text-3">{props.meta}</p>
        ) : null}
        {props.note ? <p className="mt-1.5 flex flex-wrap gap-1.5">{props.note}</p> : null}
      </div>

      {hasScore ? (
        <div className="num flex shrink-0 flex-col items-end">
          <span
            className={clsx(
              'text-[26px] leading-[24px] font-bold',
              aWon ? 'text-text' : 'text-text-3',
            )}
          >
            {props.gamesWonA}
          </span>
          <span
            className={clsx(
              'text-[26px] leading-[24px] font-bold',
              bWon ? 'text-text' : 'text-text-3',
            )}
          >
            {props.gamesWonB}
          </span>
        </div>
      ) : (
        <StatusPill state={props.state}>{props.stateLabel}</StatusPill>
      )}
    </div>
  )
}
