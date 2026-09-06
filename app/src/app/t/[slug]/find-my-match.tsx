'use client'

import { useMemo, useState, useSyncExternalStore } from 'react'
import { Tag, TeamName } from '@/components/ui'

/**
 * "Find my match" — SPEC A8. The most valuable thing on the public page, and
 * the first thing on it. No login: tap your name once and the answer pins to
 * the top, remembered on this phone so the next visit is already personal.
 *
 * The answer is ONE line, in the largest type on the page, because it is read
 * at arm's length with a paddle in the other hand: "You're on Court 2 now".
 * Everything else in the card is support for that line.
 *
 * Queue position is the number, not minutes. At a club event times always slip,
 * and a player told "25 minutes" who is called in 8 misses their match.
 */

type Player = { id: string; name: string; teamIds: string[] }
type M = {
  id: string
  teamAId: string | null
  teamBId: string | null
  nameA: string | null
  nameB: string | null
  courtName: string | null
  status: string
  state: string
  categoryName: string
  roundName: string | null
  queuePosition: number
  scoreLine: string | null
  winnerSide: 'A' | 'B' | null
  resultType: 'normal' | 'bye' | 'walkover' | 'retired' | 'cancelled'
}
type TableRef = { index: number; name: string }

const KEY = 'mpb.me'

/**
 * Who this phone belongs to, as an external store rather than state written by
 * an effect. The server has no answer, the browser does, and the two have to
 * disagree for one render — `useSyncExternalStore` is the one API that says so
 * out loud instead of hydrating wrong and correcting itself.
 *
 * Every read and write is wrapped: a private window, cleared site data, or a
 * browser set to block storage must not take the page down with it.
 */
let cachedMe: string | null = null
let readOnce = false
const listeners = new Set<() => void>()

function meSnapshot(): string | null {
  if (!readOnce) {
    readOnce = true
    try {
      cachedMe = localStorage.getItem(KEY)
    } catch {
      cachedMe = null
    }
  }
  return cachedMe
}

function setMe(id: string | null) {
  cachedMe = id
  try {
    if (id) localStorage.setItem(KEY, id)
    else localStorage.removeItem(KEY)
  } catch {
    /* remembering is a convenience; the page works without it */
  }
  for (const l of listeners) l()
}

function subscribeMe(onChange: () => void) {
  listeners.add(onChange)
  return () => {
    listeners.delete(onChange)
  }
}

