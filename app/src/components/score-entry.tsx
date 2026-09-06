'use client'

import { clsx } from 'clsx'
import { useRouter } from 'next/navigation'
import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
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
  type GameScore,
  type ScoringRules,
} from '@/lib/rules'
import { Input, NetRule, Tag, splitTeam } from './ui'

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

/**
 * `type="number"` is not a number: it accepts "1e3", "+5" and "  7 ", and
 * `Number()` turns the first of those into a thousand points. Two digits, no
 * sign, no exponent — and the field itself is text with a numeric keypad, so
 * the browser stops offering the spinner nobody wants on a wet screen.
 */
function points(raw: string): number | null {
  if (!/^\d{1,2}$/.test(raw.trim())) return null
  return Number(raw)
}

// ────────────────────────────────── pieces ──────────────────────────────────

/**
 * `line-strong` measures 1.6:1 against paper. On a card that is a boundary
 * nobody needs to find; on a 64px number chip in direct sun it is the only
 * thing saying where the target is, and 1.6:1 is not a target edge.
 * `line-key` is the token globals.css added for exactly this — 4.07:1 on
 * paper — and it is drawn at 2px here rather than 1: the boundary of a numeric
 * target found with a wet thumb is worth the extra pixel, and nothing else on
 * the screen competes with it.
 */
const KEY_EDGE = 'border-2 border-line-key'

