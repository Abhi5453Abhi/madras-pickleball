import { clsx } from 'clsx'
import { useEffect, useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import type { Output } from '@/api/contract'
import { useAction, useRpc } from '@/api/use-rpc'
import { Chevron, CourtSwatch, Notice, Panel, splitTeam } from '@/components/ui'
import { PRIMARY_LINK, SECONDARY_LINK } from '@/components/admin-ui'
import { estimateDay, minutesPerMatch } from '@/lib/estimate'
import { formatDuration, venueTime } from '@/lib/time'
import { formatWords } from '@/lib/words'
import { Loading, LoadError, NotFoundCard, useTitle } from '@/lib/page'

type Hub = Output<'events.hub'>
type Match = Output<'tournaments.listMatches'>[number]

/**
 * Which courts this tournament plays on, and the order of play. No times:
 * matches go on in this order onto whichever of these courts is free.
 */
export function SchedulePage() {
  useTitle('Schedule & courts · Madras Pickleball')
  const { slug = '' } = useParams()
  // `events.hub` settles the mutual pairs and singles' teams of one on the way
  // in, so the schedule has something to draw from even if Teams was never
  // opened.
  const hub = useRpc('events.hub', { slug })

  if (hub.state === 'loading') return <Loading />
  if (hub.state === 'missing') return <NotFoundCard />
  if (hub.state !== 'ready') return <LoadError error={hub.error} retry={() => void hub.reload(false)} />
  return <Schedule slug={slug} h={hub.data} reloadHub={() => void hub.reload()} />
}

function Schedule({ slug, h, reloadHub }: { slug: string; h: Hub; reloadHub: () => void }) {
  const t = h.tournament
  const tournamentId = t.id
  const options = useRpc('events.courtOptions', { tournamentId })
  const matches = useRpc('tournaments.listMatches', { tournamentId })
  const teamNames = useRpc('tournaments.teamNameMap', { tournamentId })
  const { run, pending } = useAction()
  const [err, setErr] = useState<string | null>(null)
  const [picked, setPicked] = useState<string[] | null>(null)

  if (options.state === 'loading' || matches.state === 'loading' || teamNames.state === 'loading') {
    return <Loading />
  }
  if (options.state !== 'ready' || matches.state !== 'ready' || teamNames.state !== 'ready') {
    return <LoadError error="That didn’t load." retry={() => void options.reload(false)} />
  }

  const opts = options.data
  const all = matches.data
  const names = teamNames.data
  const mine = opts.filter((o) => o.mine)
  const checked = picked ?? mine.map((o) => o.id)
  const upcoming = all.filter((m) => m.resultState === 'none' && m.status !== 'cancelled')
  const locked = h.matchesPlayed > 0
  const canStart = h.phase === 'setup' && all.length > 0 && mine.length > 0
  const finished = h.phase === 'finished'
  const semis = t.finalsStage === 'semis_and_final'

  // "16 matches on 2 courts · about 4 hours · done by 17:40 if you start now"
  // — the one number that decides whether the day fits.
  const estimate = (() => {
    if (!upcoming.length || !mine.length) return null
    const day = estimateDay({
      categories: [
        {
          name: t.name,
          matchCount: upcoming.length,
          minutesPerMatch: minutesPerMatch({ bestOf: t.bestOf, pointsToWin: t.pointsToWin }),
          minMatchesPerEntry: 0,
        },
      ],
      courts: mine.length,
      startAt: new Date(),
    })
    return `${upcoming.length} ${upcoming.length === 1 ? 'match' : 'matches'} on ${mine.length} ${
      mine.length === 1 ? 'court' : 'courts'
    } · about ${formatDuration(day.minutes)}${
      day.finishAt
        ? ` · done by ${venueTime(day.finishAt)}${h.phase === 'setup' ? ' if you start now' : ' from here'}`
        : ''
    }`
  })()

  async function saveCourts(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('events.assignCourts', { tournamentId, courtIds: checked })
    if (!res.ok) setErr(res.error)
    else setErr(null)
    setPicked(null)
    reloadHub()
    await options.reload()
  }

  async function makeSchedule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('tournaments.generateDraw', { tournamentId })
    if (!res.ok) setErr(res.error)
    else setErr(null)
    reloadHub()
    await matches.reload()
    await teamNames.reload()
  }

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('events.startEvent', { tournamentId })
    if (!res.ok) setErr(res.error)
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          to={`/admin/t/${slug}`}
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          {t.name}
        </Link>
        <h1 className="mt-1 text-title text-text">Schedule &amp; courts</h1>
        <p className="num mt-1 text-meta text-text-3">
          {finished
            ? `${all.length} matches · all played`
            : `${mine.length ? mine.map((c) => c.name).join(', ') : 'No courts yet'} · ${
                all.length ? `${all.length} matches` : 'schedule not made yet'
              }`}
        </p>
      </header>

      {err ? <Notice tone="alert">{err}</Notice> : null}

      {/* Over: the courts are released and the order of play is empty, so a
          court form and a blank list would only look like set-up. */}
      {finished ? (
        <p className="text-body text-text-2">
          Every match has been played and the courts are free. The results are on{' '}
          <Link to={`/admin/t/${slug}`} className="font-semibold text-link">
            {t.name}
          </Link>
          .
        </p>
      ) : null}

      {finished ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">Courts</h2>
          <form onSubmit={saveCourts} className="flex flex-col gap-3">
            <input type="hidden" name="slug" value={slug} />
            <div className="flex flex-wrap gap-2">
              {opts.map((o) => (
                <label
                  key={o.id}
                  className={clsx(
                    'tap inline-flex cursor-pointer items-center gap-2 rounded-full border px-3.5 text-[16px] font-semibold has-checked:border-ink has-checked:bg-ink has-checked:text-white',
                    o.takenBy
                      ? 'cursor-not-allowed border-line bg-sunken text-text-3'
                      : 'border-line-key bg-paper text-text',
                  )}
                >
                  <input
                    type="checkbox"
                    name="courts"
                    value={o.id}
                    checked={checked.includes(o.id)}
                    disabled={!!o.takenBy}
                    onChange={(e) =>
                      setPicked(
                        e.target.checked
                          ? [...checked, o.id]
                          : checked.filter((id) => id !== o.id),
                      )
                    }
                    className="sr-only"
                  />
                  <CourtSwatch colorKey={o.colorKey} size="md" />
                  {o.name}
                  {o.takenBy ? <span className="font-normal">· {o.takenBy.name}</span> : null}
                </label>
              ))}
            </div>
            <p className="text-meta text-text-3">
              {opts.some((o) => o.takenBy)
                ? 'A greyed court belongs to another tournament that day — take it off there to use it here.'
                : 'Matches only ever go onto these courts.'}
            </p>
            <button className={SECONDARY_LINK}>Save courts</button>
          </form>
          <Link
            to="/admin/courts"
            className="tap flex items-center justify-center px-3 text-[16px] font-semibold text-link"
          >
            Add or rename the venue&rsquo;s courts
          </Link>
        </section>
      )}

      {/* Start sits above the list: with sixteen matches the list is a long
          scroll, and the button is the thing the organiser came for. */}
      {canStart ? (
        <form onSubmit={start}>
          <input type="hidden" name="slug" value={slug} />
          <ArmedButton disabled={pending}>Start the tournament</ArmedButton>
          <p className="mt-2 text-center text-meta text-text-2">Closes sign-ups and opens the live board.</p>
        </form>
      ) : null}

      {finished ? null : (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">
            Order of play
            {all.length ? (
              <small className="num ml-1 font-normal normal-case text-text-3">
                {formatWords(t.finalsStage)}
              </small>
            ) : null}
          </h2>
          {all.length === 0 ? (
            <form onSubmit={makeSchedule} className="flex flex-col gap-2">
              <input type="hidden" name="slug" value={slug} />
              <button className={PRIMARY_LINK} disabled={h.teamsMade < 2 || pending}>
                Make the schedule
              </button>
              <p className="text-center text-meta text-text-2">
                {h.teamsMade < 2
                  ? 'Make the pairs first — you need at least two.'
                  : `${h.teamsMade} ${t.discipline === 'doubles' ? 'pairs' : 'players'} · ${formatWords(
                      t.finalsStage,
                    )}. No times — matches go on in order onto whichever court is free.`}
              </p>
            </form>
          ) : (
            <>
              {estimate ? <p className="num text-meta text-text-2">{estimate}</p> : null}
              <Panel>
                <ol className="divide-y divide-line">
                  {upcoming.map((m, i) => (
                    <li key={m.id} className="flex min-h-[52px] items-center gap-3 px-4 py-2">
                      <span className="num w-6 shrink-0 text-meta text-text-3">{i + 1}</span>
                      <span className="min-w-0 flex-1 text-row text-text">
                        <span className={m.teamAId ? 'font-semibold' : 'font-normal text-text-3'}>
                          {m.teamAId ? shortTeam(names[m.teamAId]) : slotWords(m, 'A', semis)}
                        </span>
                        <span className="mx-1.5 text-meta font-normal text-text-3">v</span>
                        <span className={m.teamBId ? 'font-semibold' : 'font-normal text-text-3'}>
                          {m.teamBId ? shortTeam(names[m.teamBId]) : slotWords(m, 'B', semis)}
                        </span>
                      </span>
                      {m.roundName ? (
                        <span className="shrink-0 rounded-full border border-line-strong bg-sunken px-2 py-0.5 text-meta font-semibold text-text-2">
                          {m.roundName.replace(/^Round (\d+)$/, 'R$1')}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </Panel>
              {!locked ? (
                <form onSubmit={makeSchedule}>
                  <input type="hidden" name="slug" value={slug} />
                  <button className={SECONDARY_LINK + ' w-full'}>Make it again</button>
                </form>
              ) : null}
            </>
          )}
        </section>
      )}
    </div>
  )
}

/** "Karthik / Sathish" — first names only, the way the order is read out. */
function shortTeam(name: string | null | undefined) {
  return splitTeam(name)
    .map((p) => p.split(/\s+/)[0])
    .join(' / ')
}

/**
 * Who plays a knockout match before the table has decided it. Mirrors the
 * shape of the draw: a lone final is 1st v 2nd; semis are 1st v 4th and 2nd v
 * 3rd, and their final is the two winners.
 */
function slotWords(m: Pick<Match, 'roundName' | 'seq'>, side: 'A' | 'B', semis: boolean) {
  if (m.roundName === 'Semi-final') {
    return m.seq === 0
      ? side === 'A'
        ? '1st in table'
        : '4th in table'
      : side === 'A'
        ? '2nd in table'
        : '3rd in table'
  }
  if (m.roundName === 'Final') {
    if (semis) return side === 'A' ? 'Winner of semi 1' : 'Winner of semi 2'
    return side === 'A' ? '1st in table' : '2nd in table'
  }
  return 'To be decided'
}

/**
 * A button that ignores its first moments on screen. "Start the tournament"
 * appears exactly where "Make the schedule" was, a re-render after the
 * schedule is made; the reference went through a redirect, which took long
 * enough for the second tap of a double-tap to hit nothing. Here it would
 * start the day. There is no way back from Start, so it earns a beat.
 */
function ArmedButton({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) {
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 700)
    return () => clearTimeout(t)
  }, [])
  return (
    <button className={PRIMARY_LINK} disabled={disabled || !armed} aria-disabled={!armed || undefined}>
      {children}
    </button>
  )
}
