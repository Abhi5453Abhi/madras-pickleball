import Link from 'next/link'
import { Confirm, CourtSwatch, Disclosure, Panel, Tag, TeamName } from '@/components/ui'
import type { BoardCourt } from '@/server/board'
import { SECONDARY_LINK } from '../../_ui'
import type { MatchView } from './draw'
import {
  pauseDayAction,
  setCourtClosed,
  shortenFormatAction,
  substituteAction,
  withdrawTeamAction,
  reinstateTeamAction,
} from './actions'

/**
 * The escape hatch — SPEC A7.
 *
 * "A Google Sheet's superpower is that it never refuses an edit." Everything
 * here is something a real Sunday does to a plan: a knee goes at eleven, a
 * partner is stuck on the ECR, the light fails at six. Without them the
 * organiser shortens the format on paper and every phone in the venue is
 * confidently wrong for the rest of the day.
 *
 * Two rules hold across all of it. Nothing fires on one tap. And nothing asks
 * "are you sure?" — every confirm says the actual consequence in numbers,
 * because the organiser is standing in front of the person asking and a
 * quantity is an answer where a warning is not.
 */

export type WithdrawView = {
  teamId: string
  name: string
  categoryName: string
  withdrawn: boolean
  /** Matches they have played, which stand either way. */
  played: number
  /** Matches they have left, which become walkovers to the other side. */
  toWalkover: number
  /**
   * Matches they were only pencilled into — a final waiting on the other semi.
   * There is nobody to give a walkover to, so the slot simply loses their name
   * and goes back to waiting. Counted separately because promising a walkover
   * that will not happen is worse than saying nothing.
   */
  vacates: number
  /** What those matches are called, for the sentence. */
  vacatesRounds: string[]
  /** A match of theirs on court right now — the server will refuse until it ends. */
  blockedBy: string | null
}

export type ShortenOption = {
  bestOf: number
  pointsToWin: number
  label: string
  /** Venue time the whole day would finish at, if this category changed. */
  finishAt: string | null
  savedMinutes: number
}

export type ShortenView = {
  categoryId: string
  name: string
  currentLabel: string
  outstanding: number
  live: boolean
  options: ShortenOption[]
}

export type SubTeam = {
  teamId: string
  teamName: string
  categoryName: string
  members: Array<{ id: string; name: string }>
}

/**
 * What a withdrawal costs, in counts, before it happens. Three different things
 * can happen to a pair's remaining matches and the confirm has to name whichever
 * ones apply — "are you sure?" is not an answer to somebody standing in front of
 * you asking to pull out.
 */
function withdrawalSentence(w: WithdrawView): string {
  if (w.played === 0 && w.toWalkover === 0 && w.vacates === 0) {
    return 'They have no matches in the draw yet, so nothing moves — this only marks them as out.'
  }

  const parts: string[] = []

  parts.push(
    w.played === 0
      ? 'They have not played anything yet.'
      : `${w.played} ${w.played === 1 ? 'match' : 'matches'} they have played stand.`,
  )

  if (w.toWalkover > 0) {
    parts.push(
      `The ${w.toWalkover} they had left ${w.toWalkover === 1 ? 'becomes a walkover' : 'become walkovers'} to the other pair.`,
    )
  }

  if (w.vacates > 0) {
    const named = w.vacatesRounds.filter(Boolean)
    parts.push(
      w.vacates === 1 && named.length === 1
        ? `They ${w.toWalkover > 0 ? 'also ' : ''}come off ${named[0]}, which goes back to waiting for whoever comes through.`
        : `They ${w.toWalkover > 0 ? 'also ' : ''}come off ${w.vacates} matches they were only pencilled into, which go back to waiting.`,
    )
  }

  if (w.toWalkover === 0 && w.vacates === 0) parts.push('They have nothing left to play.')

  return parts.join(' ')
}

const INK_BUTTON =
  'tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white'

const FIELD =
  'tap w-full rounded-control border border-line-key bg-paper px-3.5 text-body text-text'

