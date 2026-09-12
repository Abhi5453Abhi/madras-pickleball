import 'server-only'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db, transact } from '@/db'
import {
  categories,
  categoryPlayers,
  courtHolds,
  courts,
  matches,
  pendingRegistrations,
  teamPlayers,
  teams,
  tournamentPlayers,
  tournaments,
} from '@/db/schema'
import { newId } from '@/lib/ids'
import { bumpStreamVersion } from '@/lib/stream'
import { venueClock, venueDayKey } from '@/lib/time'
import { flowTournament } from './board'
import {
  clashSentence,
  courtNames,
  courtsHeldBy,
  CourtTaken,
  dayEnd,
  dayStart,
  endHoldsAt,
  holdsBetween,
  releaseHolds,
  isWriteConflict,
  planFor,
  savedAtOnce,
  setHolds,
  takenNow,
  tournamentWindows,
  type Window,
} from './courts'
import { createCategory, createTournament, getVenue, standingsFor } from './tournaments'

/**
 * A tournament is one category — SPEC v4.
 *
 * "Men's Doubles" and "Mixed Doubles" on the same Sunday are two tournaments,
 * each with its own players, format, courts and table. The database still has
 * a `tournaments` row above a `categories` row, because the rules engine hangs
 * off the category and rewriting that would be a migration for no product
 * gain. This module is the seam: every tournament has exactly one category,
 * created together, and nothing above this line ever shows the difference.
 */

export type Gender = 'mens' | 'womens' | 'mixed' | 'any'
export type Discipline = 'singles' | 'doubles'
export type FinalsStage = 'none' | 'final_only' | 'semis_and_final'

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

export type CreateInput = {
  name: string
  date: Date
  /** How many days it runs, starting on `date`. One unless somebody says. */
  days?: number
  gender: Gender
  discipline: Discipline
  finalsStage: FinalsStage
  courtIds: string[]
  /** Null, or left out, holds the courts for the whole day. */
  hours?: Hours | null
}

export async function createEvent(input: CreateInput) {
  // A two-day tournament holds its courts on both days. The old model could not
  // represent that at all — `unique (tournament_id, court_id)` meant a court
  // could be claimed once, ever — so nothing above this line ever asked.
  const days = Math.min(Math.max(Math.round(input.days ?? 1), 1), 14)
  const tournament = await createTournament({
    name: input.name,
    startDate: input.date,
    endDate: new Date(input.date.getTime() + (days - 1) * 24 * 60 * 60_000),
  })
  const catId = await createCategory({
    tournamentId: tournament.id,
    name: categoryName(input.gender, input.discipline),
    discipline: input.discipline,
    gender: input.gender,
    finalsStage: input.finalsStage,
  })
  const courtsResult = await assignCourts(tournament.id, input.courtIds, input.hours ?? null)
  // Sign-ups open the moment it exists: the link is the first thing the
  // organiser wants, and "draft" was a state nobody could explain.
  await db
    .update(tournaments)
    .set({ status: 'registration', publishedAt: new Date() })
    .where(eq(tournaments.id, tournament.id))
  return { tournament, categoryId: catId, courts: courtsResult }
}

/** The one category a tournament has. Throws if the seam is broken. */
export async function primaryCategory(tournamentId: string) {
  const [cat] = await db
    .select()
    .from(categories)
    .where(and(eq(categories.tournamentId, tournamentId), isNull(categories.deletedAt)))
    .orderBy(asc(categories.seq))
    .limit(1)
  if (!cat) throw new Error(`Tournament ${tournamentId} has no category.`)
  return cat
}

/**
 * A tournament is one category, so the category's player list IS the roster.
 * Call after anything that adds or removes a player: the substitution tools
 * and the pairing screen read the category list, not the roster.
 */
