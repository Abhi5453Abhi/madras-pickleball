import { Fragment } from 'react'
import { clsx } from 'clsx'
import Link from 'next/link'
import { Disclosure, EmptyState, Panel, Tag, TeamName, type Status } from '@/components/ui'
import { MatchRow } from '@/components/match-row'
import { Confirm, SECONDARY_LINK } from '../../_ui'
import { makeDraw } from './actions'

/**
 * The reference half of the tournament page — SPEC A2/A3/A6.
 *
 * This used to be three standings tables and thirty-nine match rows printed one
 * after another, which was 5,000 of the page's 7,571 pixels and the reason
 * nobody could find the two rows that needed them. Same content, three cuts:
 * one category at a time (a radio group and `:has()`, so it is correct on first
 * paint with no JavaScript), the draw behind a disclosure, and the tiebreak
 * paragraph printed once rather than per category.
 *
 * Where `:has()` is unsupported the switcher degrades to every panel visible —
 * the long page it used to be, rather than a blank space.
 */

export type TableRowView = {
  teamId: string
  name: string
  played: number
  won: number
  pointsFor: number
  provisional: boolean
  disputed: boolean
  /** Straight from `standings()` — the step that actually settled this row. */
  reason?: string
}

export type MatchView = {
  id: string
  roundName: string
  nameA: string | null
  nameB: string | null
  gamesWonA: number
  gamesWonB: number
  winnerSide: 'A' | 'B' | null
  hasScore: boolean
  state: Status
  stateLabel: string
  scoreLine?: string
  courtName?: string
}

export type CategoryView = {
  id: string
  name: string
  advance: number
  finalsStage: string
  teams: number
  played: number
  total: number
  rows: TableRowView[]
  matches: MatchView[]
}

/**
 * What settled this row's position, in the organiser's words.
 *
 * This has to be read off the reason `standings()` produced, never
 * reconstructed from played/won: two pairs on 2 from 4 were both captioned
 * "Win rate · 2 from 4" — naming the one rule that did NOT separate them, on
 * the screen the organiser reads out to the pair who missed out. Points scored
 * separated them, and that is what the engine said.
 *
 * The same function, over the same reasons, is `positionNote` in
 * `src/app/t/[slug]/tables.tsx`. If one changes, change both.
 */
function positionNote(rows: TableRowView[], idx: number) {
  const row = rows[idx]
  if (!row.reason || row.played === 0) return null

  if (row.reason.startsWith('record')) {
    // The ordinary reason, printed six times, is noise — EXCEPT where a
    // neighbour is level on wins and the table therefore looks out of order.
    const levelOnWins = rows[idx - 1]?.won === row.won || rows[idx + 1]?.won === row.won
    if (!levelOnWins) return null
    return { text: `Win rate · ${row.won} from ${row.played}`, tone: 'neutral' as const }
  }
  if (row.reason.startsWith('drawn')) {
    return { text: 'Level — you decide', tone: 'alert' as const }
  }
  return { text: `Tiebreak · ${row.reason}`, tone: 'neutral' as const }
}

/** What the cut line says, in the words the organiser would use out loud. */
function cutLabel(c: CategoryView): string {
  if (c.finalsStage === 'final_only' && c.advance === 2) return 'Top 2 play the final'
  if (c.finalsStage === 'semis_and_final') return `Top ${c.advance} into the semi-finals`
  if (c.finalsStage === 'quarters_onward') return `Top ${c.advance} into the quarter-finals`
  return `Top ${c.advance} go through`
}

