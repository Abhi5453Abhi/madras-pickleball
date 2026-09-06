'use client'

import { useEffect, useMemo, useState } from 'react'

/**
 * "Find my match" — SPEC A8. The most valuable thing on the public page, and
 * the first interactive element. No login: type your name, tap yourself, and
 * the answer pins to the top. Remembered in localStorage so the next visit is
 * already personal.
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
  playersA: string[]
  playersB: string[]
  courtName: string | null
  status: string
  state: string
  categoryName: string
  roundName: string | null
  queuePosition: number
  scoreLine: string | null
  winnerSide: 'A' | 'B' | null
}

const KEY = 'mpb.me'

export function FindMyMatch({
  players,
  matches,
  courtsInPlay,
}: {
  players: Player[]
  matches: M[]
  courtsInPlay: number
}) {
  const [query, setQuery] = useState('')
  const [meId, setMeId] = useState<string | null>(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY)
      if (saved && players.some((p) => p.id === saved)) setMeId(saved)
    } catch {
      /* private window, cleared storage — the page still works */
    }
  }, [players])

  const me = players.find((p) => p.id === meId) ?? null

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length < 2) return []
    return players.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 6)
  }, [query, players])

  // By team id, never by name: a club has two Karthiks and one of them would
  // otherwise be told to go to a court he isn't playing on.
  const mine = useMemo(() => {
    if (!me) return []
    const mineTeams = new Set(me.teamIds)
    return matches.filter(
      (m) =>
        (m.teamAId && mineTeams.has(m.teamAId)) || (m.teamBId && mineTeams.has(m.teamBId)),
    )
  }, [me, matches])

  const next = mine.find((m) => m.state === 'none')
  const played = mine.filter((m) => m.state !== 'none')

  // Matches ahead of yours are spread over every court that's running, so the
  // count of them is not the number of matches you wait through. Dividing by
  // the courts in play is still an estimate, and it is labelled as one.
  const aheadTotal = next
    ? matches.filter(
        (m) => m.state === 'none' && m.status !== 'live' && m.queuePosition < next.queuePosition,
      ).length
    : 0
  const ahead = Math.ceil(aheadTotal / Math.max(1, courtsInPlay))

  function pick(p: Player) {
    setMeId(p.id)
    setQuery('')
    try {
      localStorage.setItem(KEY, p.id)
    } catch {
      /* ignore */
    }
  }

  if (me) {
    return (
      <section className="rounded-card border border-line-strong border-l-4 border-l-accent-line bg-paper p-4 shadow-card">
        <div className="flex items-baseline justify-between gap-3">
          <p className="font-score text-eyebrow text-accent uppercase">{me.name}</p>
          <button
            type="button"
            onClick={() => {
              setMeId(null)
              try {
                localStorage.removeItem(KEY)
              } catch {
                /* ignore */
              }
            }}
            className="text-meta font-semibold text-link"
          >
            Not you?
          </button>
        </div>

        {next ? (
          <>
            <p className="mt-2 text-section text-text">
              {next.status === 'live'
                ? `You're on ${next.courtName ?? 'court'} now`
                : ahead === 0
                  ? 'You’re next on'
                  : `About ${ahead} match${ahead === 1 ? '' : 'es'} away`}
            </p>
            <p className="mt-1 text-row text-text-2">
              {next.nameA} <span className="text-text-3">v</span> {next.nameB}
            </p>
            <p className="text-meta text-text-3">
              {next.categoryName}
              {next.roundName ? ` · ${next.roundName}` : ''}
              {next.courtName ? ` · ${next.courtName}` : ''}
            </p>
          </>
        ) : (
          <p className="mt-2 text-section text-text">You’re done for today.</p>
        )}

        {played.length ? (
          <ul className="mt-4 flex flex-col gap-1.5 border-t border-line pt-3">
            {played.map((m) => (
              <li key={m.id} className="text-meta text-text-2">
                <span className="num">{m.scoreLine ?? '—'}</span> · {m.nameA} v {m.nameB}
              </li>
            ))}
            <li className="mt-1 text-meta text-text-3">
              Something look wrong? Tell the organiser — they can fix it in a few seconds.
            </li>
          </ul>
        ) : null}
      </section>
    )
  }

  return (
    <section className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
      <label htmlFor="me" className="text-section text-text">
        Find my match
      </label>
      <input
        id="me"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Type your name"
        autoComplete="off"
        className="tap-lg mt-3 w-full rounded-control border border-line-strong bg-paper px-3.5 text-body text-text placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none"
      />
      {results.length ? (
        <ul className="mt-2 flex flex-col gap-1">
          {results.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => pick(p)}
                className="tap w-full rounded-control px-3 text-left text-row text-text hover:bg-ground"
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  )
}