export async function syncCategoryPlayers(tournamentId: string) {
  const category = await primaryCategory(tournamentId)
  const roster = await db
    .select({ playerId: tournamentPlayers.playerId })
    .from(tournamentPlayers)
    .where(and(eq(tournamentPlayers.tournamentId, tournamentId), eq(tournamentPlayers.withdrawn, false)))
  await transact(async (tx) => {
    await tx.delete(categoryPlayers).where(eq(categoryPlayers.categoryId, category.id))
    if (roster.length) {
      await tx.insert(categoryPlayers).values(
        roster.map((r) => ({ id: newId('cp'), categoryId: category.id, playerId: r.playerId })),
      )
    }
  })
}

// ───────────────────────────── courts ─────────────────────────────

/** The hours a tournament holds its courts, or null for the whole day. */
export type Hours = { fromMin: number; untilMin: number }

export type CourtOption = {
  id: string
  name: string
  colorKey: string
  /** Set when somebody else has it during these hours. */
  takenBy: { name: string; label: string } | null
  /** This tournament holds it. */
  mine: boolean
}

/**
 * The hours this tournament's courts are held for. Null is the whole day, which
 * is what every tournament held before hours existed.
 *
 * Stored on the row, not read back off the holds: a hold taken up at eleven, or
 * truncated when the tournament finished, says nothing about the hours the
 * organiser asked for — and reading it back as if it did moved every other day
 * of a two-day tournament to match the one day that had been clamped.
 */
export async function tournamentHours(tournamentId: string): Promise<Hours | null> {
  const [t] = await db
    .select({ fromMin: tournaments.courtFromMin, untilMin: tournaments.courtUntilMin })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1)
  if (!t || t.fromMin === null || t.untilMin === null) return null
  return { fromMin: t.fromMin, untilMin: t.untilMin }
}

async function windowsFor(tournamentId: string, hours: Hours | null | undefined): Promise<Window[] | null> {
  const [t] = await db
    .select({ startDate: tournaments.startDate, endDate: tournaments.endDate })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1)
  if (!t) return null
  const effective = hours === undefined ? await tournamentHours(tournamentId) : hours
  return tournamentWindows(t.startDate, t.endDate, effective)
}

/**
 * Every court at the venue, with who has it during the hours this tournament
 * wants. A court somebody else has is shown, named with the hours they have it
 * for, and not pickable — the organiser resolves that on the other holder.
 *
 * Passing `hours` asks the question for hours not saved yet, which is what the
 * screen does while the organiser is still choosing them.
 */
export async function courtOptions(tournamentId: string, hours?: Hours | null): Promise<CourtOption[]> {
  const windows = await windowsFor(tournamentId, hours)
  if (!windows) return []
  const venue = await getVenue()

  const [allCourts, mine] = await Promise.all([
    db
      .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
      .from(courts)
      .where(and(eq(courts.venueId, venue.id), eq(courts.active, true)))
      .orderBy(asc(courts.sortOrder)),
    courtsHeldBy({ kind: 'tournament', tournamentId }),
  ])
  const mineIds = new Set(mine.map((c) => c.id))
  const { unplaceable, clashes } = await planFor(
    { kind: 'tournament', tournamentId },
    allCourts.map((c) => c.id),
    windows,
  )
  const byCourt = new Map(clashes.map((c) => [c.courtId, c]))
  const gone = new Set(unplaceable)

  return allCourts.map((c) => {
    const clash = byCourt.get(c.id)
    return {
      id: c.id,
      name: c.name,
      colorKey: c.colorKey,
      mine: mineIds.has(c.id),
      takenBy: clash
        ? { name: clash.holderName, label: hoursLabel(clash.heldFrom, clash.heldUntil) }
        : // Nothing left of those hours at all — a court that is not free and
          // has nobody to name is still not a court this tournament can have,
          // and showing it as pickable means a save that refuses.
          gone.has(c.id)
          ? { name: 'nothing free', label: 'in these hours' }
          : null,
    }
  })
}

