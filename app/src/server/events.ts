import 'server-only'
import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm'
import { db, transact } from '@/db'
import {
  categories,
  categoryPlayers,
  courts,
  matches,
  pendingRegistrations,
  teamPlayers,
  teams,
  tournamentCourts,
  tournamentPlayers,
  tournaments,
} from '@/db/schema'
import { newId } from '@/lib/ids'
import { bumpStreamVersion } from '@/lib/stream'
import { venueDayKey } from '@/lib/time'
import { createCategory, createTournament, getVenue } from './tournaments'

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
  gender: Gender
  discipline: Discipline
  finalsStage: FinalsStage
  courtIds: string[]
}

export async function createEvent(input: CreateInput) {
  const tournament = await createTournament({ name: input.name, startDate: input.date })
  const catId = await createCategory({
    tournamentId: tournament.id,
    name: categoryName(input.gender, input.discipline),
    discipline: input.discipline,
    gender: input.gender,
    finalsStage: input.finalsStage,
  })
  const courtsResult = await assignCourts(tournament.id, input.courtIds)
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

export type CourtOption = {
  id: string
  name: string
  colorKey: string
  /** Set when another tournament holds it that day. */
  takenBy: { id: string; name: string; slug: string } | null
  /** This tournament holds it. */
  mine: boolean
}

/**
 * Every court at the venue, with who holds it on this tournament's day. A court
 * held by another tournament is shown, named, and not pickable — to use it the
 * organiser takes it off the other tournament first. No lending.
 */
export async function courtOptions(tournamentId: string): Promise<CourtOption[]> {
  const [t] = await db
    .select({ startDate: tournaments.startDate })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1)
  if (!t) return []
  const dayKey = venueDayKey(t.startDate)
  const venue = await getVenue()

  const [allCourts, held] = await Promise.all([
    db
      .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
      .from(courts)
      .where(and(eq(courts.venueId, venue.id), eq(courts.active, true)))
      .orderBy(asc(courts.sortOrder)),
    db
      .select({
        courtId: tournamentCourts.courtId,
        tournamentId: tournamentCourts.tournamentId,
        name: tournaments.name,
        slug: tournaments.slug,
      })
      .from(tournamentCourts)
      .innerJoin(tournaments, eq(tournaments.id, tournamentCourts.tournamentId))
      // A finished tournament lets go of its courts: Men's Doubles wrapping
      // up at three frees Court 1 for whatever the evening is.
      .where(
        and(
          eq(tournamentCourts.dayKey, dayKey),
          isNull(tournaments.deletedAt),
          ne(tournaments.status, 'completed'),
          ne(tournaments.status, 'archived'),
        ),
      ),
  ])
  const byCourt = new Map(held.map((h) => [h.courtId, h]))

  return allCourts.map((c) => {
    const h = byCourt.get(c.id)
    return {
      id: c.id,
      name: c.name,
      colorKey: c.colorKey,
      mine: h?.tournamentId === tournamentId,
      takenBy:
        h && h.tournamentId !== tournamentId
          ? { id: h.tournamentId, name: h.name, slug: h.slug }
          : null,
    }
  })
}

/**
 * For the create form, which has no tournament yet: every court, and who
 * holds which court on which day from today on. The form filters by the day
 * that is picked; the server re-checks on submit.
 */
export async function courtCalendar() {
  const venue = await getVenue()
  const todayKey = venueDayKey(new Date())
  const [allCourts, held] = await Promise.all([
    db
      .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
      .from(courts)
      .where(and(eq(courts.venueId, venue.id), eq(courts.active, true)))
      .orderBy(asc(courts.sortOrder)),
    db
      .select({
        courtId: tournamentCourts.courtId,
        dayKey: tournamentCourts.dayKey,
        name: tournaments.name,
        slug: tournaments.slug,
      })
      .from(tournamentCourts)
      .innerJoin(tournaments, eq(tournaments.id, tournamentCourts.tournamentId))
      .where(
        and(
          gte(tournamentCourts.dayKey, todayKey),
          isNull(tournaments.deletedAt),
          ne(tournaments.status, 'completed'),
          ne(tournaments.status, 'archived'),
        ),
      ),
  ])
  return { courts: allCourts, held }
}