export function FindMyMatch({
  players,
  matches,
  courtsInPlay,
  tableFor,
}: {
  players: Player[]
  matches: M[]
  courtsInPlay: number
  /** teamId → which category table that team is in, for "show my table". */
  tableFor: Record<string, TableRef>
}) {
  const [query, setQuery] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const meId = useSyncExternalStore(subscribeMe, meSnapshot, () => null)

  // A remembered id from a different tournament simply finds nobody, and the
  // picker comes back — no separate "is this still valid" check to keep right.
  const me = players.find((p) => p.id === meId) ?? null

  const shortlist = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return browsing ? players : []
    return players.filter((p) => p.name.toLowerCase().includes(q))
  }, [query, players, browsing])

  // By team id, never by name: a club has two Karthiks and one of them would
  // otherwise be told to go to a court he isn't playing on.
  const mine = useMemo(() => {
    if (!me) return []
    const mineTeams = new Set(me.teamIds)
    return matches.filter(
      (m) => (m.teamAId && mineTeams.has(m.teamAId)) || (m.teamBId && mineTeams.has(m.teamBId)),
    )
  }, [me, matches])

  const myTeams = useMemo(() => new Set(me?.teamIds ?? []), [me])
  const iAm = (m: M): 'A' | 'B' => (m.teamAId && myTeams.has(m.teamAId) ? 'A' : 'B')
  const opponentOf = (m: M) => (iAm(m) === 'A' ? m.nameB : m.nameA)

  const onCourt = mine.find((m) => m.status === 'live')
  const next =
    onCourt ?? mine.find((m) => m.state === 'none' && m.status !== 'cancelled')
  // Everything of yours that is over, in three kinds. A disputed match has no
  // published score, so folding it in with the rest would have told a player
  // they lost a match nobody has settled yet.
  const history = mine.filter((m) => m.state !== 'none' && m.status !== 'live')
  const played = history.filter(
    (m) => (m.state === 'final' || m.state === 'reported') && m.resultType !== 'bye',
  )
  const underReview = history.filter((m) => m.state === 'disputed')
  const wins = played.filter((m) => m.winnerSide === iAm(m)).length

  // Matches ahead of yours are spread over every court that's running, so the
  // count of them is not the number of matches you wait through. Dividing by
  // the courts in play is still an estimate, and it is labelled as one.
  const aheadTotal = next
    ? matches.filter(
        (m) =>
          m.state === 'none' &&
          m.status !== 'live' &&
          m.status !== 'cancelled' &&
          m.queuePosition < next.queuePosition,
      ).length
    : 0
  const ahead = Math.ceil(aheadTotal / Math.max(1, courtsInPlay))

  const myTable = next
    ? (tableFor[next.teamAId ?? ''] ?? tableFor[next.teamBId ?? ''])
    : mine.length
      ? (tableFor[mine[0].teamAId ?? ''] ?? tableFor[mine[0].teamBId ?? ''])
      : undefined

  function pick(p: Player) {
    setQuery('')
    setBrowsing(false)
    setMe(p.id)
  }

  function forget() {
    setQuery('')
    setBrowsing(false)
    setMe(null)
  }

  /**
   * The tables are one radio group, so showing a particular one is a matter of
   * checking its radio — the same thing a tap on the tab does. No state is
   * duplicated and the CSS switch stays the single source of truth.
   */
  function showTable(index: number) {
    const radio = document.getElementById(`cat-tab-${index}`)
    if (radio instanceof HTMLInputElement) radio.checked = true
    document.getElementById('tables')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (me) {
    const headline = onCourt
      ? onCourt.courtName
        ? `You're on ${onCourt.courtName} now`
        : "You're on court now"
      : next
        ? ahead === 0
          ? next.courtName
            ? `You're next — ${next.courtName}`
            : "You're next to be called"
          : `About ${ahead} match${ahead === 1 ? '' : 'es'} away`
        : played.length
          ? "You're done for today"
          : underReview.length
            ? 'Your result is being checked'
            : 'No matches for you yet'

    return (
      <section
        aria-label="Your matches"
        className="overflow-hidden rounded-card border border-line-strong bg-paper shadow-card"
      >
        {/* The one card on the page that is about YOU. Terracotta on top marks
            it as structure, the way green marks a live court — the two are
            never the same colour and never mean the same thing. */}
        <div aria-hidden className="h-1 bg-accent-line" />
        <div className="flex items-center gap-3 border-b border-line bg-sunken px-4 py-2">
          <p className="font-score min-w-0 flex-1 truncate text-eyebrow text-text-2 uppercase">
            {me.name}
          </p>
          <button
            type="button"
            onClick={forget}
            className="-my-2 -mr-2 flex min-h-[44px] items-center px-2 text-meta font-semibold text-link"
          >
            Not you?
          </button>
        </div>

        <div className="px-4 py-4">
          <p className="text-title text-text">{headline}</p>

          {next ? (
            <>
              <p className="mt-2.5 text-meta text-text-3">against</p>
              <TeamName name={opponentOf(next)} />
              <p className="mt-1 text-meta text-text-3">
                {next.categoryName}
                {next.roundName ? ` · ${next.roundName}` : ''}
                {!onCourt && next.courtName ? ` · ${next.courtName}` : ''}
                {!onCourt && !next.courtName ? ' · court called when it frees up' : ''}
              </p>
            </>
          ) : played.length ? (
            <p className="num mt-2 text-body text-text-2">
              {wins} won, {played.length - wins} lost out of {played.length}
            </p>
          ) : (
            <p className="mt-2 text-body text-text-2">
              Your name is on the list — the matches appear here as soon as the draw is made.
            </p>
          )}

          {underReview.length ? (
            <p className="mt-3">
              <Tag tone="alert">One of your results is under review</Tag>
            </p>
          ) : null}

          {myTable ? (
            <button
              type="button"
              onClick={() => showTable(myTable.index)}
              className="tap mt-3 -mb-1 flex w-full items-center justify-center rounded-control border border-line-strong bg-paper px-4 text-row text-link"
            >
              See the {myTable.name} table
            </button>
          ) : null}
        </div>

        {history.length ? (
          <details className="group border-t border-line">
            <summary className="tap flex items-center gap-3 bg-paper px-4">
              <span className="min-w-0 flex-1 text-row text-text">
                Your {history.length} match{history.length === 1 ? '' : 'es'} so far
              </span>
              <span aria-hidden className="chev text-text-2">
                <svg viewBox="0 0 20 20" className="size-5" fill="none">
                  <path
                    d="M5 8l5 5 5-5"
                    stroke="currentColor"
                    strokeWidth="2.25"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            </summary>
            <ul className="divide-y divide-line border-t border-line">
              {history.map((m) => {
                const won = m.winnerSide === iAm(m)
                return (
                  <li key={m.id} className="px-4 py-3">
                    <p className="text-body text-text">
                      {m.resultType === 'bye' ? (
                        <span className="font-bold">Sat out this round</span>
                      ) : m.state === 'disputed' ? (
                        <span className="font-bold">Under review</span>
                      ) : m.state === 'voided' ? (
                        <span className="font-bold">Cancelled</span>
                      ) : (
                        <>
                          <span className="font-bold">{won ? 'Won' : 'Lost'}</span>{' '}
                          {/* A no-show has a scoreline on the record and nobody
                              hit a ball; printing it is a lie about the day. */}
                          {m.resultType === 'walkover' ? (
                            <span className="text-text-2">— the other pair didn’t show</span>
                          ) : (
                            <span className="num">{m.scoreLine ?? ''}</span>
                          )}
                        </>
                      )}
                    </p>
                    {m.resultType === 'bye' ? (
                      <p className="text-meta text-text-3">{m.categoryName}</p>
                    ) : (
                      <p className="text-meta text-text-3">v {opponentOf(m) ?? '—'}</p>
                    )}
                    {m.resultType === 'retired' ? (
                      <p className="mt-1">
                        <Tag>Stopped mid-match</Tag>
                      </p>
                    ) : null}
                    {m.state === 'reported' ? (
                      <p className="mt-1">
                        <Tag tone="waiting">Not confirmed yet</Tag>
                      </p>
                    ) : null}
                  </li>
                )
              })}
            </ul>
            <p className="border-t border-line px-4 py-3 text-meta text-text-3">
              Something wrong? Tell the organiser — they can fix a score in a few seconds.
            </p>
          </details>
        ) : null}
      </section>
    )
  }

  return (
    <section className="overflow-hidden rounded-card border border-line-strong bg-paper shadow-card">
      <div aria-hidden className="h-1 bg-accent-line" />
      <div className="px-4 pt-4 pb-3">
        <h2 className="text-section text-text">Find my match</h2>
        <p className="mt-1 text-meta text-text-3">Tap your name once. This phone remembers it.</p>
        <label htmlFor="me" className="sr-only">
          Search the players by name
        </label>
        <input
          id="me"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type your name"
          autoComplete="off"
          enterKeyHint="search"
          className="tap-lg mt-3 w-full rounded-control border border-line-strong bg-paper px-3.5 text-body text-text placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none"
        />
      </div>

      {shortlist.length ? (
        <ul className={listClass(shortlist.length)} aria-label="Players">
          {shortlist.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => pick(p)}
                className="tap flex w-full items-center px-4 text-left text-row text-text hover:bg-ground active:bg-sunken"
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      ) : query.trim() ? (
        <p className="px-4 pb-4 text-body text-text-2">
          Nobody by that name is playing today.
        </p>
      ) : null}

      {!browsing ? (
        <button
          type="button"
          onClick={() => setBrowsing(true)}
          className="tap flex w-full items-center justify-center border-t border-line px-4 text-row text-link"
        >
          Show all {players.length} names
        </button>
      ) : (
        <button
          type="button"
          onClick={() => {
            setBrowsing(false)
            setQuery('')
          }}
          className="tap flex w-full items-center justify-center border-t border-line px-4 text-row text-link"
        >
          Hide the list
        </button>
      )}
    </section>
  )
}

/**
 * Twenty-four 56px rows is taller than the phone. Past six the list gets its own
 * scroll so the card stays a card, and the page underneath does not grow by a
 * screen and a half the moment someone opens the picker.
 */
function listClass(count: number) {
  const base = 'divide-y divide-line border-t border-line'
  return count > 6 ? `${base} max-h-[46vh] overflow-y-auto` : base
}