/** "9:00 am–3:00 pm", or "all day" when it is the whole of one. */
export function hoursLabel(from: Date, until: Date): string {
  const key = venueDayKey(from)
  if (from.getTime() <= dayStart(key).getTime() && until.getTime() >= dayEnd(key).getTime()) return 'all day'
  return `${venueClock(from)}–${venueClock(until)}`
}

export type CalendarHold = {
  courtId: string
  dayKey: string
  holderName: string
  slug: string | null
  /** Minutes from the start of that venue day, clipped to it. */
  fromMin: number
  untilMin: number
}

/**
 * For the create form, which has no tournament yet: every court, and who has
 * which court when, for the next few weeks. The form filters by the day and
 * hours that are picked; the server re-checks on submit, and the index is what
 * actually decides.
 */
export async function courtCalendar(days = 30) {
  const venue = await getVenue()
  const todayKey = venueDayKey(new Date())
  const from = dayStart(todayKey)
  const until = new Date(from.getTime() + days * 24 * 60 * 60_000)

  const [allCourts, held] = await Promise.all([
    db
      .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
      .from(courts)
      .where(and(eq(courts.venueId, venue.id), eq(courts.active, true)))
      .orderBy(asc(courts.sortOrder)),
    holdsBetween(from, until),
  ])

  // A hold is split across the days it touches, because the form asks its
  // question one day at a time.
  const spread: CalendarHold[] = []
  for (const h of held) {
    let cursor = dayStart(venueDayKey(h.heldFrom))
    while (cursor.getTime() < h.heldUntil.getTime()) {
      const key = venueDayKey(cursor)
      const base = dayStart(key).getTime()
      const dayFinish = dayEnd(key).getTime()
      const segFrom = Math.max(h.heldFrom.getTime(), base)
      const segUntil = Math.min(h.heldUntil.getTime(), dayFinish)
      if (segUntil > segFrom && segUntil > from.getTime()) {
        spread.push({
          courtId: h.courtId,
          dayKey: key,
          holderName: h.holderName,
          slug: h.holderSlug,
          fromMin: Math.round((segFrom - base) / 60_000),
          untilMin: Math.round((segUntil - base) / 60_000),
        })
      }
      cursor = new Date(dayFinish)
    }
  }
  return { courts: allCourts, held: spread }
}

export type CourtCalendar = Awaited<ReturnType<typeof courtCalendar>>

/**
 * Set a tournament's courts to exactly this list, for exactly these hours.
 *
 * Names whoever already has a court instead of taking it: a court is a physical
 * thing and two organisers cannot both be right about it. The sentence is
 * produced by reading; the guarantee is the slot index, which is why the write
 * is still wrapped — between the read and the write is exactly where the other
 * organiser presses Save.
 */
