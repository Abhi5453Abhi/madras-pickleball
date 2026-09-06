'use client'

import { clsx } from 'clsx'
import { useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  winnerChips,
  loserChips,
  anyLoserScores,
  explainSingleChip,
  illegalReason,
  likelyWinnerScore,
} from '@/lib/chips'
import {
  matchOutcome,
  gamesNeededToWin,
  hornOutcome,
  retirementGames,
  type GameScore,
  type ScoringRules,
} from '@/lib/rules'
import { Input, NetRule, Tag } from './ui'

/**
 * What a failed submit tells the screen to offer next. `retry` means the same
 * payload again (a dropped connection, a lock); `reload` means the world moved
 * and this screen is looking at the wrong thing.
 */
export type SubmitOutcome = {
  ok: boolean
  error?: string
  recover?: 'retry' | 'reload'
}

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
  /**
   * When set, the games committed so far survive a reload ON THIS DEVICE.
   * Best-of-3 means a pair can enter game 1, walk away, and come back after
   * game 2 — and until now nothing existed until submit.
   */
  persistKey?: string
  /**
   * Set when a result is already in. The screen then reads as a CORRECTION:
   * it shows what it is replacing and will not send without a reason.
   */
  existing?: { scoreLine: string | null; winnerName: string | null; label: string } | null
  onSubmit: (payload: {
    games: GameScore[]
    resultType: 'normal' | 'walkover' | 'retired'
    winnerTeamId: string | null
    retiredTeamId: string | null
    excludeFromDiff?: number[]
    submittingTeamId: string | null
    reason?: string
  }) => Promise<SubmitOutcome>
}

type Draft = { winner: 'A' | 'B' | null; winnerScore: number | null }
const emptyDraft: Draft = { winner: null, winnerScore: null }

// ─────────────────────────── the draft on the phone ───────────────────────────

const DRAFT_VERSION = 1
/** A tournament day. Longer and yesterday's game 1 turns up in today's match. */
const DRAFT_TTL_MS = 6 * 60 * 60_000

/**
 * localStorage is per-device and per-browser: it comes back empty as often as
 * not (a different phone, a private tab, cleared site data), and every accessor
 * throws outright in some configurations. So it is a convenience that must
 * never be load-bearing, and what comes back out of it is the same kind of wire
 * format as a server action's argument — copied out field by field, never
 * trusted as a typed object.
 */
function readStored(key: string | undefined): string | null {
  if (!key) return null
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

/** Cross-tab only; the same tab's writes are already in this component's state. */
function subscribeStorage(onChange: () => void) {
  window.addEventListener('storage', onChange)
  return () => window.removeEventListener('storage', onChange)
}

function parseDraft(raw: string | null): GameScore[] | null {
  try {
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const box = parsed as { v?: unknown; at?: unknown; games?: unknown }
    if (box.v !== DRAFT_VERSION) return null
    if (typeof box.at !== 'number' || Date.now() - box.at > DRAFT_TTL_MS) return null
    if (!Array.isArray(box.games) || box.games.length === 0 || box.games.length > 9) return null

    const games: GameScore[] = []
    for (const entry of box.games) {
      const g = entry as { gameNo?: unknown; scoreA?: unknown; scoreB?: unknown; timeCapped?: unknown }
      if (!Number.isInteger(g.gameNo) || !Number.isInteger(g.scoreA) || !Number.isInteger(g.scoreB)) {
        return null
      }
      games.push({
        gameNo: g.gameNo as number,
        scoreA: g.scoreA as number,
        scoreB: g.scoreB as number,
        timeCapped: g.timeCapped === true,
      })
    }
    return games
  } catch {
    return null
  }
}

function writeDraft(key: string, games: GameScore[]) {
  try {
    if (games.length === 0) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, JSON.stringify({ v: DRAFT_VERSION, at: Date.now(), games }))
  } catch {
    // A phone with storage off still has to be able to score a match.
  }
}

// ────────────────────────────────── pieces ──────────────────────────────────

