import type { Discipline, FinalsStage, Gender } from '@/api/contract'

/**
 * The pure word helpers the reference kept on the server. `events.formatWords`,
 * `events.categoryName`, `registration.signupsClosed` and `lib/standings`'
 * `tieNote` are all pure, so they come over rather than becoming RPCs (see the
 * "Reference functions that are NOT RPCs" note at the top of docs/GO-API.ts).
 */

export const GENDER_WORDS: Record<Gender, string> = {
  mens: "Men's",
  womens: "Women's",
  mixed: 'Mixed',
  any: 'Open',
}

export const FORMAT_WORDS: Record<FinalsStage, string> = {
  none: 'everyone plays everyone',
  final_only: 'league, then a final',
  semis_and_final: 'league, then semis and a final',
}

/** Older rows may carry a stage the draw builder folds into semis. */
export function formatWords(stage: string) {
  return FORMAT_WORDS[(stage in FORMAT_WORDS ? stage : 'semis_and_final') as FinalsStage]
}

export function categoryName(gender: Gender, discipline: Discipline) {
  return `${GENDER_WORDS[gender]} ${discipline === 'singles' ? 'Singles' : 'Doubles'}`
}

/**
 * Sign-ups are closed when the organiser closed them, or once the tournament
 * is no longer being set up.
 */
export function signupsClosed(t: { status: string; registrationClosedAt: string | null }) {
  return !!t.registrationClosedAt || t.status === 'live' || t.status === 'completed'
}

/**
 * Why a table row sits where it does — but only where that is news. Wins and
 * points are the two columns beside the name; repeating them is noise, and
 * "nothing separates them YET" is not a decision for anyone to make.
 */
export function tieNote(reason: string | null | undefined, leagueDone: boolean): string | null {
  if (!reason) return null
  if (/\bwins\b/.test(reason) || /total points scored/.test(reason)) return null
  if (reason.startsWith('drawn')) {
    return leagueDone ? 'level on everything — kept in the order the pairs were made' : 'level so far'
  }
  return reason
}

/** "Court 1, Court 2" is how the database says it; "Courts 1, 2" is how a person does. */
export function courtsLabel(names: string[]) {
  if (!names.length) return 'no courts'
  const nums = names.map((n) => /^Court (\d+)$/.exec(n)?.[1])
  if (names.length > 1 && nums.every(Boolean)) return `Courts ${nums.join(', ')}`
  return names.join(', ')
}

/**
 * The table, one entry per pool. Eight pairs or more are drawn into pools and
 * the cut goes through from EACH of them, so the screens draw one table per
 * pool rather than one merged list that puts a qualified pair below the line.
 * The server sends the rows pool by pool in draw order, so this only has to
 * keep the order it was given. A league is a single entry whose name is null,
 * and renders exactly as it always did.
 */
export function poolTables<T extends { group: string | null }>(rows: T[]) {
  const out: Array<{ name: string | null; rows: T[] }> = []
  for (const row of rows) {
    const last = out[out.length - 1]
    if (last && last.name === row.group) last.rows.push(row)
    else out.push({ name: row.group, rows: [row] })
  }
  return out
}

/**
 * The line under the cut. One table of four with a final: the top two play it,
 * and saying so is the clearest thing on the screen. Two pools: the top two of
 * each are through to a knockout nobody has been drawn into yet, so "go
 * through" is all that is true.
 */
export function cutWords(cut: number, tables: number) {
  return `Top ${cut} ${cut === 2 && tables === 1 ? 'play the final' : 'go through'}`
}