export async function assignCourts(tournamentId: string, courtIds: string[], hours?: Hours | null) {
  const wanted = [...new Set(courtIds.filter(Boolean))]
  const hoursAsked = hours
  const windows = await windowsFor(tournamentId, hours)
  if (!windows) return { ok: false as const, error: 'That tournament no longer exists.' }

  const venue = await getVenue()
  const here = await db
    .select({ id: courts.id })
    .from(courts)
    .where(and(eq(courts.venueId, venue.id), eq(courts.active, true)))
  const hereIds = new Set(here.map((c) => c.id))
  for (const id of wanted) {
    if (!hereIds.has(id)) return { ok: false as const, error: 'That court is not at this venue.' }
  }

  // A court being removed with a live match on it is not ours to pull away
  // from under the players.
  const mine = await courtsHeldBy({ kind: 'tournament', tournamentId })
  const removing = mine.filter((c) => !wanted.includes(c.id)).map((c) => c.id)
  if (removing.length) {
    const [live] = await db
      .select({ courtName: courts.name })
      .from(matches)
      .innerJoin(courts, eq(courts.id, matches.courtId))
      .where(
        and(
          eq(matches.tournamentId, tournamentId),
          eq(matches.status, 'live'),
          inArray(matches.courtId, removing),
        ),
      )
      .limit(1)
    if (live) {
      return {
        ok: false as const,
        error: `There is a match on ${live.courtName} right now. Let it finish, then take the court off.`,
      }
    }
  }

  const now = new Date()
  if (wanted.length && !windows.some((w) => w.until.getTime() > now.getTime())) {
    return { ok: false as const, error: 'Those hours have already gone — a court can’t be held in the past.' }
  }

  const { unplaceable, clashes } = await planFor({ kind: 'tournament', tournamentId }, wanted, windows, now)
  if (clashes.length) return { ok: false as const, error: clashSentence(clashes[0]) }
  if (unplaceable.length) {
    const names = await courtNames(unplaceable)
    return {
      ok: false as const,
      error: `There is nothing left of those hours on ${names}. Change the hours, or pick another court.`,
    }
  }

  let held: string[] | null
  try {
    held = await transact(async (tx) => {
      // Re-asserted here, in the transaction, so this serialises against
      // `finishEvent` — which takes the same row and then gives the courts
      // back. Without it, a save that started a moment earlier could re-take
      // courts for a tournament that has just finished, and nothing would ever
      // release them.
      const [still] = await tx
        .update(tournaments)
        .set({
          updatedAt: now,
          courtFromMin: hoursAsked === undefined ? undefined : (hoursAsked?.fromMin ?? null),
          courtUntilMin: hoursAsked === undefined ? undefined : (hoursAsked?.untilMin ?? null),
        })
        .where(
          and(
            eq(tournaments.id, tournamentId),
            isNull(tournaments.deletedAt),
            inArray(tournaments.status, ['draft', 'registration', 'live']),
          ),
        )
        .returning({ id: tournaments.id })
      if (!still) return null
      return setHolds(tx, { kind: 'tournament', tournamentId }, wanted, windows, {}, now)
    })
  } catch (e) {
    if (e instanceof CourtTaken) return { ok: false as const, error: takenNow }
    if (isWriteConflict(e)) return { ok: false as const, error: savedAtOnce }
    throw e
  }
  if (held === null) {
    return { ok: false as const, error: 'That tournament has finished — its courts are back with the venue.' }
  }

  await bumpStreamVersion(tournamentId)
  // A court added to a running tournament is a free court: fill it.
  await flowTournament(tournamentId)
  return { ok: true as const, count: held.length }
}

/** The courts this tournament holds, in venue order, once each. */
export async function myCourts(tournamentId: string) {
  return courtsHeldBy({ kind: 'tournament', tournamentId })
}

// ─────────────────────────── registration ───────────────────────────

export async function closeRegistration(tournamentId: string) {
  await db
    .update(tournaments)
    .set({ registrationClosedAt: new Date(), updatedAt: new Date() })
    .where(eq(tournaments.id, tournamentId))
  await bumpStreamVersion(tournamentId)
}

export async function reopenRegistration(tournamentId: string) {
  await db
    .update(tournaments)
    .set({ registrationClosedAt: null, updatedAt: new Date() })
    .where(eq(tournaments.id, tournamentId))
  await bumpStreamVersion(tournamentId)
}

// ───────────────────────────── dashboard ─────────────────────────────

export type DashboardRow = {
  id: string
  slug: string
  name: string
  startDate: Date
  status: 'draft' | 'registration' | 'live' | 'completed' | 'archived'
  category: string
  discipline: Discipline
  format: FinalsStage
  players: number
  teams: number
  courts: Array<{ id: string; name: string; colorKey: string }>
  matchesTotal: number
  matchesPlayed: number
  matchesLive: number
  registrationOpen: boolean
  pendingSignups: number
  winnerName: string | null
}