/**
 * `line-strong` measures 1.6:1 against paper. On a card that is a boundary
 * nobody needs to find; on a 64px number chip in direct sun it is the only
 * thing saying where the target is, and 1.6:1 is not a target edge. `text-3` is
 * 5.1:1 and reads as a pencil line, not as a heavy box.
 */
const KEY_EDGE = 'border-2 border-text-3'

function Chip({
  value,
  selected,
  suggested,
  onClick,
  wide,
  label,
}: {
  value: number
  selected: boolean
  suggested?: boolean
  onClick: () => void
  wide?: boolean
  label?: string
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      aria-label={label}
      onClick={onClick}
      className={clsx(
        'num relative grid h-16 place-items-center rounded-control text-[28px] leading-none font-bold',
        'transition-colors duration-100 active:translate-y-px',
        wide && 'col-span-5 h-[72px] text-[32px]',
        selected ? 'bg-ink text-white shadow-key' : clsx(KEY_EDGE, 'bg-paper text-text'),
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
        selected ? 'bg-ink text-white ring-2 ring-ink' : clsx(KEY_EDGE, 'bg-paper text-text'),
      )}
    >
      <span className="line-clamp-2">{label}</span>
    </button>
  )
}

/**
 * 600ms hold with a visible meter — without one, people release early and blame
 * the app.
 *
 * `touch-action: none` is the load-bearing line: without it the browser spends
 * the first ~100ms deciding whether the press is the start of a scroll, steals
 * the gesture, and the hold silently does nothing. Sliding off still cancels,
 * which is the escape hatch.
 */
function HoldButton({
  children,
  onComplete,
  disabled,
  side,
  holdLabel,
}: {
  children: React.ReactNode
  onComplete: () => void
  disabled?: boolean
  side?: 'A' | 'B'
  holdLabel?: string
}) {
  const [progress, setProgress] = useState(0)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    setProgress(0)
  }

  // The interval outlives the component if a submit navigates away mid-hold.
  useEffect(() => stop, [])

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
      style={{ touchAction: 'none' }}
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
      className={clsx(
        'relative w-full overflow-hidden rounded-control bg-ink px-4 text-left text-white',
        'min-h-[76px] disabled:opacity-60',
        side === 'A' && 'border-l-4 border-l-side-a',
        side === 'B' && 'border-l-4 border-l-side-b',
      )}
    >
      <span
        aria-hidden
        style={{ transform: `scaleX(${progress})` }}
        className="absolute inset-y-0 left-0 w-full origin-left bg-accent-line/70"
      />
      <span className="relative flex items-center justify-between gap-3">
        <span className="min-w-0">{children}</span>
        {holdLabel ? (
          <span className="font-score shrink-0 text-eyebrow text-white/85 uppercase">
            {progress > 0 ? 'Keep holding' : holdLabel}
          </span>
        ) : null}
      </span>
    </button>
  )
}

/** A failure that keeps everything on screen and says what to do next. */
function Failure({
  text,
  action,
  onAction,
}: {
  text: string
  action: string
  onAction: () => void
}) {
  return (
    <div role="alert" className="rounded-card border-2 border-alert/40 bg-alert-soft p-4">
      <p className="font-score text-eyebrow text-alert uppercase">That didn’t save</p>
      {/* Body copy in ink, not in alert red: 16:1 against the tint instead of
          5.2:1, and the red is doing its job in the eyebrow above. */}
      <p className="mt-1.5 text-body text-text">{text}</p>
      <p className="mt-1.5 text-meta text-text-2">
        Nothing you typed has been lost — it is all still on this screen.
      </p>
      <button
        type="button"
        onClick={onAction}
        className="tap-lg mt-3 w-full rounded-control bg-ink text-[18px] font-bold text-white"
      >
        {action}
      </button>
    </div>
  )
}

// ───────────────────────────────── the screen ─────────────────────────────────

