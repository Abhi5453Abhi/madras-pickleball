import type { BoardData, BoardMatch } from '@/server/board'

/**
 * Which match to offer each free court.
 *
 * Each free court is offered a DIFFERENT match — and never one that shares a
 * player with a match already offered somewhere else. Handing Court 1 and
 * Court 2 two matches that both contain Ravi meant the organiser tapped both
 * and the second was refused, which is the exact collision the board exists to
 * prevent.
 *
 * Lives here rather than inside the board page because the tournament page's
 * attention block offers the same courts the same matches, and two functions
 * that disagree about which pair is next is worse than either answer.
 */
export function offersForFreeCourts(data: BoardData): Map<string, BoardMatch> {
  const placeable = data.queue.filter((m) => m.ready && !m.blockedBy)
  const freeCourts = data.courts.filter((c) => !c.closed && !c.live)

  const offers = new Map<string, BoardMatch>()
  const taken = new Set<string>()
  const spokenFor = new Set<string>()

  for (const court of freeCourts) {
    const pick = placeable.find(
      (m) => !taken.has(m.id) && !m.playerIds.some((p) => spokenFor.has(p)),
    )
    if (!pick) continue
    offers.set(court.id, pick)
    taken.add(pick.id)
    for (const p of pick.playerIds) spokenFor.add(p)
  }
  return offers
}
