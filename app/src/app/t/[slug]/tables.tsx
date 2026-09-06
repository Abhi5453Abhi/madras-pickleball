import { Fragment } from 'react'
import { clsx } from 'clsx'
import { Disclosure, Panel, SectionHead, Tag, TeamName } from '@/components/ui'

/**
 * The pool tables — SPEC A6/A8.
 *
 * Three tables stacked was most of why this page was forty screens long, and
 * nobody reads a category they are not in. One is shown at a time by a radio
 * group and `:has()`: no JavaScript, correct on first paint, still a real
 * radiogroup for a screen reader, and where `:has()` is unsupported it degrades
 * to all three rather than to none.
 *
 * The qualifying line is a labelled rule across the table, not a colour on a
 * row. Someone reading this in the sun has to see where the cut is without
 * counting rows or knowing what terracotta means.
 */

export type TableRow = {
  teamId: string
  name: string
  players: string[]
  played: number
  won: number
  pointsFor: number
  reason?: string
  provisional: boolean
  disputed: boolean
  /** Pulled out or disqualified. Their played matches still stand (SPEC A7). */
  withdrawn: boolean
}

export type CategoryTable = {
  id: string
  name: string
  advance: number
  finalsStage: string
  tiebreakNote: string
  rows: TableRow[]
}

/** What the cut line says, in the words the organiser would use out loud. */
function cutLabel(t: CategoryTable): string {
  if (t.finalsStage === 'final_only' && t.advance === 2) return 'Top 2 play the final'
  if (t.finalsStage === 'semis_and_final') return `Top ${t.advance} into the semi-finals`
  return `Top ${t.advance} go through`
}

/**
 * `standings()` tags every row with the step that settled it, including the
 * ordinary one, and printing "you are 4th because you won fewer" forty times is
 * noise. So the ordinary reason is dropped — EXCEPT in the one case where the
 * table looks broken without it.
 *
 * Two pairs on three wins each, one from four matches and one from five, are
 * separated by win RATE. Read down the column, the pair with more points scored
 * is below the pair with fewer — which is the venue's headline rule apparently
 * being ignored, and it is exactly what someone comes to the desk about. So
 * wherever a neighbouring row has the same number of wins, both rows say what
 * their record is. Where the records differ plainly — five wins above two — the
 * caption is dead weight and stays off.
 */
function positionNote(rows: TableRow[], idx: number) {
  const row = rows[idx]
  if (!row.reason || row.played === 0) return null

  if (row.reason.startsWith('record')) {
    const above = rows[idx - 1]
    const below = rows[idx + 1]
    const levelOnWins = above?.won === row.won || below?.won === row.won
    if (!levelOnWins) return null
    // Built from the row's own numbers rather than parsed out of the engine's
    // sentence: the engine says WHICH step decided it, this says it in the
    // words the organiser would use standing at the net post.
    return { text: `Win rate · ${row.won} from ${row.played}`, tone: 'neutral' as const }
  }

  if (row.reason.startsWith('drawn')) {
    return { text: 'Level — the organiser decides', tone: 'alert' as const }
  }
  if (row.reason === 'ahead on head-to-head') {
    return { text: 'Tiebreak · ahead on head-to-head', tone: 'neutral' as const }
  }
  if (row.reason === 'behind on head-to-head') {
    return { text: 'Tiebreak · behind on head-to-head', tone: 'neutral' as const }
  }
  return { text: `Tiebreak · ${row.reason}`, tone: 'neutral' as const }
}