export async function dashboard(): Promise<{
  today: DashboardRow[]
  upcoming: DashboardRow[]
  finished: DashboardRow[]
}> {
  const rows = await db
    .select({
      t: tournaments,
      cat: categories,
    })
    .from(tournaments)
    .innerJoin(categories, eq(categories.tournamentId, tournaments.id))
    .where(and(isNull(tournaments.deletedAt), isNull(categories.deletedAt)))
    .orderBy(desc(tournaments.startDate), asc(tournaments.createdAt))
    .limit(40)
  if (rows.length === 0) return { today: [], upcoming: [], finished: [] }

  const ids = rows.map((r) => r.t.id)
  const [matchAgg, playerAgg, teamAgg, courtRows, signupAgg, finals] = await Promise.all([
    db
      .select({
        tournamentId: matches.tournamentId,
        total: sql<number>`cast(count(*) as int)`,
        played: sql<number>`cast(count(*) filter (where ${matches.resultState} in ('final','reported')) as int)`,
        live: sql<number>`cast(count(*) filter (where ${matches.status} = 'live') as int)`,
      })
      .from(matches)
      .where(inArray(matches.tournamentId, ids))
      .groupBy(matches.tournamentId),
    db
      .select({
        tournamentId: tournamentPlayers.tournamentId,
        n: sql<number>`cast(count(*) as int)`,
      })
      .from(tournamentPlayers)
      .where(inArray(tournamentPlayers.tournamentId, ids))
      .groupBy(tournamentPlayers.tournamentId),
    db
      .select({
        tournamentId: categories.tournamentId,
        n: sql<number>`cast(count(*) as int)`,
      })
      .from(teams)
      .innerJoin(categories, eq(categories.id, teams.categoryId))
      .where(and(inArray(categories.tournamentId, ids), ne(teams.status, 'withdrawn')))
      .groupBy(categories.tournamentId),
    // Distinct: a tournament that runs two days holds each court twice, and
    // the row on the dashboard wants the court once.
    db
      .selectDistinct({
        tournamentId: courtHolds.tournamentId,
        id: courts.id,
        name: courts.name,
        colorKey: courts.colorKey,
        sortOrder: courts.sortOrder,
      })
      .from(courtHolds)
      .innerJoin(courts, eq(courts.id, courtHolds.courtId))
      .where(inArray(courtHolds.tournamentId, ids))
      .orderBy(asc(courts.sortOrder)),
    db
      .select({
        tournamentId: pendingRegistrations.tournamentId,
        n: sql<number>`cast(count(*) as int)`,
      })
      .from(pendingRegistrations)
      .where(
        and(
          inArray(pendingRegistrations.tournamentId, ids),
          eq(pendingRegistrations.status, 'pending'),
        ),
      )
      .groupBy(pendingRegistrations.tournamentId),
    // The winner of a finished tournament: the winner of its last knockout
    // match, or the top of its table when there is no final.
    db
      .select({
        tournamentId: matches.tournamentId,
        winnerTeamId: matches.winnerTeamId,
        roundIndex: matches.roundIndex,
        stage: matches.stage,
      })
      .from(matches)
      .where(and(inArray(matches.tournamentId, ids), eq(matches.stage, 'knockout')))
      .orderBy(desc(matches.roundIndex)),
  ])

  const m = new Map(matchAgg.map((r) => [r.tournamentId, r]))
  const p = new Map(playerAgg.map((r) => [r.tournamentId, r.n]))
  const tm = new Map(teamAgg.map((r) => [r.tournamentId, r.n]))
  const su = new Map(signupAgg.map((r) => [r.tournamentId, r.n]))
  const courtsBy = new Map<string, DashboardRow['courts']>()
  for (const c of courtRows) {
    // `tournament_id` is nullable on a hold — a block has no holder — but this
    // query asked for holds of these tournaments, so a null here is impossible
    // rather than merely unlikely. Narrowed, not asserted.
    if (!c.tournamentId) continue
    const list = courtsBy.get(c.tournamentId) ?? []
    list.push({ id: c.id, name: c.name, colorKey: c.colorKey })
    courtsBy.set(c.tournamentId, list)
  }
  const finalWinner = new Map<string, string>()
  for (const f of finals) {
    if (f.winnerTeamId && !finalWinner.has(f.tournamentId)) finalWinner.set(f.tournamentId, f.winnerTeamId)
  }
  // "Everyone plays everyone" has no final: the table decides it, as the hub
  // and the public page already say. The dashboard said nothing at all.
  await Promise.all(
    rows
      .filter(({ t }) => t.status === 'completed' && !finalWinner.has(t.id))
      .map(async ({ t, cat }) => {
        const top = (await standingsFor(cat.id)).rows[0]
        if (top) finalWinner.set(t.id, top.teamId)
      }),
  )
  const winnerIds = [...finalWinner.values()]
  const winnerNames = new Map(
    winnerIds.length
      ? (
          await db
            .select({ id: teams.id, name: teams.name })
            .from(teams)
            .where(inArray(teams.id, winnerIds))
        ).map((t) => [t.id, t.name])
      : [],
  )

  const todayKey = venueDayKey(new Date())
  const out: DashboardRow[] = rows.map(({ t, cat }) => {
    const agg = m.get(t.id)
    const wid = finalWinner.get(t.id)
    return {
      id: t.id,
      slug: t.slug,
      name: t.name,
      startDate: t.startDate,
      status: t.status,
      category: cat.name,
      discipline: cat.discipline,
      format: (cat.finalsStage === 'quarters_onward' ? 'semis_and_final' : cat.finalsStage) as FinalsStage,
      players: p.get(t.id) ?? 0,
      teams: tm.get(t.id) ?? 0,
      courts: courtsBy.get(t.id) ?? [],
      matchesTotal: agg?.total ?? 0,
      matchesPlayed: agg?.played ?? 0,
      matchesLive: agg?.live ?? 0,
      registrationOpen: t.status !== 'completed' && !t.registrationClosedAt,
      pendingSignups: su.get(t.id) ?? 0,
      winnerName: wid ? (winnerNames.get(wid) ?? null) : null,
    }
  })

  const today: DashboardRow[] = []
  const upcoming: DashboardRow[] = []
  const finished: DashboardRow[] = []
  for (const r of out) {
    const key = venueDayKey(r.startDate)
    if (r.status === 'completed' || r.status === 'archived') finished.push(r)
    else if (key === todayKey || r.status === 'live') today.push(r)
    else if (key > todayKey) upcoming.push(r)
    else finished.push(r) // a past day that was never closed off
  }
  upcoming.sort((a, b) => a.startDate.getTime() - b.startDate.getTime())
  return { today, upcoming, finished }
}

