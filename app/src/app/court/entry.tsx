'use client'

import { useRouter } from 'next/navigation'
import { ScoreEntry, type ScoreEntryProps } from '@/components/score-entry'
import { courtSubmit } from './actions'

export function CourtEntry(props: Omit<ScoreEntryProps, 'onSubmit' | 'authoritative'>) {
  const router = useRouter()
  return (
    <ScoreEntry
      {...props}
      authoritative={false}
      /**
       * Best-of-3 means a pair can put game 1 in, walk off for a drink, and
       * come back after game 2 — and until this key existed nothing was stored
       * anywhere until submit. Scoped to the match, so the next pair on this
       * court never inherits it.
       */
      persistKey={`mpb.court.draft.${props.matchId}`}
      onSubmit={async (payload) => {
        const res = await courtSubmit({
          matchId: props.matchId,
          games: payload.games,
          resultType: payload.resultType,
          winnerTeamId: payload.winnerTeamId,
          retiredTeamId: payload.retiredTeamId,
          // Dropping this was silently inflating the points-scored column with
          // games nobody played — the exact number the venue's tiebreak turns on.
          excludeFromDiff: payload.excludeFromDiff,
          submittingTeamId: payload.submittingTeamId,
        })
        if (res.ok) router.refresh()
        return res
      }}
    />
  )
}