function StandingsTable({ table }: { table: CategoryTable }) {
  const nothingPlayed = table.rows.every((r) => r.played === 0)
  const cut = table.advance > 0 && table.advance < table.rows.length ? table.advance : 0

  return (
    <Panel>
      <table className="w-full border-collapse">
        <caption className="sr-only">
          {table.name} table{cut ? ` — ${cutLabel(table)}` : ''}
        </caption>
        <thead>
          <tr className="bg-sunken">
            <th
              scope="col"
              className="font-score w-10 py-2.5 pr-1 pl-3 text-right text-eyebrow text-text-2 uppercase"
            >
              <span aria-hidden>#</span>
              <span className="sr-only">Position</span>
            </th>
            <th
              scope="col"
              className="font-score py-2.5 text-left text-eyebrow text-text-2 uppercase"
            >
              Team
            </th>
            {/* The three number columns are right-aligned against each other,
                so each one needs its gap on the LEFT — without it "Won" and
                "Scored" ran together into one word in the header. The eyebrow's
                0.08em tracking is dropped here for the same reason: it is worth
                8px of a 390px screen, and these are three known words, not
                copy. */}
            <th
              scope="col"
              className="font-score w-9 py-2.5 pl-2 text-right text-eyebrow tracking-[0.03em] whitespace-nowrap text-text-2 uppercase"
            >
              <span aria-hidden>Pld</span>
              <span className="sr-only">Played</span>
            </th>
            <th
              scope="col"
              className="font-score w-9 py-2.5 pl-2 text-right text-eyebrow tracking-[0.03em] whitespace-nowrap text-text-2 uppercase"
            >
              Won
            </th>
            <th
              scope="col"
              className="font-score w-[3.75rem] py-2.5 pr-3 pl-2 text-right text-eyebrow tracking-[0.03em] whitespace-nowrap text-text-2 uppercase"
            >
              <span aria-hidden>Scored</span>
              <span className="sr-only">Total points scored</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, idx) => {
            const through = cut > 0 && idx < cut
            const tb = positionNote(table.rows, idx)
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
                    <TeamName name={row.name} players={row.players} muted={row.withdrawn} />
                    {row.provisional || row.disputed || row.withdrawn || tb ? (
                      <span className="mt-1.5 flex flex-wrap gap-1.5">
                        {row.withdrawn ? <Tag>Withdrew — matches played still count</Tag> : null}
                        {row.disputed ? <Tag tone="alert">A result is under review</Tag> : null}
                        {row.provisional && !row.disputed ? (
                          <Tag tone="waiting">A result is not confirmed yet</Tag>
                        ) : null}
                        {tb ? <Tag tone={tb.tone}>{tb.text}</Tag> : null}
                      </span>
                    ) : null}
                  </td>
                  <td className="num py-3 pl-2 text-right align-middle text-num text-text-3">
                    {row.played}
                  </td>
                  <td className="num py-3 pl-2 text-right align-middle text-num text-text">
                    {row.won}
                  </td>
                  <td className="num py-3 pr-3 pl-2 text-right align-middle text-num font-bold text-text-2">
                    {row.pointsFor}
                  </td>
                </tr>

                {/* The line goes where the cut is, not at the bottom of the
                    table: below the last team that goes through, above the
                    first that doesn't. That position IS the information. */}
                {cut > 0 && idx === cut - 1 ? (
                  <tr>
                    <td
                      colSpan={5}
                      className="border-t-2 border-dashed border-accent-line bg-accent-soft px-4 py-1.5"
                    >
                      <span className="font-score text-eyebrow text-accent-hi uppercase">
                        {cutLabel(table)}
                      </span>
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            )
          })}

          {table.rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-4 text-body text-text-2">
                No pairs entered yet.
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {nothingPlayed && table.rows.length > 0 ? (
        <p className="border-t border-line bg-sunken px-4 py-3 text-meta text-text-2">
          Nothing played yet — the table fills in as results land.
        </p>
      ) : null}
    </Panel>
  )
}

/**
 * A table whose advance count equals its size — everyone goes through — draws
 * no cut line at all; see `cut` above. Splitting the rows into two tbodies
 * would have been tidier markup and the wrong thing: it breaks the row
 * numbering a screen reader announces.
 */
export function Tables({ tables }: { tables: CategoryTable[] }) {
  if (tables.length === 0) return null

  const notes = [...new Set(tables.map((t) => t.tiebreakNote))]
  const single = tables.length === 1

  return (
    <section id="tables" className="flex flex-col gap-4">
      <SectionHead
        title={single ? tables[0].name : 'Tables'}
        meta={single ? `${tables[0].rows.length} teams` : undefined}
      />

      <fieldset className="switch min-w-0">
        <legend className="sr-only">Choose a category</legend>

        {single ? null : (
          <div className="mb-4 flex flex-wrap gap-2 print:hidden">
            {tables.map((t, i) => (
              <span key={t.id} className="flex min-w-0 grow basis-[6.5rem]">
                <input
                  type="radio"
                  name="category-table"
                  id={`cat-tab-${i}`}
                  data-tab={i}
                  defaultChecked={i === 0}
                  className="peer sr-only"
                />
                <label
                  htmlFor={`cat-tab-${i}`}
                  className={clsx(
                    'flex min-h-[60px] w-full cursor-pointer items-center justify-center rounded-control',
                    'border px-2 py-2 text-center text-row text-balance',
                    'border-line-key bg-paper text-text-2',
                    'peer-checked:border-ink peer-checked:bg-ink peer-checked:text-white',
                  )}
                >
                  {t.name}
                </label>
              </span>
            ))}
          </div>
        )}

        {tables.map((t, i) => (
          <div key={t.id} data-panel={i}>
            {single ? null : (
              <h3 className="sr-only print:not-sr-only print:mb-2 print:text-section">{t.name}</h3>
            )}
            <StandingsTable table={t} />
          </div>
        ))}
      </fieldset>

      <Disclosure
        summary="How a position is decided"
        meta="The tiebreak, in full — once, here"
      >
        <div className="rounded-card border border-line-strong bg-paper p-4 shadow-card">
          {notes.map((note, i) => (
            <p key={i} className={clsx('text-body text-text-2', i > 0 && 'mt-3')}>
              {notes.length > 1 ? (
                <span className="block text-row text-text">
                  {tables.filter((t) => t.tiebreakNote === note).map((t) => t.name).join(', ')}
                </span>
              ) : null}
              {note}
            </p>
          ))}
          <p className="mt-3 text-body text-text-2">
            <span className="text-row text-text">Before any of that</span>, the table is ordered on
            win rate rather than on wins alone: three wins from four is placed above three from
            five, so a pair with a match still to play is not held back by it. Where two rows are
            level on wins, both say what their record is.
          </p>
          <p className="mt-3 text-body text-text-2">
            <span className="text-row text-text">Scored</span> is every point that pair has won all
            day, not league points. A result stays{' '}
            <span className="text-row text-text">not confirmed</span> for ten minutes after it is
            entered, and counts in the table the whole time.
          </p>
        </div>
      </Disclosure>
    </section>
  )
}