export function ScoreEntry(props: ScoreEntryProps) {
  const { rules, nameA, nameB, persistKey } = props
  const router = useRouter()
  const need = gamesNeededToWin(rules)

  const [finished, setFinished] = useState<GameScore[]>([])
  const [draft, setDraft] = useState<Draft>(emptyDraft)
  const [showMore, setShowMore] = useState(false)
  const [showAllLoser, setShowAllLoser] = useState(false)
  const [odd, setOdd] = useState<{ score: number; reason: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ text: string; recover: 'retry' | 'reload' } | null>(null)
  const [busy, setBusy] = useState(false)
  const [sendingSide, setSendingSide] = useState<'A' | 'B' | null>(null)
  /** True once this pair has touched anything on this screen. */
  const [touched, setTouched] = useState(false)
  const [sheet, setSheet] = useState(false)
  const [special, setSpecial] = useState<null | {
    kind: 'walkover' | 'retired'
    side: 'A' | 'B' | null
  }>(null)
  const [capped, setCapped] = useState<null | { a: string; b: string }>(null)
  // The score the game in progress was standing at. A retirement without it
  // publishes a game that was never played and deletes the points the retiring
  // pair had actually scored.
  const [stoppedAt, setStoppedAt] = useState<{ a: string; b: string }>({ a: '', b: '' })
  const [reason, setReason] = useState('')
  const correcting = !!props.existing

  const submitRef = useRef<HTMLDivElement | null>(null)

  // The horn ends the match. Once a time-capped game is in, there is no next
  // game to ask about.
  const hornEnded = finished.some((g) => g.timeCapped)
  const outcome = hornEnded ? hornOutcome(rules, finished) : matchOutcome(rules, finished)
  const complete = outcome.complete
  const gameNo = finished.length + 1
  const readyToSend = complete || !!(special?.side && special.kind)

  // ── the draft that survives a reload ──
  // Subscribed to, not copied into state on mount: the server renders no draft,
  // so anything read from storage has to arrive as a value the first client
  // render can already see, or it is a hydration mismatch. It is then OFFERED
  // rather than applied — a pair coming back to a phone after game 2 should be
  // told what is on it and choose, not find two games they cannot account for.
  const storedRaw = useSyncExternalStore(
    subscribeStorage,
    () => readStored(persistKey),
    () => null,
  )
  const offered = useMemo(() => parseDraft(storedRaw), [storedRaw])
  const showOffer = !!offered && !touched && finished.length === 0

  useEffect(() => {
    // Never on an empty list. The first render of every visit is empty, and a
    // write here would delete the very draft being offered a few lines below;
    // clearing is always a deliberate act — "start again", or a score that
    // actually reached the server.
    if (!persistKey || finished.length === 0) return
    writeDraft(persistKey, finished)
  }, [persistKey, finished])

  // The submit block is below the fold on a phone once two games are in, and
  // people do not scroll to look for a button they have not been told about.
  const wasReady = useRef(false)
  useEffect(() => {
    if (readyToSend && !wasReady.current) {
      wasReady.current = true
      const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
      submitRef.current?.scrollIntoView({ block: 'end', behavior: reduce ? 'auto' : 'smooth' })
    }
    if (!readyToSend) wasReady.current = false
  }, [readyToSend])

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

  function pickWinner(side: 'A' | 'B') {
    // The target is pre-selected (SPEC A5). It is right nine games in ten, and
    // the question underneath says the number out loud, so nothing is assumed
    // silently.
    setTouched(true)
    setDraft({ winner: side, winnerScore: likelyWinnerScore(rules) })
    setShowAllLoser(false)
    setOdd(null)
  }

  function commitGame(loserScore: number, force = false) {
    if (draft.winner === null || draft.winnerScore === null) return
    if (!force) {
      const why = illegalReason(rules, draft.winnerScore, loserScore)
      if (why) {
        setOdd({ score: loserScore, reason: why })
        return
      }
    }
    const g: GameScore = {
      gameNo,
      scoreA: draft.winner === 'A' ? draft.winnerScore : loserScore,
      scoreB: draft.winner === 'B' ? draft.winnerScore : loserScore,
    }
    setTouched(true)
    setFinished([...finished, g])
    setDraft(emptyDraft)
    setShowMore(false)
    setShowAllLoser(false)
    setOdd(null)
  }

  /**
   * Changing a game already entered reopens it with its numbers already in —
   * one tap to fix a score, not five. Later games go, because in a best-of-3
   * the order is what decides the match.
   */
  function changeGame(index: number) {
    const g = finished[index]
    setTouched(true)
    setFinished(finished.slice(0, index))
    setShowAllLoser(false)
    setOdd(null)
    setSpecial(null)
    // A time-capped game has no chip set to come back to — its score is
    // whatever the horn found. It reopens in the boxes it was typed in.
    if (g.timeCapped) {
      setDraft(emptyDraft)
      setCapped({ a: String(g.scoreA), b: String(g.scoreB) })
      return
    }
    setCapped(null)
    setDraft({
      winner: g.scoreA > g.scoreB ? 'A' : 'B',
      winnerScore: Math.max(g.scoreA, g.scoreB),
    })
  }

  function buildPayload(side: 'A' | 'B' | null) {
    const submittingTeamId = side === 'A' ? props.teamAId : side === 'B' ? props.teamBId : null

    if (special?.kind === 'walkover' && special.side) {
      return {
        games: [] as GameScore[],
        resultType: 'walkover' as const,
        winnerTeamId: special.side === 'A' ? props.teamBId : props.teamAId,
        retiredTeamId: null,
        submittingTeamId,
      }
    }
    if (special?.kind === 'retired' && special.side) {
      const partA = Number(stoppedAt.a)
      const partB = Number(stoppedAt.b)
      const hasPartial =
        stoppedAt.a !== '' &&
        stoppedAt.b !== '' &&
        Number.isFinite(partA) &&
        Number.isFinite(partB) &&
        partA >= 0 &&
        partB >= 0
      const played = hasPartial
        ? [...finished, { gameNo: finished.length + 1, scoreA: partA, scoreB: partB }]
        : finished
      const { games, excludeFromDiff } = retirementGames(rules, played, special.side)
      return {
        games,
        resultType: 'retired' as const,
        winnerTeamId: special.side === 'A' ? props.teamBId : props.teamAId,
        retiredTeamId: special.side === 'A' ? props.teamAId : props.teamBId,
        excludeFromDiff,
        submittingTeamId,
      }
    }
    return {
      games: finished,
      resultType: 'normal' as const,
      winnerTeamId: outcome.winner === 'A' ? props.teamAId : props.teamBId,
      retiredTeamId: null,
      submittingTeamId,
    }
  }

  async function send(side: 'A' | 'B' | null) {
    if (correcting && reason.trim().length < 3) {
      setError('Say what changed — it goes in the log next to your name.')
      return
    }
    setSendingSide(side)
    setBusy(true)
    setError(null)
    setFailure(null)

    let res: SubmitOutcome
    try {
      res = await props.onSubmit({ ...buildPayload(side), reason: reason.trim() || undefined })
    } catch {
      // A server action that never reaches the server throws. Outdoors, on a
      // phone, that is the ordinary case — and it used to take the whole
      // screen down with it.
      setBusy(false)
      setFailure({
        text: 'The phone couldn’t reach the site. The score is still here — try again when the signal comes back.',
        recover: 'retry',
      })
      return
    }
    setBusy(false)

    if (res.ok) {
      if (persistKey) writeDraft(persistKey, [])
      return
    }
    setFailure({
      text: res.error ?? 'That didn’t save. Try it again.',
      recover: res.recover ?? 'retry',
    })
  }

  const winnerName = outcome.winner === 'A' ? nameA : nameB
  const loserSideName = draft.winner === 'A' ? nameB : nameA
  const winnerSideName = draft.winner === 'A' ? nameA : nameB
  const scoreLine = finished.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ')

  return (
    <div className="flex flex-col gap-5">
      <div>
        {props.courtName ? (
          <div className="flex items-center gap-2">
            <span className="font-score text-[40px] leading-none font-bold text-text">
              {props.courtName.toUpperCase()}
            </span>
          </div>
        ) : null}
        <p className={clsx('text-row text-text', props.courtName && 'mt-1')}>{nameA}</p>
        <p className="text-row text-text">{nameB}</p>
        <p className="text-meta text-text-2">
          {props.categoryName}
          {props.roundName ? ` · ${props.roundName}` : ''}
        </p>
      </div>
      <NetRule />

      {failure ? (
        <Failure
          text={failure.text}
          action={failure.recover === 'reload' ? 'Show me what’s on this court now' : 'Try again'}
          onAction={() => {
            if (failure.recover === 'reload') {
              setFailure(null)
              router.refresh()
            } else {
              void send(sendingSide)
            }
          }}
        />
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-control bg-alert-soft px-3.5 py-3 text-body font-medium text-alert"
        >
          {error}
        </p>
      ) : null}

      {props.existing ? (
        <div className="rounded-card border border-alert/30 bg-alert-soft p-4">
          <p className="font-score text-eyebrow text-alert uppercase">
            Changing a result that’s already in
          </p>
          <p className="mt-1.5 text-row text-text">
            {props.existing.winnerName ? `${props.existing.winnerName} won` : props.existing.label}
            {props.existing.scoreLine ? (
              <span className="num text-text-2"> · {props.existing.scoreLine}</span>
            ) : null}
          </p>
          <p className="mt-1 text-meta text-text-2">
            Enter the whole result again from the start. Everyone watching sees the change.
          </p>
        </div>
      ) : null}

      {showOffer && offered ? (
        <div className="rounded-card border border-accent/30 bg-accent-soft p-4">
          <p className="text-row text-text">
            {offered.length === 1
              ? 'Game 1 is still on this phone'
              : `${offered.length} games are still on this phone`}{' '}
            from earlier:{' '}
            <span className="num">{offered.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ')}</span>
          </p>
          <p className="mt-1 text-meta text-text-2">
            Nothing has been sent yet. This only ever lives on this one phone.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            <button
              type="button"
              onClick={() => {
                setTouched(true)
                setFinished(offered)
              }}
              className="tap-lg rounded-control bg-ink px-5 text-[18px] font-bold text-white"
            >
              Carry on from there
            </button>
            <button
              type="button"
              onClick={() => {
                setTouched(true)
                setFinished([])
                setDraft(emptyDraft)
                if (persistKey) writeDraft(persistKey, [])
              }}
              className="tap text-body font-semibold text-link underline underline-offset-4"
            >
              Start again
            </button>
          </div>
        </div>
      ) : null}

      {/* Finished games stay on screen, one tap from being changed. The row
          itself is no longer the button: a stray thumb used to delete game 2
          while somebody was only scrolling. */}
      {finished.length ? (
        <div className="flex flex-col gap-3">
          {finished.map((g, i) => {
            const gWinner = g.scoreA === g.scoreB ? null : g.scoreA > g.scoreB ? nameA : nameB
            return (
              <div
                key={g.gameNo}
                className="flex items-stretch overflow-hidden rounded-control border border-line-strong bg-paper"
              >
                <span
                  aria-hidden
                  className={clsx(
                    'w-1 shrink-0',
                    g.scoreA > g.scoreB
                      ? 'bg-side-a'
                      : g.scoreB > g.scoreA
                        ? 'bg-side-b'
                        : 'bg-line-strong',
                  )}
                />
                <div className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-2.5">
                  <span className="font-score shrink-0 text-eyebrow text-text-2 uppercase">
                    Game {g.gameNo}
                  </span>
                  <span className="num shrink-0 text-[22px] font-bold text-text">
                    {g.scoreA}–{g.scoreB}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-meta text-text-2">{gWinner}</span>
                  {g.timeCapped ? <Tag tone="waiting">Horn</Tag> : null}
                </div>
                <button
                  type="button"
                  onClick={() => changeGame(i)}
                  aria-label={`Change game ${g.gameNo}, currently ${g.scoreA}–${g.scoreB}`}
                  className="tap shrink-0 border-l border-line-strong px-4 text-body font-semibold text-link"
                >
                  Change
                </button>
              </div>
            )
          })}
        </div>
      ) : null}

      {capped ? (
        <div className="rounded-card border border-line-strong bg-paper p-4">
          <p className="text-section text-text">Game {gameNo} — the horn went</p>
          <p className="mt-1 text-meta text-text-2">
            Record it at the score it stopped on. It counts as a game won, and it stays out of point
            difference.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block truncate text-meta text-text-2">{nameA}</span>
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                className="num h-14 text-[24px] font-bold"
                value={capped.a}
                onChange={(e) => setCapped({ ...capped, a: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="block truncate text-meta text-text-2">{nameB}</span>
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                className="num h-14 text-[24px] font-bold"
                value={capped.b}
                onChange={(e) => setCapped({ ...capped, b: e.target.value })}
              />
            </label>
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <button
              type="button"
              onClick={() => {
                const a = Number(capped.a)
                const b = Number(capped.b)
                if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) {
                  setError('Enter both scores.')
                  return
                }
                if (a === b) {
                  setError('A capped game still needs a winner — play the next rally out.')
                  return
                }
                setError(null)
                setTouched(true)
                setFinished([...finished, { gameNo, scoreA: a, scoreB: b, timeCapped: true }])
                setCapped(null)
              }}
              className="tap-lg rounded-control bg-ink px-5 text-[18px] font-bold text-white"
            >
              Record game {gameNo}
            </button>
            <button
              type="button"
              onClick={() => setCapped(null)}
              className="tap text-body font-semibold text-link underline underline-offset-4"
            >
              Never mind
            </button>
          </div>
        </div>
      ) : special?.kind === 'retired' && special.side ? (
        <div className="rounded-card border border-line-strong bg-paper p-4">
          <p className="text-section text-text">
            {special.side === 'A' ? nameA : nameB} couldn’t carry on.
          </p>
          <p className="mt-1 text-body text-text-2">
            {special.side === 'A' ? nameB : nameA} go through. Put in the score the game had reached,
            so the points they did win still count.
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block truncate text-meta text-text-2">{nameA}</span>
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                className="num h-14 text-[24px] font-bold"
                value={stoppedAt.a}
                onChange={(e) => setStoppedAt({ ...stoppedAt, a: e.target.value })}
              />
            </label>
            <label className="block">
              <span className="block truncate text-meta text-text-2">{nameB}</span>
              <Input
                type="number"
                min={0}
                inputMode="numeric"
                className="num h-14 text-[24px] font-bold"
                value={stoppedAt.b}
                onChange={(e) => setStoppedAt({ ...stoppedAt, b: e.target.value })}
              />
            </label>
          </div>
          <p className="mt-2 text-meta text-text-2">
            Leave both blank if they stopped between games. Games nobody played stay out of point
            difference.
          </p>
          <button
            type="button"
            onClick={() => setSpecial(null)}
            className="tap mt-2 text-body font-semibold text-link underline underline-offset-4"
          >
            Never mind
          </button>
        </div>
      ) : special?.kind === 'walkover' && special.side ? (
        <div className="rounded-card border border-line-strong bg-paper p-4">
          <p className="text-section text-text">
            {special.side === 'A' ? nameA : nameB} didn’t turn up.
          </p>
          <p className="mt-1 text-body text-text-2">
            {special.side === 'A' ? nameB : nameA} go through. Recorded as a no-show — it won’t count
            towards points scored.
          </p>
          <button
            type="button"
            onClick={() => setSpecial(null)}
            className="tap mt-2 text-body font-semibold text-link underline underline-offset-4"
          >
            Never mind
          </button>
        </div>
      ) : special && !special.side ? // "Who didn't turn up?" is the only question on screen
        null : !complete && !hornEnded ? (
        <div className="flex flex-col gap-5">
          <p className="font-score text-eyebrow text-text-2 uppercase">Game {gameNo}</p>

          <div>
            <p className="text-section text-text">Who won game {gameNo}?</p>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <SideButton
                label={nameA}
                side="A"
                selected={draft.winner === 'A'}
                onClick={() => pickWinner('A')}
              />
              <SideButton
                label={nameB}
                side="B"
                selected={draft.winner === 'B'}
                onClick={() => pickWinner('B')}
              />
            </div>
            <button
              type="button"
              onClick={() => setSheet(true)}
              className="tap mt-3 text-left text-body font-semibold text-link underline underline-offset-4"
            >
              They didn’t play it out
            </button>
          </div>

          {draft.winner ? (
            <div>
              <p className="text-section text-text">{winnerSideName}’s score</p>
              <div className="mt-3 grid grid-cols-5 gap-2.5">
                {(showMore ? [...wChips.chips, ...wChips.more] : wChips.chips).map((n) => (
                  <Chip
                    key={n}
                    value={n}
                    selected={draft.winnerScore === n}
                    suggested={n === rules.pointsToWin}
                    label={`${winnerSideName} scored ${n}`}
                    onClick={() => {
                      setDraft({ ...draft, winnerScore: n })
                      setShowAllLoser(false)
                      setOdd(null)
                    }}
                  />
                ))}
              </div>
              {wChips.more.length && !showMore ? (
                <button
                  type="button"
                  onClick={() => setShowMore(true)}
                  className="tap mt-3 text-body font-semibold text-link underline underline-offset-4"
                >
                  They scored more than {wChips.chips[wChips.chips.length - 1]}
                </button>
              ) : null}
            </div>
          ) : null}

          {draft.winnerScore !== null ? (
            <div>
              <p className="text-section text-text">And {loserSideName}?</p>
              {/* The pre-selected target is stated at the exact moment of the
                  tap that commits it, so it is never a silent assumption. */}
              <p className="mt-1 text-meta text-text-2">
                <span className="num text-text">{draft.winnerScore}</span> to {winnerSideName} — tap
                a different number above if that’s wrong.
              </p>
              {odd ? (
                <div className="mt-3 rounded-card border border-waiting/40 bg-waiting-soft p-4">
                  <p className="text-row text-text">{odd.reason}</p>
                  <p className="mt-1 text-meta text-text-2">
                    It can still go in — the organiser sees why it was flagged.
                  </p>
                  <div className="mt-3 flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={() => commitGame(odd.score, true)}
                      className="tap-lg rounded-control bg-ink px-5 text-[18px] font-bold text-white"
                    >
                      Keep {draft.winnerScore}–{odd.score}
                    </button>
                    <button
                      type="button"
                      onClick={() => setOdd(null)}
                      className="tap text-body font-semibold text-link underline underline-offset-4"
                    >
                      Pick another number
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="mt-3 grid grid-cols-5 gap-2.5">
                    {lChips.map((n) => (
                      <Chip
                        key={n}
                        value={n}
                        selected={false}
                        wide={lChips.length === 1}
                        label={`${loserSideName} scored ${n}`}
                        onClick={() => commitGame(n)}
                      />
                    ))}
                  </div>
                  {lChips.length === 1 ? (
                    <p className="mt-2 text-meta text-text-2">
                      {explainSingleChip(rules, draft.winnerScore, lChips[0])}
                    </p>
                  ) : null}
                  {!showAllLoser ? (
                    <button
                      type="button"
                      onClick={() => setShowAllLoser(true)}
                      className="tap mt-3 text-body font-semibold text-link underline underline-offset-4"
                    >
                      Their score isn’t here
                    </button>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </div>
      ) : (
        <div className="rounded-card border-2 border-ink bg-paper p-4">
          <p className="font-score text-eyebrow text-text-2 uppercase">That’s the match</p>
          <p className="mt-1 text-title text-text">
            {winnerName} win {outcome.gamesWonA}–{outcome.gamesWonB}
          </p>
          <p className="num mt-1 text-[22px] font-bold text-text-2">{scoreLine}</p>
          {hornEnded ? (
            <p className="mt-1.5 text-meta text-text-2">
              Stopped on time. The capped game keeps its points and sits out of point difference.
            </p>
          ) : null}
        </div>
      )}

      {correcting && readyToSend ? (
        <label className="block">
          <span className="text-section text-text">What changed?</span>
          <Input
            className="mt-2 h-14"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Wrong game 2 score — was 11–9, not 9–11"
          />
          <span className="mt-1 block text-meta text-text-2">
            Saved with your name and the time. Players can see that a result was changed.
          </span>
        </label>
      ) : null}

      {readyToSend ? (
        <div ref={submitRef} className="flex flex-col gap-3">
          {props.authoritative ? (
            <HoldButton disabled={busy} onComplete={() => send(null)} holdLabel="Hold">
              <span className="text-[20px] font-bold">
                {busy ? 'Saving…' : 'Hold to save the result'}
              </span>
            </HoldButton>
          ) : (
            <>
              {/*
               * "Who's submitting?" used to be its own tap, then a second tap to
               * hold. Merging them removes a tap and puts the choice of side at
               * the moment of the hold rather than thirty seconds before it —
               * which is also when the person holding the phone is thinking
               * about it.
               */}
              <p className="text-section text-text">Who’s putting this in?</p>
              <p className="-mt-1 text-meta text-text-2">
                Hold your own name for a moment, then hand the phone across the net.
              </p>
              <HoldButton
                side="A"
                disabled={busy}
                onComplete={() => send('A')}
                holdLabel={busy && sendingSide === 'A' ? 'Sending' : 'Hold'}
              >
                <span className="block text-[19px] leading-tight font-bold">{nameA}</span>
              </HoldButton>
              <HoldButton
                side="B"
                disabled={busy}
                onComplete={() => send('B')}
                holdLabel={busy && sendingSide === 'B' ? 'Sending' : 'Hold'}
              >
                <span className="block text-[19px] leading-tight font-bold">{nameB}</span>
              </HoldButton>
            </>
          )}
        </div>
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
            <div className="mt-3 flex flex-col gap-3">
              <button
                type="button"
                onClick={() => {
                  setTouched(true)
                  setSpecial({ kind: 'walkover', side: null })
                  setSheet(false)
                }}
                className={clsx(
                  'tap-xl rounded-control bg-paper px-4 text-left text-row text-text',
                  KEY_EDGE,
                )}
              >
                One side didn’t turn up
              </button>
              <button
                type="button"
                onClick={() => {
                  setTouched(true)
                  setSpecial({ kind: 'retired', side: null })
                  setSheet(false)
                }}
                className={clsx(
                  'tap-xl rounded-control bg-paper px-4 text-left text-row text-text',
                  KEY_EDGE,
                )}
              >
                Someone couldn’t carry on
              </button>
              <button
                type="button"
                onClick={() => {
                  setTouched(true)
                  setCapped({ a: '', b: '' })
                  setSheet(false)
                }}
                className={clsx(
                  'tap-xl rounded-control bg-paper px-4 text-left text-row text-text',
                  KEY_EDGE,
                )}
              >
                The horn went — stopped on time
              </button>
              <button
                type="button"
                onClick={() => setSheet(false)}
                className="tap rounded-control px-4 text-left text-body font-semibold text-link"
              >
                Never mind
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {special && !special.side ? (
        <div className="rounded-card border border-line-strong bg-paper p-4">
          <p className="text-section text-text">
            {special.kind === 'walkover' ? 'Who didn’t turn up?' : 'Who stopped?'}
          </p>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <SideButton
              label={nameA}
              side="A"
              selected={false}
              onClick={() => setSpecial({ kind: special.kind, side: 'A' })}
            />
            <SideButton
              label={nameB}
              side="B"
              selected={false}
              onClick={() => setSpecial({ kind: special.kind, side: 'B' })}
            />
          </div>
          <button
            type="button"
            onClick={() => setSpecial(null)}
            className="tap mt-3 text-body font-semibold text-link underline underline-offset-4"
          >
            Never mind
          </button>
        </div>
      ) : null}

      {hornEnded && !complete ? (
        <p className="rounded-control bg-waiting-soft px-3.5 py-3 text-body font-medium text-waiting">
          Level on games and level on points. Nothing here can call this one — the organiser decides,
          and records it as a correction.
        </p>
      ) : finished.length > 0 && !complete ? (
        <p className="text-meta text-text-2">
          Best of {rules.bestOf} to {rules.pointsToWin} — first to {need} games.
        </p>
      ) : null}
    </div>
  )
}