// ──────────────────────────── the hub ────────────────────────────

export type Step = {
  key: 'registration' | 'teams' | 'schedule' | 'start'
  title: string
  detail: string
  state: 'done' | 'current' | 'todo'
  href: string
}

export type Hub = {
  tournament: typeof tournaments.$inferSelect
  category: typeof categories.$inferSelect
  courts: Array<{ id: string; name: string; colorKey: string }>
  players: number
  teamsMade: number
  teamsNeeded: number
  unpaired: number
  matchesTotal: number
  matchesPlayed: number
  matchesLive: number
  pendingSignups: number
  steps: Step[]
  phase: 'setup' | 'running' | 'finished'
}

export async function hub(slug: string): Promise<Hub | null> {
  const [t] = await db
    .select()
    .from(tournaments)
    .where(and(eq(tournaments.slug, slug), isNull(tournaments.deletedAt)))
    .limit(1)
  if (!t) return null
  const category = await primaryCategory(t.id)

  const [courtList, [playerAgg], [teamAgg], [matchAgg], [signupAgg], pairedRows] =
    await Promise.all([
      myCourts(t.id),
      // Withdrawn players are out of the day: not "in", not waiting for a pair.
      db
        .select({ n: sql<number>`cast(count(*) as int)` })
        .from(tournamentPlayers)
        .where(and(eq(tournamentPlayers.tournamentId, t.id), eq(tournamentPlayers.withdrawn, false))),
      db
        .select({ n: sql<number>`cast(count(*) as int)` })
        .from(teams)
        .where(and(eq(teams.categoryId, category.id), ne(teams.status, 'withdrawn'))),
      db
        .select({
          total: sql<number>`cast(count(*) as int)`,
          played: sql<number>`cast(count(*) filter (where ${matches.resultState} in ('final','reported')) as int)`,
          live: sql<number>`cast(count(*) filter (where ${matches.status} = 'live') as int)`,
        })
        .from(matches)
        .where(eq(matches.tournamentId, t.id)),
      db
        .select({ n: sql<number>`cast(count(*) as int)` })
        .from(pendingRegistrations)
        .where(
          and(
            eq(pendingRegistrations.tournamentId, t.id),
            eq(pendingRegistrations.status, 'pending'),
          ),
        ),
      db
        .select({ n: sql<number>`cast(count(distinct ${teamPlayers.playerId}) as int)` })
        .from(teamPlayers)
        .innerJoin(teams, eq(teams.id, teamPlayers.teamId))
        .where(and(eq(teams.categoryId, category.id), ne(teams.status, 'withdrawn'))),
    ])

  const players = playerAgg?.n ?? 0
  const teamsMade = teamAgg?.n ?? 0
  const size = category.discipline === 'doubles' ? 2 : 1
  const teamsNeeded = Math.floor(players / size)
  const pairedPlayers = pairedRows[0]?.n ?? 0
  const unpaired = Math.max(0, players - pairedPlayers)
  const matchesTotal = matchAgg?.total ?? 0
  const matchesPlayed = matchAgg?.played ?? 0
  const matchesLive = matchAgg?.live ?? 0
  const pendingSignups = signupAgg?.n ?? 0

  const phase: Hub['phase'] =
    t.status === 'completed' ? 'finished' : t.status === 'live' ? 'running' : 'setup'

  const base = `/admin/t/${t.slug}`
  const regDone = players >= size * 2
  const teamsDone =
    category.discipline === 'singles' ? regDone : teamsMade >= 2 && unpaired === 0
  const scheduleDone = matchesTotal > 0 && courtList.length > 0

  const steps: Step[] = [
    {
      key: 'registration',
      title: 'Registration',
      detail: `${players} ${players === 1 ? 'player' : 'players'} in · ${
        t.registrationClosedAt ? 'sign-ups closed' : 'link is open'
      }${pendingSignups ? ` · ${pendingSignups} possible ${pendingSignups === 1 ? 'duplicate' : 'duplicates'}` : ''}`,
      state: regDone ? 'done' : 'current',
      href: `${base}/registration`,
    },
    {
      key: 'teams',
      title: category.discipline === 'singles' ? 'Players' : 'Teams',
      detail:
        category.discipline === 'singles'
          ? `${players} in the draw`
          : teamsNeeded === 0
            ? 'Once players are in'
            : `${teamsMade} of ${teamsNeeded} pairs made${
                unpaired ? ` · ${unpaired} ${unpaired === 1 ? 'player' : 'players'} still to pair` : ''
              }`,
      state: teamsDone ? 'done' : regDone ? 'current' : 'todo',
      href: `${base}/teams`,
    },
    {
      key: 'schedule',
      title: 'Schedule & courts',
      detail: `${
        courtList.length
          ? courtList.map((c) => c.name).join(', ')
          : 'no courts yet'
      } · ${matchesTotal ? `${matchesTotal} matches` : 'schedule not made yet'}`,
      state: scheduleDone ? 'done' : teamsDone ? 'current' : 'todo',
      href: `${base}/schedule`,
    },
    {
      key: 'start',
      title: 'Start',
      detail: scheduleDone ? 'Everything is ready' : 'Once the schedule is made',
      state: phase !== 'setup' ? 'done' : scheduleDone ? 'current' : 'todo',
      href: `${base}/schedule`,
    },
  ]

  return {
    tournament: t,
    category,
    courts: courtList,
    players,
    teamsMade,
    teamsNeeded,
    unpaired,
    matchesTotal,
    matchesPlayed,
    matchesLive,
    pendingSignups,
    steps,
    phase,
  }
}

