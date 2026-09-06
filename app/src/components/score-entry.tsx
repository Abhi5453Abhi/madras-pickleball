'use client'

import { clsx } from 'clsx'
import { useMemo, useRef, useState } from 'react'
import { winnerChips, loserChips, anyLoserScores, explainSingleChip } from '@/lib/chips'
import { matchOutcome, gamesNeededToWin, type GameScore, type ScoringRules } from '@/lib/rules'
import { NetRule } from './ui'

export type ScoreEntryProps = {
  matchId: string
  courtName?: string | null
  courtColor?: string
  categoryName: string
  roundName?: string | null
  teamAId: string
  teamBId: string
  nameA: string
  nameB: string
  rules: ScoringRules
  /** An admin or umpire submission is authoritative — no confirmation dance. */
  authoritative: boolean
  onSubmit: (payload: {
    games: GameScore[]
    resultType: 'normal' | 'walkover' | 'retired'
    winnerTeamId: string | null
    retiredTeamId: string | null
    submittingTeamId: string | null
    reason?: string
  }) => Promise<{ ok: boolean; error?: string }>
}

type Draft = { winner: 'A' | 'B' | null; winnerScore: number | null; loserScore: number | null }
const emptyDraft: Draft = { winner: null, winnerScore: null, loserScore: null }

function Chip({
  value,
  selected,
  suggested,
  onClick,
  wide,
}: {
  value: number
  selected: boolean
  suggested?: boolean
  onClick: () => void
  wide?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={clsx(
        'num relative grid h-16 place-items-center rounded-control text-[28px] leading-none font-bold',
        'transition-colors duration-100 active:translate-y-px',
        wide && 'col-span-5 h-[72px] text-[32px]',
        selected
          ? 'bg-ink text-white shadow-key'
          : 'border border-line-strong bg-paper text-text',
        // A scanning aid, not a default you can submit through.
        suggested &&
          !selected &&
          'after:absolute after:bottom-1.5 after:h-[3px] after:w-6 after:rounded-full after:bg-accent-line',
      )}
    >
      {value}
    </button>
  )
}

function SideButton({
  label,
  side,
  selected,
  onClick,
}: {
  label: string
  side: 'A' | 'B'
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={clsx(
        'flex min-h-[88px] items-center rounded-control border-l-4 px-4 text-left text-row',
        'transition-colors duration-100 active:translate-y-px',
        side === 'A' ? 'border-l-side-a' : 'border-l-side-b',
        selected
          ? 'bg-ink text-white ring-2 ring-ink'
          : 'border border-line-strong bg-paper text-text',
      )}
    >
      <span className="line-clamp-2">{label}</span>
    </button>
  )
}

/** 600ms hold with a visible meter — without one, people release early and blame the app. */
function HoldButton({
  children,
  onComplete,
  disabled,
}: {
  children: React.ReactNode
  onComplete: () => void
  disabled?: boolean
}) {
  const [progress, setProgress] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    setProgress(0)
  }

  const start = () => {
    if (disabled || timer.current) return
    const startedAt = Date.now()
    timer.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - startedAt) / 600)
      setProgress(p)
      if (p >= 1) {
        stop()
        onComplete()
      }
    }, 16)
  }

  return (
    <button
      type="button"
      disabled={disabled}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onComplete()
        }
      }}
      className="tap-xl relative w-full overflow-hidden rounded-control bg-ink text-[20px] font-bold text-white disabled:opacity-60"
    >
      <span
        aria-hidden
        style={{ transform: `scaleX(${progress})` }}
        className="absolute inset-y-0 left-0 w-full origin-left bg-accent-line/70"
      />
      <span className="relative">{children}</span>
    </button>
  )
}

