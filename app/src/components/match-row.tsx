import { clsx } from 'clsx'
import { StatusSpine, type Status } from './ui'

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
  meta?: string
}

/**
 * A match row has to read as two sides and a result, not as a two-line label.
 * The two game counts sit on the same baselines as the two names, so the row is
 * itself a small scoreboard: a score is numerals, a state is a pill, and
 * peripheral vision can sort a list of forty without reading any of it.
 */
export function MatchRow(props: MatchRowProps) {
  const { winnerSide, hasScore } = props
  const aWon = winnerSide === 'A'
  const bWon = winnerSide === 'B'

  return (
    <div className="relative flex min-h-[72px] items-center gap-3 px-4 py-3">
      <StatusSpine state={props.state} />
      <div className="min-w-0 flex-1">
        <p
          className={clsx(
            'truncate text-row',
            hasScore && !aWon ? 'text-text-3' : 'text-text',
            aWon && 'font-bold',
          )}
        >
          {props.nameA ?? props.placeholderA ?? 'To be decided'}
        </p>
        <p
          className={clsx(
            'truncate text-row',
            hasScore && !bWon ? 'text-text-3' : 'text-text',
            bWon && 'font-bold',
          )}
        >
          {props.nameB ?? props.placeholderB ?? 'To be decided'}
        </p>
        {props.meta ? (
          <p className="num mt-0.5 truncate text-meta text-text-3">{props.meta}</p>
        ) : null}
      </div>

      {hasScore ? (
        <div className="num flex shrink-0 flex-col items-end">
          <span
            className={clsx(
              'text-[24px] leading-[22px] font-bold',
              aWon ? 'text-text' : 'text-text-3',
            )}
          >
            {props.gamesWonA}
          </span>
          <span
            className={clsx(
              'text-[24px] leading-[22px] font-bold',
              bWon ? 'text-text' : 'text-text-3',
            )}
          >
            {props.gamesWonB}
          </span>
        </div>
      ) : (
        <span
          className={clsx(
            'font-score shrink-0 rounded-full px-3 py-1 text-eyebrow uppercase',
            props.state === 'ready' ? 'bg-ink text-white' : 'bg-done-soft text-text-2',
          )}
        >
          {props.stateLabel}
        </span>
      )}
    </div>
  )
}