export type CourtCalendar = Awaited<ReturnType<typeof courtCalendar>>

/**
 * Set a tournament's courts to exactly this list. Refuses a court another
 * tournament holds that day and names it — the organiser resolves that on the
 * other tournament, deliberately, rather than this one silently taking it.
 */
export async function assignCourts(tournamentId: string, courtIds: string[]) {
  const wanted = [...new Set(courtIds.filter(Boolean))]
  const options = await courtOptions(tournamentId)
  const byId = new Map(options.map((o) => [o.id, o]))

  for (const id of wanted) {
    const o = byId.get(id)
    if (!o) return { ok: false as const, error: 'That court is not at this venue.' }
    if (o.takenBy) {
      return {
        ok: false as const,
        error: `${o.name} belongs to ${o.takenBy.name} that day. Take it off there first.`,
      }
    }
  }

  const [t] = await db
    .select({ startDate: tournaments.startDate })
    .from(tournaments)
    .where(eq(tournaments.id, tournamentId))
    .limit(1)
  if (!t) return { ok: false as const, error: 'That tournament no longer exists.' }
  const dayKey = venueDayKey(t.startDate)

  // A court being removed with a live match on it is not ours to pull away
  // from under the players.
  const removing = options.filter((o) => o.mine && !wanted.includes(o.id)).map((o) => o.id)
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

  await transact(async (tx) => {
    await tx.delete(tournamentCourts).where(eq(tournamentCourts.tournamentId, tournamentId))
    if (wanted.length) {
      await tx.insert(tournamentCourts).values(
        wanted.map((courtId) => ({ id: newId('tc'), tournamentId, courtId, dayKey })),
      )
    }
  })
  await bumpStreamVersion(tournamentId)
  return { ok: true as const, count: wanted.length }
}

/** The courts this tournament holds, in venue order. */
export async function myCourts(tournamentId: string) {
  return db
    .select({ id: courts.id, name: courts.name, colorKey: courts.colorKey })
    .from(tournamentCourts)
    .innerJoin(courts, eq(courts.id, tournamentCourts.courtId))
    .where(eq(tournamentCourts.tournamentId, tournamentId))
    .orderBy(asc(courts.sortOrder))
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
    db
      .select({
        tournamentId: tournamentCourts.tournamentId,
        id: courts.id,
        name: courts.name,
        colorKey: courts.colorKey,
        sortOrder: courts.sortOrder,
      })
      .from(tournamentCourts)
      .innerJoin(courts, eq(courts.id, tournamentCourts.courtId))
      .where(inArray(tournamentCourts.tournamentId, ids))
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
    const list = courtsBy.get(c.tournamentId) ?? []
    list.push({ id: c.id, name: c.name, colorKey: c.colorKey })
    courtsBy.set(c.tournamentId, list)
  }
  const finalWinner = new Map<string, string>()
  for (const f of finals) {
    if (f.winnerTeamId && !finalWinner.has(f.tournamentId)) finalWinner.set(f.tournamentId, f.winnerTeamId)
  }
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
      db
        .select({ n: sql<number>`cast(count(*) as int)` })
        .from(tournamentPlayers)
        .where(eq(tournamentPlayers.tournamentId, t.id)),
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
            : `${teamsMade} of ${teamsNeeded} pairs made${unpaired ? ` · ${unpaired} still to pair` : ''}`,
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
  await db
    .update(tournaments)
    .set({ status: 'completed', updatedAt: new Date() })
    .where(eq(tournaments.id, tournamentId))
  await bumpStreamVersion(tournamentId)
  return { ok: true as const }
}