function Chip({
  value,
  selected,
  suggested,
  onClick,
  wide,
  label,
  toggle,
}: {
  value: number
  selected: boolean
  suggested?: boolean
  onClick: () => void
  wide?: boolean
  label?: string
  /**
   * The winner's score chips ARE a toggle — one of them stays chosen and you
   * can change your mind. The other side's chips are not: tapping one commits
   * the game and destroys the grid, so it can never be found in a pressed
   * state, and announcing "not pressed" on a button that cannot be pressed is
   * a lie about what the control does.
   */
  toggle?: boolean
}) {
  return (
    <button
      type="button"
      aria-pressed={toggle ? selected : undefined}
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

/**
 * The button that decides who won the game, so it has to say who it is.
 *
 * `line-clamp-2` on one 17px line rendered "Lakshmi Narayanan /…" in a 173px
 * column — the half of the pair that identifies them, cut off, on the control
 * that attributes the win. `TeamName` in ui.tsx solved this for rows by
 * stacking the two players; it hard-codes `text-text`, which is invisible on
 * the ink fill this button takes when selected, so the same `splitTeam` split
 * is done here and coloured with the button.
 */
function SideButton({
  label,
  side,
  selected,
  onClick,
  toggle,
}: {
  label: string
  side: 'A' | 'B'
  selected: boolean
  onClick: () => void
  /** False where picking a side is an action, not a state you can come back to. */
  toggle?: boolean
}) {
  const parts = splitTeam(label)
  return (
    <button
      type="button"
      aria-pressed={toggle ? selected : undefined}
      onClick={onClick}
      className={clsx(
        'flex min-h-[88px] flex-col justify-center gap-0.5 rounded-control border-l-4 px-3.5 py-3',
        'text-left transition-colors duration-100 active:translate-y-px',
        side === 'A' ? 'border-l-side-a' : 'border-l-side-b',
        selected ? 'bg-ink text-white ring-2 ring-ink' : clsx(KEY_EDGE, 'bg-paper text-text'),
      )}
    >
      {(parts.length ? parts : [label]).map((p, i) => (
        <span key={`${p}-${i}`} className="block text-row break-words hyphens-auto">
          {p}
        </span>
      ))}
    </button>
  )
}

/**
 * A points box with the pair's names beside it, unabbreviated.
 *
 * The two boxes used to be side by side under `truncate`d labels — "Divya
 * Natarajan / Nit…" and "Priya Ramesh / Laks…" over two identical empty
 * fields, on the fiddliest path in the product, with nothing saying which
 * number went where.
 */
function PointsField({
  team,
  side,
  value,
  onChange,
}: {
  team: string
  side: 'A' | 'B'
  value: string
  onChange: (v: string) => void
}) {
  const id = useId()
  const parts = splitTeam(team)
  return (
    <div className="flex items-center gap-3 rounded-control border border-line-strong bg-paper p-2.5">
      <span
        aria-hidden
        className={clsx('w-1 self-stretch rounded-full', side === 'A' ? 'bg-side-a' : 'bg-side-b')}
      />
      <label htmlFor={id} className="min-w-0 flex-1">
        <span className="block text-meta text-text-2">Points for</span>
        {(parts.length ? parts : [team]).map((p, i) => (
          <span key={`${p}-${i}`} className="block text-row break-words text-text">
            {p}
          </span>
        ))}
      </label>
      {/* A ring, not a heavier border: `ring` is box-shadow, so it cannot lose
          a specificity argument with the 1px `border` the shared Input already
          carries. The width is on a wrapper for the same reason: the shared
          Input's `w-full` is generated after `w-20` and won, so the box took
          the whole row and the pair's name beside it came out one letter per
          line. */}
      <span className="w-20 shrink-0">
        <Input
          id={id}
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          maxLength={2}
          autoComplete="off"
          className="num h-14 text-center text-[26px] font-bold ring-2 ring-line-key"
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </span>
    </div>
  )
}

/** The two players, one per line, in whatever colour the surface asks for. */
function StackedName({ name }: { name: string }) {
  const parts = splitTeam(name)
  return (
    <>
      {(parts.length ? parts : [name]).map((p, i) => (
        <span key={`${p}-${i}`} className="block text-[19px] leading-tight font-bold break-words">
          {p}
        </span>
      ))}
    </>
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
 *
 * The KEYBOARD does not hold. Enter used to fire `onComplete` on one keypress,
 * so the one control on the screen that exists because "a single tap is not
 * consent" had no confirmation at all for a keyboard or switch user — and the
 * only hint it gave them was the word HOLD in its accessible name, which is
 * advice they cannot take. They get the accessible equivalent instead: press
 * once to arm, press again to send, and the button says so.
 *
 * The meter is the other half. `accent-line` at 70% over ink composites to
 * #a24f3a, which is 2.09:1 against the button it sits on — under the 3:1 that
 * WCAG 1.4.11 asks of a graphic carrying information, and globals.css exempts
 * this meter from reduced-motion precisely BECAUSE it carries information.
 * Nothing terracotta clears 3:1 on ink and still reads white text on top, so
 * the two jobs are separated: the label keeps plain ink under it at 11.8:1,
 * and the progress is a 10px bar of `accent-on-ink` — 5.06:1, the token that
 * exists for exactly this surface.
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
  const [armed, setArmed] = useState(false)
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  const armTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hintId = useId()

  const stop = () => {
    if (timer.current) clearInterval(timer.current)
    timer.current = null
    setProgress(0)
  }

  const disarm = () => {
    if (armTimer.current) clearTimeout(armTimer.current)
    armTimer.current = null
    setArmed(false)
  }

  // Both outlive the component if a submit navigates away mid-press.
  useEffect(
    () => () => {
      if (timer.current) clearInterval(timer.current)
      if (armTimer.current) clearTimeout(armTimer.current)
    },
    [],
  )

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

  const hint = armed ? 'Press again' : progress > 0 ? 'Keep holding' : holdLabel

  return (
    <div>
      <button
        type="button"
        disabled={disabled}
        aria-describedby={hintId}
        style={{ touchAction: 'none' }}
        onPointerDown={start}
        onPointerUp={stop}
        onPointerLeave={stop}
        onPointerCancel={stop}
        onBlur={disarm}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return
          // Space would scroll and Enter would fire a click; neither is the
          // gesture this button takes.
          e.preventDefault()
          if (disabled) return
          if (armed) {
            disarm()
            onComplete()
            return
          }
          setArmed(true)
          if (armTimer.current) clearTimeout(armTimer.current)
          // Long enough to read the change, short enough that an arm left
          // behind cannot be completed by an unrelated keypress a minute later.
          armTimer.current = setTimeout(() => {
            armTimer.current = null
            setArmed(false)
          }, 6000)
        }}
        className={clsx(
          'relative w-full overflow-hidden rounded-control bg-ink px-4 pt-3.5 pb-5 text-left text-white',
          'min-h-[76px] disabled:opacity-60',
          side === 'A' && 'border-l-4 border-l-side-a',
          side === 'B' && 'border-l-4 border-l-side-b',
        )}
      >
        <span className="relative flex items-center justify-between gap-3">
          <span className="min-w-0">{children}</span>
          {hint ? (
            <span
              aria-hidden
              className="font-score shrink-0 text-eyebrow text-white uppercase"
            >
              {hint}
            </span>
          ) : null}
          {/* The name changes while focus is on it, which is how a screen
              reader hears that the first press did something. */}
          {armed ? <span className="sr-only">Armed. Press again to send.</span> : null}
        </span>
        <span aria-hidden className="absolute inset-x-0 bottom-0 h-2.5 overflow-hidden">
          <span
            style={{ transform: `scaleX(${progress})` }}
            className="block h-full w-full origin-left bg-accent-on-ink"
          />
        </span>
      </button>
      <span id={hintId} className="sr-only">
        Hold it down for a moment, or press it twice.
      </span>
    </div>
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

  /**
   * Where focus goes when a step finishes, and what is said about it.
   *
   * Committing a game unmounts the grid that had focus, and `activeElement`
   * fell back to BODY — so a switch or keyboard user Tabbed from the top of
   * the document after every single game, and nothing anywhere on this screen
   * announced that a score had gone in at all. The counter is what makes two
   * requests for the same target both fire; resetting the target inside the
   * effect would be a setState in an effect.
   */
  const [focusReq, setFocusReq] = useState<{ target: 'game' | 'loser' | 'panel' | 'result'; n: number } | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const gameHeadRef = useRef<HTMLHeadingElement | null>(null)
  const loserHeadRef = useRef<HTMLHeadingElement | null>(null)
  const panelHeadRef = useRef<HTMLHeadingElement | null>(null)
  const resultHeadRef = useRef<HTMLHeadingElement | null>(null)

  const sheetTriggerRef = useRef<HTMLButtonElement | null>(null)
  const sheetRef = useRef<HTMLDivElement | null>(null)
  const sheetHeadRef = useRef<HTMLHeadingElement | null>(null)
  const sheetTitleId = useId()

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

  useEffect(() => {
    if (!focusReq) return
    const el =
      focusReq.target === 'game'
        ? gameHeadRef.current
        : focusReq.target === 'loser'
          ? loserHeadRef.current
          : focusReq.target === 'panel'
            ? panelHeadRef.current
            : resultHeadRef.current
    el?.focus()
  }, [focusReq])

  // Opening the sheet must put focus inside it: `aria-modal` has just hidden
  // everything behind it from assistive technology, and focus was still on the
  // button back there — pointing at nothing a screen reader could still see.
  useEffect(() => {
    if (!sheet) return
    sheetHeadRef.current?.focus()
  }, [sheet])

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

  /** What a screen reader is told once a step is done, in the words of the day. */
  function say(text: string) {
    setAnnouncement(text)
  }

  function closeSheet() {
    setSheet(false)
    sheetTriggerRef.current?.focus()
  }

  /**
   * `aria-modal` is a promise that the rest of the page is unreachable. Without
   * a trap it was a lie: four Tabs landed on BODY and the fifth walked the page
   * behind the overlay. Escape did nothing at all.
   */
  function sheetKeys(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSheet()
      return
    }
    if (e.key !== 'Tab') return
    const root = sheetRef.current
    if (!root) return
    const items = Array.from(
      root.querySelectorAll<HTMLElement>('button:not([hidden]):not([disabled])'),
    )
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    if (e.shiftKey && (active === first || active === sheetHeadRef.current)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

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
      // A score the rules engine does not recognise, kept anyway: the pair
      // agreed to stop there. That is what a capped game IS, so it is recorded
      // as one — the leader wins it, the points count, and it sits out of point
      // difference because it stopped early through nobody's doing. Without
      // this, "Keep 11-10" produced a game that counted for neither side, the
      // match could never complete, and the server refused every submit
      // forever — so the escape hatch the spec calls "nothing is unrecordable"
      // recorded nothing at all.
      ...(force ? { timeCapped: true } : {}),
    }
    const next = [...finished, g]
    const nextOutcome = next.some((x) => x.timeCapped)
      ? hornOutcome(rules, next)
      : matchOutcome(rules, next)
    setTouched(true)
    setFinished(next)
    setDraft(emptyDraft)
    setShowMore(false)
    setShowAllLoser(false)
    setOdd(null)
    const winnerOfGame = draft.winner === 'A' ? nameA : nameB
    const loserOfGame = draft.winner === 'A' ? nameB : nameA
    say(
      `Game ${g.gameNo} in. ${draft.winnerScore} to ${winnerOfGame}, ${loserScore} to ${loserOfGame}.` +
        (nextOutcome.complete
          ? ' That is the match. Now say who is putting it in.'
          : ` Now game ${g.gameNo + 1}.`),
    )
    setFocusReq((r) => ({ target: nextOutcome.complete ? 'result' : 'game', n: (r?.n ?? 0) + 1 }))
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
      say(`Game ${g.gameNo} open again. Both scores are in the boxes.`)
      setFocusReq((r) => ({ target: 'panel', n: (r?.n ?? 0) + 1 }))
      return
    }
    setCapped(null)
    setDraft({
      winner: g.scoreA > g.scoreB ? 'A' : 'B',
      winnerScore: Math.max(g.scoreA, g.scoreB),
    })
    say(`Game ${g.gameNo} open again. Pick the other side’s score.`)
    setFocusReq((r) => ({ target: 'loser', n: (r?.n ?? 0) + 1 }))
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
      const partA = stoppedAt.a === '' ? 0 : points(stoppedAt.a)
      const partB = stoppedAt.b === '' ? 0 : points(stoppedAt.b)
      // One box filled and the other blank means the other side had none —
      // exactly the case a scorer skips. Treating that as "no partial game"
      // deleted the points the retiring pair had actually scored.
      const anyTyped = stoppedAt.a !== '' || stoppedAt.b !== ''
      const hasPartial = anyTyped && partA !== null && partB !== null
      const played = hasPartial
        ? [...finished, { gameNo: finished.length + 1, scoreA: partA, scoreB: partB }]
        : finished
      // Send only what was PLAYED. The server fills in the games nobody played
      // and decides which of them sit out of the difference columns — that
      // field settles the venue's headline tiebreak, and expanding it here
      // meant the server re-expanded an already-complete list, found nothing
      // to fill in, and marked none of it excluded.
      return {
        games: played,
        resultType: 'retired' as const,
        winnerTeamId: special.side === 'A' ? props.teamBId : props.teamAId,
        retiredTeamId: special.side === 'A' ? props.teamAId : props.teamBId,
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
    if (special?.kind === 'retired' && special.side) {
      const bad = (v: string) => v !== '' && points(v) === null
      if (bad(stoppedAt.a) || bad(stoppedAt.b)) {
        setError('Those boxes take a whole number from 0 to 99.')
        return
      }
    }
    setSendingSide(side)
    setBusy(true)
    setError(null)
    setFailure(null)

    let res: SubmitOutcome
    try {
      res = await props.onSubmit({ ...buildPayload(side), reason: reason.trim() || undefined })
    } catch {
      // A server action throws for two quite different reasons — the phone
      // never reached the site, or the site fell over — and from here they are
      // indistinguishable. `navigator.onLine` settles one of them; blaming the
      // signal for the other one sent people to wait five minutes for better
      // reception from a server returning 500s on full-speed wifi. So it says
      // both, and names the route that does not depend on either.
      const offline = typeof navigator !== 'undefined' && navigator.onLine === false
      setBusy(false)
      setFailure({
        text: offline
          ? 'This phone is offline, so nothing was sent. Everything you typed is still here — try again once it is back on the wifi.'
          : 'That didn’t get through. It could be the signal here, or the site itself. Try it once more; if it fails again, read the score out to the organiser.',
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

  // Null when the horn left it level on games AND level on the game it stopped.
  // Without this branch the screen printed "Arun / Deepa win 1–1" directly
  // above the notice saying nothing here can call it.
  const winnerName =
    outcome.winner === 'A' ? nameA : outcome.winner === 'B' ? nameB : null
  const loserSideName = draft.winner === 'A' ? nameB : nameA
  const winnerSideName = draft.winner === 'A' ? nameA : nameB
  const scoreLine = finished.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ')

  return (
    <div className="flex flex-col gap-5">
      {/* Always mounted: a live region inserted at the same moment as its text
          is not announced by most screen readers. */}
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {announcement}
      </p>
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
                {/* Two lines rather than one truncated one: at 200% zoom a
                    single row put the winning pair's name behind an ellipsis,
                    and the name is the half that says whose 11 it was. */}
                <div className="min-w-0 flex-1 px-3.5 py-2.5">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-score text-eyebrow text-text-2 uppercase">
                      Game {g.gameNo}
                    </span>
                    <span className="num text-[22px] font-bold text-text">
                      {g.scoreA}–{g.scoreB}
                    </span>
                    {g.timeCapped ? <Tag tone="waiting">Horn</Tag> : null}
                  </div>
                  {gWinner ? (
                    <span className="mt-0.5 block text-meta break-words text-text-2">{gWinner}</span>
                  ) : null}
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
          <h2 ref={panelHeadRef} tabIndex={-1} className="text-section text-text">
            Game {gameNo} — the horn went
          </h2>
          <p className="mt-1 text-meta text-text-2">
            Record it at the score it stopped on. It counts as a game won, and it stays out of point
            difference.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            <PointsField
              team={nameA}
              side="A"
              value={capped.a}
              onChange={(v) => setCapped({ ...capped, a: v })}
            />
            <PointsField
              team={nameB}
              side="B"
              value={capped.b}
              onChange={(v) => setCapped({ ...capped, b: v })}
            />
          </div>
          <div className="mt-4 flex flex-col gap-3">
            <button
              type="button"
              onClick={() => {
                const a = points(capped.a)
                const b = points(capped.b)
                if (a === null || b === null) {
                  setError('Put a whole number from 0 to 99 in both boxes.')
                  return
                }
                if (a === b) {
                  setError('A capped game still needs a winner — play the next rally out.')
                  return
                }
                setError(null)
                setTouched(true)
                const next = [...finished, { gameNo, scoreA: a, scoreB: b, timeCapped: true }]
                setFinished(next)
                setCapped(null)
                say(`Game ${gameNo} in at ${a}–${b}. The horn ends the match.`)
                setFocusReq((r) => ({ target: 'result', n: (r?.n ?? 0) + 1 }))
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
          <h2 ref={panelHeadRef} tabIndex={-1} className="text-section text-text">
            {special.side === 'A' ? nameA : nameB} couldn’t carry on.
          </h2>
          <p className="mt-1 text-body text-text-2">
            {special.side === 'A' ? nameB : nameA} go through. Put in the score the game had reached,
            so the points they did win still count.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            <PointsField
              team={nameA}
              side="A"
              value={stoppedAt.a}
              onChange={(v) => setStoppedAt({ ...stoppedAt, a: v })}
            />
            <PointsField
              team={nameB}
              side="B"
              value={stoppedAt.b}
              onChange={(v) => setStoppedAt({ ...stoppedAt, b: v })}
            />
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
          <h2 ref={panelHeadRef} tabIndex={-1} className="text-section text-text">
            {special.side === 'A' ? nameA : nameB} didn’t turn up.
          </h2>
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
            <h2 ref={gameHeadRef} tabIndex={-1} className="text-section text-text">
              Who won game {gameNo}?
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <SideButton
                label={nameA}
                side="A"
                toggle
                selected={draft.winner === 'A'}
                onClick={() => pickWinner('A')}
              />
              <SideButton
                label={nameB}
                side="B"
                toggle
                selected={draft.winner === 'B'}
                onClick={() => pickWinner('B')}
              />
            </div>
            <button
              type="button"
              ref={sheetTriggerRef}
              onClick={() => setSheet(true)}
              className="tap mt-3 text-left text-body font-semibold text-link underline underline-offset-4"
            >
              They didn’t play it out
            </button>
          </div>

          {draft.winner ? (
            <div>
              <h2 className="text-section text-text">{winnerSideName}’s score</h2>
              <div className="mt-3 grid grid-cols-5 gap-2.5">
                {(showMore ? [...wChips.chips, ...wChips.more] : wChips.chips).map((n) => (
                  <Chip
                    key={n}
                    value={n}
                    selected={draft.winnerScore === n}
                    suggested={n === rules.pointsToWin}
                    toggle
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
              <h2 ref={loserHeadRef} tabIndex={-1} className="text-section text-text">
                And {loserSideName}?
              </h2>
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
                        label={`${loserSideName} scored ${n}, and that finishes the game`}
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
                      onClick={() => {
                        setShowAllLoser(true)
                        say(`Every score below ${draft.winnerScore} is now showing.`)
                        setFocusReq((r) => ({ target: 'loser', n: (r?.n ?? 0) + 1 }))
                      }}
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
          <p className="font-score text-eyebrow text-text-2 uppercase">
            {winnerName ? 'That’s the match' : 'Nothing separates them'}
          </p>
          <h2 ref={resultHeadRef} tabIndex={-1} className="mt-1 text-title text-text">
            {winnerName
              ? `${winnerName} win ${outcome.gamesWonA}–${outcome.gamesWonB}`
              : `Level at ${outcome.gamesWonA}–${outcome.gamesWonB}`}
          </h2>
          <p className="num mt-1 text-[22px] font-bold text-text-2">{scoreLine}</p>
          {hornEnded ? (
            <p className="mt-1.5 text-meta text-text-2">
              {/* "Win 1–1" needs the reason next to it, or the side with more
                  points in the match asks why they lost. */}
              {winnerName && outcome.gamesWonA === outcome.gamesWonB
                ? 'Stopped on time, level on games — whoever was ahead when the horn went takes it. '
                : 'Stopped on time. '}
              The capped game keeps its points and sits out of point difference.
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
              <h2 className="text-section text-text">Who’s putting this in?</h2>
              <p className="-mt-1 text-meta text-text-2">
                Hold your own name for a moment, then hand the phone across the net.
              </p>
              <HoldButton
                side="A"
                disabled={busy}
                onComplete={() => send('A')}
                holdLabel={busy && sendingSide === 'A' ? 'Sending' : 'Hold'}
              >
                <StackedName name={nameA} />
              </HoldButton>
              <HoldButton
                side="B"
                disabled={busy}
                onComplete={() => send('B')}
                holdLabel={busy && sendingSide === 'B' ? 'Sending' : 'Hold'}
              >
                <StackedName name={nameB} />
              </HoldButton>
            </>
          )}
        </div>
      ) : null}

      {sheet ? (
        <div className="fixed inset-0 z-30 flex items-end">
          {/* The backdrop is scenery. The dialog below owns the keyboard. */}
          <div
            aria-hidden
            className="absolute inset-0 bg-board/50"
            onClick={closeSheet}
          />
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={sheetTitleId}
            onKeyDown={sheetKeys}
            className="relative w-full rounded-t-[20px] bg-paper p-4 pb-8"
          >
            <h2
              id={sheetTitleId}
              ref={sheetHeadRef}
              tabIndex={-1}
              className="text-section text-text"
            >
              What happened instead?
            </h2>
            <div className="mt-3 flex flex-col gap-3">
              {/* Only before a ball is struck. Once a game is in, the payload
                  sends a generated 11-0 and silently drops the game still
                  showing on screen — and those points are this venue's headline
                  tiebreak. After that it is a retirement, which keeps them. */}
              <button
                type="button"
                hidden={finished.length > 0}
                onClick={() => {
                  setTouched(true)
                  setSpecial({ kind: 'walkover', side: null })
                  setSheet(false)
                  setFocusReq((r) => ({ target: 'panel', n: (r?.n ?? 0) + 1 }))
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
                  setFocusReq((r) => ({ target: 'panel', n: (r?.n ?? 0) + 1 }))
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
                  setFocusReq((r) => ({ target: 'panel', n: (r?.n ?? 0) + 1 }))
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
                onClick={closeSheet}
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
          <h2 ref={panelHeadRef} tabIndex={-1} className="text-section text-text">
            {special.kind === 'walkover' ? 'Who didn’t turn up?' : 'Who stopped?'}
          </h2>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <SideButton
              label={nameA}
              side="A"
              selected={false}
              onClick={() => {
                setSpecial({ kind: special.kind, side: 'A' })
                setFocusReq((r) => ({ target: 'panel', n: (r?.n ?? 0) + 1 }))
              }}
            />
            <SideButton
              label={nameB}
              side="B"
              selected={false}
              onClick={() => {
                setSpecial({ kind: special.kind, side: 'B' })
                setFocusReq((r) => ({ target: 'panel', n: (r?.n ?? 0) + 1 }))
              }}
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