export function ScoreEntry(props: ScoreEntryProps) {
  const { rules, nameA, nameB } = props
  const need = gamesNeededToWin(rules)

  const [finished, setFinished] = useState<GameScore[]>([])
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [showMore, setShowMore] = useState(false)
  const [showAllLoser, setShowAllLoser] = useState(false)
  const [submitting, setSubmitting] = useState<'A' | 'B' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [special, setSpecial] = useState<null | {
    kind: 'walkover' | 'retired'
    side: 'A' | 'B' | null
  }>(null)

  const outcome = matchOutcome(rules, finished)
  const complete = outcome.complete
  const gameNo = finished.length + 1

  const wChips = useMemo(() => winnerChips(rules), [rules])
  const lChips = useMemo(
    () =>
      draft.winnerScore === null
        ? []
        : showAllLoser
          ? anyLoserScores(draft.winnerScore)
          : loserChips(rules, draft.winnerScore),
    [rules, draft.winnerScore, showAllLoser],
  )

  function commitGame(loserScore: number) {
    if (draft.winner === null || draft.winnerScore === null) return
    const g: GameScore = {
      gameNo,
      scoreA: draft.winner === 'A' ? draft.winnerScore : loserScore,
      scoreB: draft.winner === 'B' ? draft.winnerScore : loserScore,
    }
    setFinished([...finished, g])
    setDraft(emptyDraft)
    setShowMore(false)
    setShowAllLoser(false)
  }

  async function send(side: 'A' | 'B' | null) {
    setBusy(true)
    setError(null)
    const payload =
      special?.kind === 'walkover'
        ? {
            games: [] as GameScore[],
            resultType: 'walkover' as const,
            winnerTeamId: special.side === 'A' ? props.teamBId : props.teamAId,
            retiredTeamId: null,
            submittingTeamId: side === 'A' ? props.teamAId : side === 'B' ? props.teamBId : null,
          }
        : {
            games: finished,
            resultType: 'normal' as const,
            winnerTeamId: outcome.winner === 'A' ? props.teamAId : props.teamBId,
            retiredTeamId: null,
            submittingTeamId: side === 'A' ? props.teamAId : side === 'B' ? props.teamBId : null,
          }
    const res = await props.onSubmit(payload)
    setBusy(false)
    if (!res.ok) setError(res.error ?? 'That didn’t save. Try again.')
  }

  const winnerName = outcome.winner === 'A' ? nameA : nameB
  const scoreLine = finished.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ')

  return (
    <div className="flex flex-col gap-5">
      <div>
        <div className="flex items-center gap-2">
          {props.courtName ? (
            <span className="font-score text-[40px] leading-none font-bold text-text">
              {props.courtName.toUpperCase()}
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-row text-text">{nameA}</p>
        <p className="text-row text-text">{nameB}</p>
        <p className="text-meta text-text-3">
          {props.categoryName}
          {props.roundName ? ` · ${props.roundName}` : ''}
        </p>
      </div>
      <NetRule />

      {error ? (
        <p role="alert" className="rounded-control bg-alert-soft px-3.5 py-3 text-body font-medium text-alert">
          {error}
        </p>
      ) : null}

      {/* Finished games stay on screen, one tap from being changed. */}
      {finished.map((g, i) => (
        <button
          key={g.gameNo}
          type="button"
          onClick={() => {
            setFinished(finished.slice(0, i))
            setDraft(emptyDraft)
          }}
          className="tap flex items-center justify-between rounded-control border border-line-strong bg-paper px-4 text-left"
        >
          <span className="font-score text-eyebrow text-text-2 uppercase">Game {g.gameNo}</span>
          <span className="num text-[22px] font-bold text-text">
            {g.scoreA}–{g.scoreB}
          </span>
        </button>
      ))}

      {special?.kind === 'walkover' && special.side ? (
        <div className="rounded-card border border-line-strong bg-paper p-4">
          <p className="text-section text-text">
            {special.side === 'A' ? nameA : nameB} didn’t turn up.
          </p>
          <p className="mt-1 text-body text-text-2">
            {special.side === 'A' ? nameB : nameA} go through. Recorded as a no-show — it won’t
            count towards points scored.
          </p>
        </div>
      ) : !complete ? (
        <div className="flex flex-col gap-4">
          <p className="font-score text-eyebrow text-text-3 uppercase">Game {gameNo}</p>

          <div>
            <p className="text-section text-text">Who won game {gameNo}?</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <SideButton
                label={nameA}
                side="A"
                selected={draft.winner === 'A'}
                onClick={() => setDraft({ winner: 'A', winnerScore: null, loserScore: null })}
              />
              <SideButton
                label={nameB}
                side="B"
                selected={draft.winner === 'B'}
                onClick={() => setDraft({ winner: 'B', winnerScore: null, loserScore: null })}
              />
            </div>
            <button
              type="button"
              onClick={() => setSheet(true)}
              className="tap mt-1 text-left text-body font-medium text-link"
            >
              They didn’t play it out
            </button>
          </div>

          {draft.winner ? (
            <div>
              <p className="text-section text-text">
                {(draft.winner === 'A' ? nameA : nameB)}’s score
              </p>
              <div className="mt-3 grid grid-cols-5 gap-2.5">
                {(showMore ? [...wChips.chips, ...wChips.more] : wChips.chips).map((n) => (
                  <Chip
                    key={n}
                    value={n}
                    selected={draft.winnerScore === n}
                    suggested={n === rules.pointsToWin}
                    onClick={() => setDraft({ ...draft, winnerScore: n, loserScore: null })}
                  />
                ))}
              </div>
              {wChips.more.length && !showMore ? (
                <button
                  type="button"
                  onClick={() => setShowMore(true)}
                  className="tap mt-1 text-body font-medium text-link"
                >
                  more
                </button>
              ) : null}
            </div>
          ) : null}

          {draft.winnerScore !== null ? (
            <div>
              <p className="text-section text-text">
                And {draft.winner === 'A' ? nameB : nameA}?
              </p>
              <div className="mt-3 grid grid-cols-5 gap-2.5">
                {lChips.map((n) => (
                  <Chip
                    key={n}
                    value={n}
                    selected={false}
                    wide={lChips.length === 1}
                    onClick={() => commitGame(n)}
                  />
                ))}
              </div>
              {lChips.length === 1 ? (
                <p className="mt-2 text-meta text-text-3">
                  {explainSingleChip(rules, draft.winnerScore, lChips[0])}
                </p>
              ) : null}
              {!showAllLoser ? (
                <button
                  type="button"
                  onClick={() => setShowAllLoser(true)}
                  className="tap mt-1 text-body font-medium text-link"
                >
                  Their score isn’t here
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rounded-card border border-line-strong bg-paper p-4">
          <p className="text-section text-text">
            {winnerName} win {outcome.gamesWonA}–{outcome.gamesWonB}
          </p>
          <p className="num mt-1 text-body text-text-2">{scoreLine}</p>
        </div>
      )}

      {(complete || (special?.kind === 'walkover' && special.side)) ? (
        props.authoritative ? (
          <HoldButton disabled={busy} onComplete={() => send(null)}>
            {busy ? 'Saving…' : 'Hold to save the result'}
          </HoldButton>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="text-section text-text">Who’s submitting?</p>
            <div className="grid grid-cols-2 gap-3">
              <SideButton
                label={nameA}
                side="A"
                selected={submitting === 'A'}
                onClick={() => setSubmitting('A')}
              />
              <SideButton
                label={nameB}
                side="B"
                selected={submitting === 'B'}
                onClick={() => setSubmitting('B')}
              />
            </div>
            <HoldButton disabled={busy || !submitting} onComplete={() => send(submitting)}>
              {busy ? 'Saving…' : submitting ? 'Hold to submit' : 'Pick your side first'}
            </HoldButton>
          </div>
        )
      ) : null}

      {sheet ? (
        <div
          role="dialog"
          aria-modal
          className="fixed inset-0 z-30 flex items-end bg-board/50"
          onClick={() => setSheet(false)}
        >
          <div
            className="w-full rounded-t-[20px] bg-paper p-4 pb-8"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="text-section text-text">What happened instead?</p>
            <div className="mt-3 flex flex-col gap-2">
              <button
                type="button"
                onClick={() => {
                  setSpecial({ kind: 'walkover', side: null })
                  setSheet(false)
                }}
                className="tap-xl rounded-control border border-line-strong bg-paper px-4 text-left text-row text-text"
              >
                One side didn’t turn up
              </button>
              <button
                type="button"
                onClick={() => setSheet(false)}
                className="tap rounded-control px-4 text-left text-body font-medium text-link"
              >
                Never mind
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {special?.kind === 'walkover' && !special.side ? (
        <div className="rounded-card border border-line-strong bg-paper p-4">
          <p className="text-section text-text">Who didn’t turn up?</p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <SideButton
              label={nameA}
              side="A"
              selected={false}
              onClick={() => setSpecial({ kind: 'walkover', side: 'A' })}
            />
            <SideButton
              label={nameB}
              side="B"
              selected={false}
              onClick={() => setSpecial({ kind: 'walkover', side: 'B' })}
            />
          </div>
        </div>
      ) : null}

      {finished.length > 0 && !complete ? (
        <p className="text-meta text-text-3">
          Best of {rules.bestOf} to {rules.pointsToWin} — first to {need} games.
        </p>
      ) : null}
    </div>
  )
}
