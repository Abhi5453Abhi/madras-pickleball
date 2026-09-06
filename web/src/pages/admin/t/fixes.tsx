import { clsx } from 'clsx'
import { useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import type { Output } from '@/api/contract'
import { Card, Chevron, Confirm, Notice, Tag, TeamName } from '@/components/ui'
import { SECONDARY_LINK } from '@/components/admin-ui'

/**
 * The screens behind More — one per row of the list.
 *
 * Two rules hold across all of them. Nothing fires on one tap. And nothing
 * asks "are you sure?" — every confirm says the actual consequence in
 * numbers, because the organiser is standing in front of the person asking
 * and a quantity is an answer where a warning is not.
 */

const INK_BUTTON = 'tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white'
const FIELD = 'tap w-full rounded-control border border-line-key bg-paper px-3.5 text-body text-text'

/** The bounded confirm card from the mockup: a bold line, the consequence, the two buttons. */
function ConfirmCard({
  title,
  children,
  action,
  notNow,
}: {
  /** Left out where the page title already says it. */
  title?: string
  children: ReactNode
  action?: ReactNode
  notNow: string
}) {
  return (
    <div className="rounded-card border-2 border-ink bg-paper p-4 shadow-card">
      {title ? <p className="text-row text-text">{title}</p> : null}
      <div className={clsx('text-body text-text-2', title && 'mt-1')}>{children}</div>
      {action ? <div className="mt-3">{action}</div> : null}
      <Link to={notNow} className={`${SECONDARY_LINK} mt-2`}>
        Not now
      </Link>
    </div>
  )
}

// ───────────────────────── fix a score ─────────────────────────

export type PlayedMatch = {
  id: string
  roundName: string | null
  winner: string
  loser: string
  games: string
  scoreLine: string
  walkover: boolean
}

export function FixScore({ played }: { played: PlayedMatch[] }) {
  if (!played.length) {
    return <p className="text-body text-text-2">Nothing has a score yet.</p>
  }
  return (
    <>
      <p className="text-meta text-text-3">Newest first. Tap one to change it — it asks why.</p>
      <Card>
        <ul className="divide-y divide-line">
          {played.map((m) => (
            <li key={m.id}>
              <Link to={`/admin/m/${m.id}`} className="tap-lg flex items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1">
                  <span className="block text-row text-text">{m.winner}</span>
                  <span className="block text-meta text-text-3">
                    {m.walkover ? 'walkover against' : 'beat'} {m.loser}
                    {m.roundName ? ` · ${m.roundName}` : ''}
                  </span>
                </span>
                <span className="num shrink-0 text-right">
                  {m.walkover ? (
                    <span className="block text-meta text-text-3">Walkover</span>
                  ) : (
                    <>
                      <span className="block text-row text-text">{m.games}</span>
                      {m.scoreLine ? <span className="block text-meta text-text-3">{m.scoreLine}</span> : null}
                    </>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </Card>
    </>
  )
}

// ───────────────────────── a pair has pulled out ─────────────────────────

export type WithdrawRow = {
  teamId: string
  name: string
  players: string[]
  withdrawn: boolean
}

export type WithdrawDetail = {
  teamId: string
  name: string
  withdrawn: boolean
  /** Matches they have played, which stand either way. */
  played: number
  /** Matches they have left, which become walkovers to the other side. */
  toWalkover: number
  /** A final waiting on the other semi: nobody to give a walkover to, they just come off. */
  vacates: number
  /** A match of theirs on court right now — the server refuses until it ends. */
  blockedBy: string | null
}

/** What a withdrawal costs, in counts, before it happens. */
function withdrawalSentence(w: WithdrawDetail, unit: string): string {
  if (w.played === 0 && w.toWalkover === 0 && w.vacates === 0) {
    return 'They have no matches in the schedule yet, so nothing moves — this only marks them as out.'
  }
  const parts: string[] = []
  parts.push(
    w.played === 0
      ? 'They have not played anything yet.'
      : `The ${w.played} ${w.played === 1 ? 'match' : 'matches'} they played ${
          w.played === 1 ? 'stands' : 'stand'
        }.`,
  )
  if (w.toWalkover > 0) {
    parts.push(
      `The ${w.toWalkover} they had left ${
        w.toWalkover === 1 ? 'becomes a walkover' : 'become walkovers'
      } to the other ${unit} — a win for them, but no points added, so it can’t decide the table.`,
    )
  }
  if (w.vacates > 0) {
    parts.push(
      `They ${w.toWalkover > 0 ? 'also ' : ''}come off ${
        w.vacates === 1 ? 'the match' : `${w.vacates} matches`
      } they were only pencilled into, which ${w.vacates === 1 ? 'goes' : 'go'} back to waiting.`,
    )
  }
  if (w.toWalkover === 0 && w.vacates === 0) parts.push('They have nothing left to play.')
  return parts.join(' ')
}

export function Withdraw({
  slug,
  rows,
  selected,
  unit,
  onWithdraw,
  onReinstate,
}: {
  slug: string
  rows: WithdrawRow[]
  selected: WithdrawDetail | null
  unit: 'pair' | 'player'
  onWithdraw: (e: FormEvent<HTMLFormElement>, teamId: string) => void
  onReinstate: (e: FormEvent<HTMLFormElement>, teamId: string) => void
}) {
  const here = `/admin/t/${slug}/more?do=withdraw`
  if (!rows.length) {
    return <p className="text-body text-text-2">No {unit}s yet — make the teams first.</p>
  }
  return (
    <>
      <Card>
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.teamId}>
              <Link
                to={`${here}&team=${r.teamId}`}
                aria-current={selected?.teamId === r.teamId ? 'true' : undefined}
                className={clsx(
                  'tap-lg flex items-center gap-3 px-4 py-2',
                  selected?.teamId === r.teamId && 'bg-sunken',
                )}
              >
                <span className="min-w-0 flex-1">
                  <TeamName name={r.name} players={r.players} muted={r.withdrawn} />
                </span>
                {r.withdrawn ? (
                  <Tag tone="waiting">Out</Tag>
                ) : (
                  <span aria-hidden className="text-text-3">
                    <Chevron className="-rotate-90" />
                  </span>
                )}
              </Link>
            </li>
          ))}
        </ul>
      </Card>

      {selected ? (
        selected.withdrawn ? (
          <ConfirmCard
            title={`${selected.name} go back in`}
            notNow={here}
            action={
              <form onSubmit={(e) => onReinstate(e, selected.teamId)}>
                <button className={INK_BUTTON}>Put them back</button>
              </form>
            }
          >
            Any match given away when they pulled out is undone and goes back in the queue. The
            matches they actually played are untouched.
          </ConfirmCard>
        ) : selected.blockedBy ? (
          <ConfirmCard title={`${selected.name} pull out`} notNow={here}>
            {selected.blockedBy} is on court right now. Let it finish, or take it off court, then
            come back here.
          </ConfirmCard>
        ) : (
          <ConfirmCard
            title={`${selected.name} pull out`}
            notNow={here}
            action={
              <form onSubmit={(e) => onWithdraw(e, selected.teamId)}>
                <button className={INK_BUTTON}>Yes, they&rsquo;re out</button>
              </form>
            }
          >
            {withdrawalSentence(selected, unit)} You can put them back.
          </ConfirmCard>
        )
      ) : null}
    </>
  )
}

// ───────────────────────── swap a player ─────────────────────────

type SubstituteTarget = Output<'chaos.substitutionOptions'>[number]

export function Swap({
  slug,
  teams,
  roster,
  onSwap,
}: {
  slug: string
  teams: SubstituteTarget[]
  roster: Array<{ id: string; name: string }>
  onSwap: (e: FormEvent<HTMLFormElement>, out: string, inPlayer: string) => void
}) {
  const [out, setOut] = useState('')
  const [going, setGoing] = useState('')

  if (!teams.length) {
    return <p className="text-body text-text-2">No pairs yet — make the teams first.</p>
  }
  if (!roster.length) {
    return (
      <p className="text-body text-text-2">
        Everyone on the list is already in a pair. Add the substitute under{' '}
        <Link to={`/admin/t/${slug}/registration`} className="font-semibold text-link">
          Registration
        </Link>{' '}
        first.
      </p>
    )
  }
  return (
    <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
      <p className="text-body text-text-2">
        The pair keeps its results and its place in the table. Only the name changes — everywhere at
        once. Whoever is stepping in has to be on the players list first.
      </p>
      <form onSubmit={(e) => onSwap(e, out, going)} className="mt-4 flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="sub-out" className="block text-row text-text">
            Who is coming out
          </label>
          {/* One select of optgroups, not two: "Ravi, from a pair Ravi is not
              in" is a state two selects can reach and one cannot. */}
          <select
            id="sub-out"
            name="out"
            required
            value={out}
            onChange={(e) => setOut(e.target.value)}
            className={FIELD}
          >
            <option value="" disabled>
              Pick a player
            </option>
            {teams.map((t) => (
              <optgroup key={t.teamId} label={t.teamName}>
                {t.members.map((m) => (
                  <option key={m.id} value={`${t.teamId}:${m.id}`}>
                    {m.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="sub-in" className="block text-row text-text">
            Who is going in
          </label>
          <select
            id="sub-in"
            name="in"
            required
            value={going}
            onChange={(e) => setGoing(e.target.value)}
            className={FIELD}
          >
            <option value="" disabled>
              Pick a player
            </option>
            {roster.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <Confirm
          label="Make the swap"
          question="The name changes on the board, the table and the public page straight away. Matches already played stay as they were."
        >
          <button className={INK_BUTTON}>Yes, swap them</button>
        </Confirm>
      </form>
    </div>
  )
}

// ───────────────────────── shorten what's left ─────────────────────────

export type ShortenOption = {
  bestOf: number
  pointsToWin: number
  label: string
  /** Venue time the day would finish at, if this changed. */
  finishAt: string | null
  savedMinutes: number
}

export type ShortenView = {
  currentLabel: string
  outstanding: number
  live: boolean
  options: ShortenOption[]
}

export function Shorten({
  view,
  onShorten,
}: {
  view: ShortenView
  onShorten: (e: FormEvent<HTMLFormElement>, bestOf: number, pointsToWin: number) => void
}) {
  if (view.outstanding === 0) {
    return <p className="text-body text-text-2">Nothing is left to shorten — everything has been played.</p>
  }
  if (view.live) {
    return (
      <Notice tone="waiting" title="Not yet">
        A match is on court. Change it when that one finishes.
      </Notice>
    )
  }
  if (!view.options.length) {
    return (
      <p className="text-body text-text-2">
        What&rsquo;s left is already {view.currentLabel.toLowerCase()} — it can&rsquo;t get shorter.
      </p>
    )
  }
  return (
    <>
      <p className="text-meta text-text-3">
        {view.currentLabel} now · {view.outstanding} still to play. Scores already in are not changed.
      </p>
      <div className="flex flex-col gap-3">
        {view.options.map((o) => (
          <Confirm
            key={o.label}
            label={o.label}
            question={`The ${view.outstanding} ${
              view.outstanding === 1 ? 'match' : 'matches'
            } nobody has started ${view.outstanding === 1 ? 'becomes' : 'become'} ${o.label.toLowerCase()}.${
              o.finishAt
                ? ` The day finishes about ${o.finishAt} instead — ${Math.round(o.savedMinutes)} minutes back.`
                : ''
            }`}
          >
            <form onSubmit={(e) => onShorten(e, o.bestOf, o.pointsToWin)}>
              <button className={INK_BUTTON}>Change it to {o.label.toLowerCase()}</button>
            </form>
          </Confirm>
        ))}
      </div>
    </>
  )
}

// ───────────────────────── pause / start again ─────────────────────────

export function Pause({
  pauseNote,
  onPause,
  onResume,
}: {
  pauseNote: string | null
  onPause: (e: FormEvent<HTMLFormElement>, note: string) => void
  onResume: (e: FormEvent<HTMLFormElement>) => void
}) {
  const [note, setNote] = useState('Rain — back shortly')

  if (pauseNote) {
    return (
      <Notice
        tone="waiting"
        title="Paused"
        detail="The public page is showing this, so nobody is staring at a board that has not moved."
        action={
          <form onSubmit={onResume}>
            <button className={INK_BUTTON}>Start again</button>
          </form>
        }
      >
        {pauseNote}
      </Notice>
    )
  }
  return (
    <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
      <p className="text-body text-text-2">
        Matches already on court carry on. Nothing else goes on until you start again, and the public
        page says why.
      </p>
      <form onSubmit={(e) => onPause(e, note)} className="mt-4 flex flex-col gap-2">
        <label htmlFor="pause-note" className="block text-row text-text">
          What everybody is waiting for
        </label>
        <input
          id="pause-note"
          name="note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={FIELD}
        />
        <button className={INK_BUTTON}>Pause it</button>
      </form>
    </div>
  )
}

// ───────────────────────── delete ─────────────────────────

export function DeleteTournament({
  slug,
  name,
  players,
  matches,
  courts,
  liveOn,
  onDelete,
}: {
  slug: string
  name: string
  players: number
  matches: number
  courts: string[]
  /** The court a match is on right now, if any — the delete is refused. */
  liveOn: string | null
  onDelete: (e: FormEvent<HTMLFormElement>) => void
}) {
  const back = `/admin/t/${slug}/more`
  if (liveOn) {
    return (
      <ConfirmCard notNow={back}>
        There is a match on {liveOn} right now. Let it finish, or take it off court, then delete.
      </ConfirmCard>
    )
  }
  return (
    <ConfirmCard
      notNow={back}
      action={
        <form onSubmit={onDelete}>
          <button className={INK_BUTTON}>Yes, delete it</button>
        </form>
      }
    >
      {name} comes off every list and its public page stops working.{' '}
      {players ? `Its ${players} ${players === 1 ? 'player' : 'players'}` : 'Its sign-up link'}
      {matches ? ` and ${matches} ${matches === 1 ? 'match' : 'matches'}` : ''}{' '}
      {matches || (players && players !== 1) ? 'go' : 'goes'} with it.
      {courts.length
        ? ` ${courts.join(', ')} ${courts.length === 1 ? 'comes' : 'come'} free for the day.`
        : ''}
    </ConfirmCard>
  )
}
