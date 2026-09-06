'use client'

import { useRouter } from 'next/navigation'
import { ScoreEntry, type ScoreEntryProps } from '@/components/score-entry'
import { saveResult } from './actions'

export function AdminEntry(
  props: Omit<ScoreEntryProps, 'onSubmit' | 'authoritative'> & { back: string },
) {
  const router = useRouter()
  return (
    <ScoreEntry
      {...props}
      authoritative
      onSubmit={async (payload) => {
        const res = await saveResult({
          matchId: props.matchId,
          games: payload.games,
          resultType: payload.resultType,
          winnerTeamId: payload.winnerTeamId,
          retiredTeamId: payload.retiredTeamId,
          excludeFromDiff: payload.excludeFromDiff,
          reason: payload.reason,
        })
        if (res.ok) router.push(props.back as never)
        return res
      }}
    />
  )
}
