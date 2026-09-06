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