export function Fixes({
  slug,
  withResults,
  courts,
  openCourts,
  withdrawals,
  subTeams,
  roster,
  shorten,
  paused,
}: {
  slug: string
  withResults: MatchView[]
  courts: BoardCourt[]
  openCourts: number
  withdrawals: WithdrawView[]
  subTeams: SubTeam[]
  roster: Array<{ id: string; name: string }>
  shorten: ShortenView[]
  paused: boolean
}) {
  const closedCourts = courts.filter((c) => c.closed)
  const out = withdrawals.filter((w) => w.withdrawn)
  const inPlay = withdrawals.filter((w) => !w.withdrawn)
  const shortenable = shorten.filter((s) => s.outstanding > 0 && s.options.length > 0)

  return (
    <section className="flex flex-col gap-3">
      <div>
        <h2 className="text-section text-text">If something&rsquo;s gone wrong</h2>
        <div aria-hidden className="mt-1.5 h-[3px] w-10 rounded-full bg-accent-line" />
        <p className="mt-1.5 text-meta text-text-3">
          All of it is reversible, and all of it goes in the log with your name on it.
        </p>
      </div>

      {/* ── a score is wrong ─────────────────────────────────────────────── */}
      <Disclosure
        summary="Change a score that’s already in"
        meta={
          withResults.length ? `${withResults.length} entered · newest first` : 'Nothing has a score yet'
        }
      >
        {withResults.length ? (
          <Panel>
            <ul className="divide-y divide-line">
              {withResults.slice(0, 20).map((m) => (
                <li key={m.id}>
                  <Link href={`/admin/m/${m.id}`} className="block hover:bg-ground">
                    <div className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <TeamName name={m.nameA} />
                        <TeamName name={m.nameB} />
                        <p className="mt-0.5 text-meta text-text-3">
                          {m.roundName}
                          {m.scoreLine ? ` · ${m.scoreLine}` : ''}
                        </p>
                      </div>
                      <span className="num shrink-0 text-[22px] font-bold text-text">
                        {m.gamesWonA}–{m.gamesWonB}
                      </span>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
            {withResults.length > 20 ? (
              <p className="border-t border-line bg-sunken px-4 py-3 text-meta text-text-2">
                The oldest {withResults.length - 20} are under “Show the draw” in their category.
                Cancelling a match outright is on the match itself.
              </p>
            ) : null}
          </Panel>
        ) : (
          <p className="rounded-card border border-line-strong bg-paper px-4 py-4 text-body text-text-2">
            When a score is wrong, it turns up here the moment it is entered.
          </p>
        )}
      </Disclosure>

      {/* ── a pair has pulled out ────────────────────────────────────────── */}
      {withdrawals.length ? (
        <Disclosure
          summary="A pair has pulled out"
          meta={
            out.length
              ? `${out.length} withdrawn · ${inPlay.length} still in`
              : `${inPlay.length} pairs playing`
          }
        >
          <Panel>
            <ul className="divide-y divide-line">
              {[...out, ...inPlay].map((w) => (
                <li key={w.teamId} className="flex flex-col gap-2.5 px-4 py-3.5">
                  <div>
                    <p className="text-meta text-text-3">{w.categoryName}</p>
                    <TeamName name={w.name} muted={w.withdrawn} />
                    {w.withdrawn ? (
                      <span className="mt-1.5 inline-flex">
                        <Tag tone="waiting">Withdrew — matches they played still count</Tag>
                      </span>
                    ) : null}
                  </div>

                  {w.withdrawn ? (
                    <Confirm
                      label="They’re playing after all"
                      question={`${w.name} go back into ${w.categoryName}. Any match given away when they pulled out is undone and goes back in the queue — the matches they actually played are untouched.`}
                    >
                      <form action={reinstateTeamAction}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="teamId" value={w.teamId} />
                        <button className={INK_BUTTON}>Put {w.name} back</button>
                      </form>
                    </Confirm>
                  ) : w.blockedBy ? (
                    // The server refuses this one; saying so here saves the tap
                    // and the bounce.
                    <p className="rounded-control bg-waiting-soft px-3.5 py-3 text-body font-medium text-waiting">
                      {w.blockedBy} is on court right now. Take it off court, or let it finish.
                    </p>
                  ) : (
                    <Confirm
                      label="They’ve pulled out"
                      // Not "are you sure" — the organiser is standing in front
                      // of the person asking, and the answer they need is a
                      // count of what it costs.
                      question={withdrawalSentence(w)}
                      detail="A walkover counts as a win and adds nothing to any difference column, so a pair going home cannot decide the pool for the people still playing. You can put them back."
                    >
                      <form action={withdrawTeamAction}>
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="teamId" value={w.teamId} />
                        <button className={INK_BUTTON}>Withdraw {w.name}</button>
                      </form>
                    </Confirm>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
        </Disclosure>
      ) : null}

      {/* ── somebody is playing for somebody else ────────────────────────── */}
      {subTeams.length && roster.length ? (
        <Disclosure summary="Swap a player" meta="Somebody has stepped in for somebody else">
          <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
            <p className="text-body text-text-2">
              The pair keeps its results and its place in the table. Only the name changes — and it
              changes everywhere at once, because &ldquo;Ravi / Priya&rdquo; on the board and
              &ldquo;Ravi / Meera&rdquo; on the public page is how an argument starts.
            </p>
            <form action={substituteAction} className="mt-4 flex flex-col gap-4">
              <input type="hidden" name="slug" value={slug} />

              {/* One select, not two: the outgoing player carries their pair
                  with them, so "Ravi, out of a pair Ravi is not in" is a state
                  this form cannot reach. */}
              <div className="flex flex-col gap-2">
                <label htmlFor="sub-out" className="block text-row text-text">
                  Who is coming out
                </label>
                <select id="sub-out" name="out" required defaultValue="" className={FIELD}>
                  <option value="" disabled>
                    Pick a player
                  </option>
                  {subTeams.map((t) => (
                    <optgroup key={t.teamId} label={`${t.teamName} — ${t.categoryName}`}>
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
                <select id="sub-in" name="in" required defaultValue="" className={FIELD}>
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

              <button className={INK_BUTTON}>Make the swap</button>
            </form>
          </div>
        </Disclosure>
      ) : null}

      {/* ── the sun sets at a fixed time ─────────────────────────────────── */}
      {shortenable.length ? (
        <Disclosure
          summary="Shorten what’s left"
          meta="Fewer games in the matches nobody has started"
        >
          <div className="flex flex-col gap-4">
            {shortenable.map((c) => (
              <div key={c.categoryId}>
                <h3 className="mb-2 text-row text-text">{c.name}</h3>
                <Panel>
                  <p className="border-b border-line bg-sunken px-4 py-2.5 text-meta text-text-2">
                    {c.currentLabel} now · {c.outstanding} still to play
                  </p>
                  {c.live ? (
                    <p className="px-4 py-3.5 text-body font-medium text-waiting">
                      A match in this category is on court. Change it when that one finishes.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {c.options.map((o) => (
                        <li key={o.label} className="px-4 py-3.5">
                          <Confirm
                            label={o.label}
                            question={`The ${c.outstanding} ${c.outstanding === 1 ? 'match' : 'matches'} nobody has started in ${c.name} become ${o.label.toLowerCase()}.${o.finishAt ? ` The day finishes about ${o.finishAt} instead — ${Math.round(o.savedMinutes)} minutes back.` : ''}`}
                            // This sentence is load-bearing and it is tied to
                            // `rules_override`: a category is scored one way
                            // for the whole day until the shortening writes
                            // per-match rules onto the unplayed fixtures. When
                            // that lands, the second half of this is no longer
                            // true and should go.
                            detail="Scores already in are not changed. But a category is scored one way for the whole day, so a result you go back to correct afterwards has to fit the new shape — if you have corrections to make, make them first."
                          >
                            <form action={shortenFormatAction}>
                              <input type="hidden" name="slug" value={slug} />
                              <input type="hidden" name="categoryId" value={c.categoryId} />
                              <input type="hidden" name="bestOf" value={o.bestOf} />
                              <input type="hidden" name="pointsToWin" value={o.pointsToWin} />
                              <button className={INK_BUTTON}>Change it to {o.label.toLowerCase()}</button>
                            </form>
                          </Confirm>
                          {o.finishAt ? (
                            <p className="num mt-2 text-center text-meta text-text-2">
                              finishes about {o.finishAt} · {Math.round(o.savedMinutes)} min back
                            </p>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </Panel>
              </div>
            ))}
          </div>
        </Disclosure>
      ) : null}

      {/* ── a court is unusable ──────────────────────────────────────────── */}
      <Disclosure
        summary="Take a court out of action"
        meta={
          closedCourts.length
            ? `${closedCourts.length} closed right now`
            : `${openCourts} court${openCourts === 1 ? '' : 's'} in use`
        }
      >
        <Panel>
          <ul className="divide-y divide-line">
            {courts.map((c) => {
              const leftOpen = openCourts - 1
              const leftLabel =
                leftOpen <= 0
                  ? 'Nothing else is open, so the day stops until a court comes back.'
                  : `The finish estimate recomputes on ${leftOpen} court${leftOpen === 1 ? '' : 's'}.`
              return (
                <li key={c.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <span className="flex min-w-[7rem] flex-1 items-center gap-2">
                    <CourtSwatch colorKey={c.colorKey} size="md" />
                    <span className="text-row text-text">{c.name}</span>
                    {c.closed ? (
                      <span className="text-meta text-waiting">{c.closedReason}</span>
                    ) : null}
                  </span>
                  {c.closed ? (
                    <form action={setCourtClosed} className="ml-auto">
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="courtId" value={c.id} />
                      <input type="hidden" name="close" value="0" />
                      <button className="tap rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text">
                        Back in action
                      </button>
                    </form>
                  ) : (
                    <Confirm
                      className="ml-auto [&[open]]:w-full"
                      label="Close it"
                      question={
                        c.live
                          ? `${c.name} stops taking matches, and ${c.live.nameA} v ${c.live.nameB} comes off it with no score — nothing is lost, it goes back in the queue. ${leftLabel}`
                          : `${c.name} stops taking matches. ${leftLabel} You can put it back any time.`
                      }
                    >
                      <form action={setCourtClosed} className="flex flex-col gap-2">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="courtId" value={c.id} />
                        <input type="hidden" name="close" value="1" />
                        <input
                          name="reason"
                          defaultValue="Out of action"
                          aria-label={`Why ${c.name} is out of action`}
                          className={FIELD}
                        />
                        <button className={INK_BUTTON}>Take {c.name} out</button>
                      </form>
                    </Confirm>
                  )}
                </li>
              )
            })}
          </ul>
        </Panel>
      </Disclosure>

      {/* ── stop everything ──────────────────────────────────────────────── */}
      {paused ? null : (
        <Confirm
          label="Stop the day for a bit"
          question="Nothing is cancelled and nothing is lost — the public page says why you have stopped, so forty people are not staring at a board that has not moved."
          detail="Matches already on court carry on. Start it again whenever you like."
        >
          <form action={pauseDayAction} className="flex flex-col gap-2">
            <input type="hidden" name="slug" value={slug} />
            <input
              name="note"
              defaultValue="Rain — back shortly"
              aria-label="What everybody is waiting for"
              className={FIELD}
            />
            <button className={INK_BUTTON}>Stop the day</button>
          </form>
        </Confirm>
      )}

      <Link href={`/admin/t/${slug}/results`} className={SECONDARY_LINK}>
        Somebody didn&rsquo;t turn up →
      </Link>
    </section>
  )
}
