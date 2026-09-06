import { Disclosure, Panel, SectionHead, Tag } from '@/components/ui'
import { MatchRow } from '@/components/match-row'

/**
 * Results — fourth in the order people want things, and thirty-nine rows of it
 * was two thirds of the old page. So: the last few, then everything else behind
 * one tap, grouped by category and round rather than poured out as one flat
 * list oldest-first.
 *
 * `details` keeps the closed content in the document, so find-in-page still
 * reaches the score of a match from two hours ago.
 */

export type ResultMatch = {
  id: string
  categoryName: string
  roundName: string | null
  nameA: string | null
  nameB: string | null
  gamesWonA: number
  gamesWonB: number
  winnerSide: 'A' | 'B' | null
  scoreLine: string | null
  provisional: boolean
  startedAt: Date | string | null
  endedAt: Date | string | null
  resultType: 'normal' | 'bye' | 'walkover' | 'retired' | 'cancelled'
}

const LATEST = 3

/**
 * When it finished, falling back to when it started. A match scored on paper
 * never went "on court" and has no `startedAt`, but every result has an
 * `endedAt` the moment it is entered — which is what "newest" means to someone
 * refreshing the page.
 */
function time(m: ResultMatch): number {
  const t = m.endedAt ?? m.startedAt
  return t ? new Date(t).getTime() : -1
}

/** Newest first; anything with no timestamp at all falls back to draw order. */
function newestFirst(results: ResultMatch[]): ResultMatch[] {
  return results
    .map((m, i) => ({ m, i }))
    .sort((x, y) => time(y.m) - time(x.m) || y.i - x.i)
    .map((r) => r.m)
}

function Row({ m, context = true }: { m: ResultMatch; context?: boolean }) {
  // A no-show records a scoreline for the record, and printing it puts game
  // scores on a match nobody played. The games column still says who went
  // through; the line that says nobody hit a ball is the tag.
  const walkover = m.resultType === 'walkover'
  const notes = [
    walkover ? <Tag key="w">No-show — not played</Tag> : null,
    m.resultType === 'retired' ? <Tag key="r">Stopped mid-match</Tag> : null,
    m.provisional ? (
      <Tag key="p" tone="waiting">
        Not confirmed yet
      </Tag>
    ) : null,
  ].filter(Boolean)

  return (
    <MatchRow
      nameA={m.nameA}
      nameB={m.nameB}
      gamesWonA={m.gamesWonA}
      gamesWonB={m.gamesWonB}
      winnerSide={m.winnerSide}
      hasScore
      state={m.provisional ? 'waiting' : 'done'}
      stateLabel="Final"
      sub={context ? `${m.categoryName}${m.roundName ? ` · ${m.roundName}` : ''}` : undefined}
      meta={walkover ? undefined : (m.scoreLine ?? undefined)}
      note={notes.length ? notes : undefined}
    />
  )
}

export function Results({
  results,
  categoryOrder,
}: {
  results: ResultMatch[]
  /** Category names in the organiser's order, so the groups match the tables. */
  categoryOrder: string[]
}) {
  if (results.length === 0) return null

  const ordered = newestFirst(results)
  const latest = ordered.slice(0, LATEST)
  const rest = results.length - latest.length

  const byCategory = categoryOrder
    .map((name) => ({
      name,
      matches: results.filter((m) => m.categoryName === name),
    }))
    .filter((g) => g.matches.length > 0)

  return (
    <section className="flex flex-col gap-4">
      <SectionHead title="Results" meta={`${results.length} played · newest first`} />

      <Panel>
        <ul className="divide-y divide-line">
          {latest.map((m) => (
            <li key={m.id}>
              <Row m={m} />
            </li>
          ))}
        </ul>
      </Panel>

      {rest > 0 ? (
        <Disclosure summary={`All ${results.length} results`} meta="By category and round">
          <div className="flex flex-col gap-5">
            {byCategory.map((group) => {
              const rounds = [...new Set(group.matches.map((m) => m.roundName ?? ''))]
              return (
                <div key={group.name}>
                  <h3 className="mb-2 text-row text-text">{group.name}</h3>
                  <Panel>
                    {rounds.map((round) => (
                      <div key={round || 'unnamed'}>
                        {round ? (
                          <p className="font-score border-b border-line bg-sunken px-4 py-2 text-eyebrow text-text-2 uppercase">
                            {round}
                          </p>
                        ) : null}
                        <ul className="divide-y divide-line">
                          {group.matches
                            .filter((m) => (m.roundName ?? '') === round)
                            .map((m) => (
                              <li key={m.id}>
                                <Row m={m} context={false} />
                              </li>
                            ))}
                        </ul>
                      </div>
                    ))}
                  </Panel>
                </div>
              )
            })}
          </div>
        </Disclosure>
      ) : null}
    </section>
  )
}