function StandingsTable({ cat }: { cat: CategoryView }) {
  const cut = cat.advance > 0 && cat.advance < cat.rows.length ? cat.advance : 0

  return (
    <Panel>
      <table className="w-full border-collapse">
        <caption className="sr-only">
          {cat.name} table{cut ? ` — ${cutLabel(cat)}` : ''}
        </caption>
        <thead>
          <tr className="bg-sunken">
            <th scope="col" className="font-score w-10 py-2.5 pr-1 pl-3 text-right text-eyebrow text-text-2 uppercase">
              <span aria-hidden>#</span>
              <span className="sr-only">Position</span>
            </th>
            <th scope="col" className="font-score py-2.5 text-left text-eyebrow text-text-2 uppercase">
              Team
            </th>
            <th scope="col" className="font-score w-9 py-2.5 text-right text-eyebrow text-text-2 uppercase">
              <span aria-hidden>Pld</span>
              <span className="sr-only">Played</span>
            </th>
            <th scope="col" className="font-score w-9 py-2.5 text-right text-eyebrow text-text-2 uppercase">
              Won
            </th>
            <th scope="col" className="font-score w-[4.25rem] py-2.5 pr-3 text-right text-eyebrow text-text-2 uppercase">
              <span aria-hidden>Scored</span>
              <span className="sr-only">Total points scored</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {cat.rows.map((row, idx) => {
            const through = cut > 0 && idx < cut
            const note = positionNote(cat.rows, idx)
            return (
              <Fragment key={row.teamId}>
                <tr className="border-t border-line align-middle">
                  <td
                    className={clsx(
                      'num border-l-4 py-3 pr-1 pl-3 text-right align-middle text-[22px] font-bold',
                      through ? 'border-l-accent-line text-accent' : 'border-l-transparent text-text',
                    )}
                  >
                    {idx + 1}
                    {through ? <span className="sr-only"> — qualifying position</span> : null}
                  </td>
                  <td className="min-w-0 py-3 pr-2 align-middle">
                    <TeamName name={row.name} />
                    {row.disputed || row.provisional || note ? (
                      <span className="mt-1.5 flex flex-wrap gap-1.5">
                        {row.disputed ? <Tag tone="alert">A result is under review</Tag> : null}
                        {row.provisional && !row.disputed ? (
                          <Tag tone="waiting">A result is not confirmed yet</Tag>
                        ) : null}
                        {note ? <Tag tone={note.tone}>{note.text}</Tag> : null}
                      </span>
                    ) : null}
                  </td>
                  <td className="num py-3 text-right align-middle text-num text-text-3">{row.played}</td>
                  <td className="num py-3 text-right align-middle text-num text-text">{row.won}</td>
                  <td className="num py-3 pr-3 text-right align-middle text-num font-bold text-text-2">
                    {row.pointsFor}
                  </td>
                </tr>

                {/* The line goes where the cut is — below the last team that
                    goes through, above the first that doesn't. That position
                    IS the information. */}
                {cut > 0 && idx === cut - 1 ? (
                  <tr>
                    <td colSpan={5} className="border-t-2 border-dashed border-accent-line bg-accent-soft px-4 py-1.5">
                      <span className="font-score text-eyebrow text-accent-hi uppercase">{cutLabel(cat)}</span>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </Panel>
  )
}

function CategoryBody({ cat, slug }: { cat: CategoryView; slug: string }) {
  if (cat.teams === 0) {
    return (
      <EmptyState title={`Nobody is in ${cat.name} yet`}>
        <p>Add pairs from the sign-ups screen, then make the draw.</p>
        <Link href={`/admin/t/${slug}/registrations`} className={clsx(SECONDARY_LINK, 'mt-3 max-w-[16rem]')}>
          Open sign-ups
        </Link>
      </EmptyState>
    )
  }

  if (cat.total === 0) {
    return (
      <EmptyState tone="accent" title="The draw hasn’t been made yet">
        <p>
          {cat.teams} pairs are in. Making the draw creates every match in {cat.name} and puts them
          on the board.
        </p>
        <Confirm
          className="mt-3 max-w-[18rem]"
          label="Make the draw"
          question={`Everyone plays everyone in ${cat.name} — ${cat.teams} pairs. You can still change any match afterwards.`}
        >
          <form action={makeDraw}>
            <input type="hidden" name="slug" value={slug} />
            <input type="hidden" name="categoryId" value={cat.id} />
            <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
              Make the draw
            </button>
          </form>
        </Confirm>
      </EmptyState>
    )
  }

  const rounds = [...new Set(cat.matches.map((m) => m.roundName))]

  return (
    <div className="flex flex-col gap-3">
      <p className="num text-meta text-text-2">
        {cat.teams} pairs · {cat.played} of {cat.total} played
      </p>

      <StandingsTable cat={cat} />

      {/* Thirty-nine match rows are reference, not a run-day screen. They stay
          in the document so find-in-page still reaches a pair's name. */}
      <Disclosure summary="Show the draw" meta={`${cat.total} matches, round by round`}>
        <Panel>
          {rounds.map((roundName, ri) => (
            <div key={roundName}>
              <p
                className={clsx(
                  'font-score bg-sunken px-4 py-2 text-eyebrow text-text-2 uppercase',
                  ri > 0 && 'border-t border-line-strong',
                )}
              >
                {roundName || 'Matches'}
              </p>
              <ul className="divide-y divide-line">
                {cat.matches
                  .filter((m) => m.roundName === roundName)
                  .map((m) => (
                    <li key={m.id}>
                      {/* Every row is a way into the escape hatch: tapping a
                          match is how a wrong score gets fixed. */}
                      <Link href={`/admin/m/${m.id}`} className="block hover:bg-ground">
                        <MatchRow
                          nameA={m.nameA}
                          nameB={m.nameB}
                          gamesWonA={m.gamesWonA}
                          gamesWonB={m.gamesWonB}
                          winnerSide={m.winnerSide}
                          hasScore={m.hasScore}
                          state={m.state}
                          stateLabel={m.stateLabel}
                          meta={m.scoreLine}
                          sub={m.courtName}
                        />
                      </Link>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </Panel>
      </Disclosure>
    </div>
  )
}

export function Draw({
  categories,
  slug,
  tiebreakNotes,
}: {
  categories: CategoryView[]
  slug: string
  tiebreakNotes: string[]
}) {
  const single = categories.length === 1

  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-section text-text">{single ? categories[0].name : 'Categories'}</h2>
        <div aria-hidden className="mt-1.5 h-[3px] w-10 rounded-full bg-accent-line" />
      </div>

      <fieldset className="switch min-w-0">
        <legend className="sr-only">Choose a category</legend>

        {single ? null : (
          <div className="mb-4 flex flex-wrap gap-2">
            {categories.map((c, i) => (
              <span key={c.id} className="flex min-w-0 grow basis-[6.5rem]">
                <input
                  type="radio"
                  name="admin-category"
                  id={`admin-cat-${i}`}
                  data-tab={i}
                  defaultChecked={i === 0}
                  className="peer sr-only"
                />
                <label
                  htmlFor={`admin-cat-${i}`}
                  className={clsx(
                    'flex min-h-[60px] w-full cursor-pointer items-center justify-center rounded-control',
                    'border px-2 py-2 text-center text-row text-balance',
                    'border-line-strong bg-paper text-text-2',
                    'peer-checked:border-ink peer-checked:bg-ink peer-checked:text-white',
                  )}
                >
                  {c.name}
                </label>
              </span>
            ))}
          </div>
        )}

        {categories.map((c, i) => (
          <div key={c.id} data-panel={i}>
            {single ? null : <h3 className="sr-only">{c.name}</h3>}
            <CategoryBody cat={c} slug={slug} />
          </div>
        ))}
      </fieldset>

      {tiebreakNotes.length ? (
        <Disclosure summary="How a position is decided" meta="The tiebreak, in full — once, here">
          <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
            {tiebreakNotes.map((note, i) => (
              <p key={note} className={clsx('text-body text-text-2', i > 0 && 'mt-3')}>
                {note}
              </p>
            ))}
            <p className="mt-3 text-body text-text-2">
              The table is ordered on win rate rather than on wins alone, so a pair with a match
              still to play is not held back by it. Where two rows are level on wins, both say what
              their record is.
            </p>
          </div>
        </Disclosure>
      ) : null}
    </section>
  )
}
