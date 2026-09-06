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
          submittingTeamId: payload.submittingTeamId,
        })
        if (res.ok) router.refresh()
        return res
      }}
    />
  )
}