/** Start the day: the schedule exists, the courts exist, off we go. */
export async function startEvent(tournamentId: string) {
  const [t] = await db.select().from(tournaments).where(eq(tournaments.id, tournamentId)).limit(1)
  if (!t) return { ok: false as const, error: 'That tournament no longer exists.' }
  const [agg] = await db
    .select({ n: sql<number>`cast(count(*) as int)` })
    .from(matches)
    .where(eq(matches.tournamentId, tournamentId))
  if (!agg?.n) return { ok: false as const, error: 'Make the schedule first.' }
  const courtList = await myCourts(tournamentId)
  if (!courtList.length) return { ok: false as const, error: 'Give it at least one court first.' }

  await db
    .update(tournaments)
    .set({
      status: 'live',
      publishedAt: t.publishedAt ?? new Date(),
      // Starting closes sign-ups: the draw is made and a new name would have
      // nowhere to go.
      registrationClosedAt: t.registrationClosedAt ?? new Date(),
      updatedAt: new Date(),
    })
    .where(eq(tournaments.id, tournamentId))
  await bumpStreamVersion(tournamentId)
  // Off we go: the first matches in order go straight onto every court the
  // tournament holds. The organiser's next job is a score.
  await flowTournament(tournamentId)
  return { ok: true as const }
}

/**
 * Delete a tournament. Soft: the row keeps its `deletedAt` and everything
 * under it stays for the record, but it leaves every list and its public page
 * stops answering. Its courts go back to the venue outright — a hold nobody can
 * see is a court nobody can use.
 *
 * Refused while a match is on court: those players are standing on it.
 */
export async function deleteEvent(tournamentId: string) {
  const [live] = await db
    .select({ courtName: courts.name })
    .from(matches)
    .leftJoin(courts, eq(courts.id, matches.courtId))
    .where(and(eq(matches.tournamentId, tournamentId), eq(matches.status, 'live')))
    .limit(1)
  if (live) {
    return {
      ok: false as const,
      error: `There is a match on ${live.courtName ?? 'a court'} right now. Let it finish, or take it off court, then delete.`,
    }
  }
  await transact(async (tx) => {
    await tx
      .update(tournaments)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(tournaments.id, tournamentId), isNull(tournaments.deletedAt)))
    await releaseHolds(tx, { kind: 'tournament', tournamentId })
  })
  // Nothing to flow here: the courts come free, but they belong to no
  // tournament until the organiser gives them to one under Schedule & courts.
  await bumpStreamVersion(tournamentId)
  return { ok: true as const }
}

/** Everything has a result. Close it off so it moves to "Finished". */
export async function finishEvent(tournamentId: string) {
  const [agg] = await db
    .select({
      remaining: sql<number>`cast(count(*) filter (where ${matches.resultState} = 'none') as int)`,
    })
    .from(matches)
    .where(eq(matches.tournamentId, tournamentId))
  if (agg?.remaining) {
    return {
      ok: false as const,
      error: `${agg.remaining} ${agg.remaining === 1 ? 'match has' : 'matches have'} no result yet.`,
    }
  }
  const now = new Date()
  await transact(async (tx) => {
    await tx
      .update(tournaments)
      .set({ status: 'completed', updatedAt: now })
      .where(eq(tournaments.id, tournamentId))
    // Men's Doubles wrapping up at three frees Court 1 for the evening. The old
    // model only pretended this happened and left the rows in place, so the
    // evening's organiser met a constraint error instead of a court.
    await endHoldsAt(tx, { kind: 'tournament', tournamentId }, now)
  })
  await bumpStreamVersion(tournamentId)
  return { ok: true as const }
}
