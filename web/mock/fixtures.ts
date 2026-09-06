/**
 * The fixtures behind `MPB_MOCK=1` — a whole Sunday at the venue, answered
 * from the JSON files beside this one so every screen can be walked and
 * photographed without a database.
 *
 * They are checked against `docs/GO-API.ts`, which is the point: a fixture
 * that has drifted from the contract is a screenshot of a screen that will
 * never render. JSON widens `"live"` to `string`, so the check runs through
 * `Loose<T>` — literal unions relax to their base type, and everything else
 * (a missing field, a misspelt one, an array where an object belongs) is
 * still a compile error.
 *
 * This is development scaffolding. It is never bundled: the plugin that reads
 * it is only added to the Vite config when MPB_MOCK is set.
 */
import type { Input, Output, RpcName } from '../../docs/GO-API.ts'

import authMe from './auth.me.json' with { type: 'json' }
import listOrganisers from './organisers.listOrganisers.json' with { type: 'json' }
import venueCourts from './venue.venueCourts.json' with { type: 'json' }
import dashboard from './events.dashboard.json' with { type: 'json' }
import courtCalendar from './events.courtCalendar.json' with { type: 'json' }
import hubMens from './events.hub.mens.json' with { type: 'json' }
import hubMixed from './events.hub.mixed.json' with { type: 'json' }
import courtOptionsMens from './events.courtOptions.mens.json' with { type: 'json' }
import courtOptionsMixed from './events.courtOptions.mixed.json' with { type: 'json' }
import myCourtsMens from './events.myCourts.mens.json' with { type: 'json' }
import myCourtsMixed from './events.myCourts.mixed.json' with { type: 'json' }
import tournamentMens from './tournaments.getTournamentBySlug.mens.json' with { type: 'json' }
import tournamentMixed from './tournaments.getTournamentBySlug.mixed.json' with { type: 'json' }
import matchesMens from './tournaments.listMatches.mens.json' with { type: 'json' }
import matchesMixed from './tournaments.listMatches.mixed.json' with { type: 'json' }
import teamsMens from './tournaments.listTeams.mens.json' with { type: 'json' }
import teamsMixed from './tournaments.listTeams.mixed.json' with { type: 'json' }
import playersMens from './tournaments.listTournamentPlayers.mens.json' with { type: 'json' }
import playersMixed from './tournaments.listTournamentPlayers.mixed.json' with { type: 'json' }
import standingsMens from './tournaments.standingsFor.mens.json' with { type: 'json' }
import standingsMixed from './tournaments.standingsFor.mixed.json' with { type: 'json' }
import namesMens from './tournaments.teamNameMap.mens.json' with { type: 'json' }
import namesMixed from './tournaments.teamNameMap.mixed.json' with { type: 'json' }
import gamesMens from './tournaments.gamesByMatch.mens.json' with { type: 'json' }
import gamesMixed from './tournaments.gamesByMatch.mixed.json' with { type: 'json' }
import teamBoardMens from './teams.teamBoard.mens.json' with { type: 'json' }
import teamBoardMixed from './teams.teamBoard.mixed.json' with { type: 'json' }
import registrationLink from './registration.ensureRegistrationLink.json' with { type: 'json' }
import rosterMens from './registration.listRoster.mens.json' with { type: 'json' }
import rosterMixed from './registration.listRoster.mixed.json' with { type: 'json' }
import tokenOpen from './registration.resolveRegistrationToken.open.json' with { type: 'json' }
import tokenClosed from './registration.resolveRegistrationToken.closed.json' with { type: 'json' }
import venueBoard from './board.venueBoard.json' with { type: 'json' }
import moveOptions from './board.moveOptions.json' with { type: 'json' }
import matchForScoring from './scoring.getMatchForScoring.json' with { type: 'json' }
import withdrawalEffect from './chaos.withdrawalEffect.json' with { type: 'json' }
import substitutionMens from './chaos.substitutionOptions.mens.json' with { type: 'json' }
import substitutionMixed from './chaos.substitutionOptions.mixed.json' with { type: 'json' }
import publicToday from './public.publicToday.json' with { type: 'json' }
import publicMens from './public.publicTournament.mens.json' with { type: 'json' }
import publicMixed from './public.publicTournament.mixed.json' with { type: 'json' }

/**
 * The contract's shape with its string-literal unions relaxed, so a JSON
 * module — where `"live"` is only ever `string` — can be checked against it.
 */
type Loose<T> = T extends string
  ? string
  : T extends number
    ? number
    : T extends boolean
      ? boolean
      : T extends Array<infer U>
        ? Array<Loose<U>>
        : T extends object
          ? { [K in keyof T]: Loose<T[K]> }
          : T

/** Checked at compile time, asserted at runtime — the whole point of this file. */
function fixture<N extends RpcName>(_name: N, value: Loose<Output<N>>): Output<N> {
  return value as Output<N>
}

const MENS = 'tr_mens'
const MENS_SLUG = 'mens-doubles-september'

/** Two states, picked by the tournament id or slug the screen asked for. */
function bySlug<N extends RpcName>(name: N, mens: Loose<Output<N>>, mixed: Loose<Output<N>>) {
  return (slug: string) => fixture(name, slug === MENS_SLUG ? mens : mixed)
}
function byId<N extends RpcName>(name: N, mens: Loose<Output<N>>, mixed: Loose<Output<N>>) {
  return (id: string) => fixture(name, id === MENS ? mens : mixed)
}

export type MockResult = { status: number; body: unknown }

const ok = (body: unknown): MockResult => ({ status: 200, body })
const notFound = (error: string): MockResult => ({ status: 404, body: { error } })

/**
 * Writes answer as the contract says a refused action does — 200 with the
 * sentence, or 200 with `redirect` — so the screens' success and refusal
 * paths both get exercised.
 */
const HANDLERS: { [N in RpcName]?: (input: Input<N>) => MockResult } = {
  'auth.login': (i) =>
    ok(
      i.pin === '482913' || i.pin === '123456'
        ? { ok: true, redirect: i.next && i.next.startsWith('/admin') ? i.next : '/admin' }
        : { ok: false, error: "That's not it. 4 tries left before a fifteen-minute wait." },
    ),
  'auth.logout': () => ok({ ok: true }),
  'auth.me': () => ok(fixture('auth.me', authMe)),

  'organisers.listOrganisers': () => ok(fixture('organisers.listOrganisers', listOrganisers)),
  'organisers.addOrganiser': (i) => ok({ ok: true, name: i.name, pin: '246813' }),
  'organisers.removeOrganiser': () => ok({ ok: true, note: 'Removed. Their PIN no longer works.' }),
  'organisers.changePin': () => ok({ ok: true, redirect: '/admin' }),

  'venue.venueCourts': () => ok(fixture('venue.venueCourts', venueCourts)),
  'venue.addCourt': (i) => ok({ ok: true, note: `${i.name} is in.` }),
  'venue.renameCourt': () => ok({ ok: true, note: 'Renamed.' }),
  'venue.removeCourt': () =>
    ok({ ok: true, note: 'Taken out. Add it again any time and it comes back with its history.' }),

  'events.dashboard': () => ok(fixture('events.dashboard', dashboard)),
  'events.courtCalendar': () => ok(fixture('events.courtCalendar', courtCalendar)),
  'events.createEvent': () => ok({ ok: true, redirect: `/admin/t/${MENS_SLUG}` }),
  'events.hub': (i) => ok(bySlug('events.hub', hubMens, hubMixed)(i.slug)),
  'events.courtOptions': (i) =>
    ok(byId('events.courtOptions', courtOptionsMens, courtOptionsMixed)(i.tournamentId)),
  'events.assignCourts': (i) => ok({ ok: true, count: i.courtIds.length }),
  'events.myCourts': (i) => ok(byId('events.myCourts', myCourtsMens, myCourtsMixed)(i.tournamentId)),
  'events.closeRegistration': () => ok({ ok: true }),
  'events.reopenRegistration': () => ok({ ok: true }),
  'events.startEvent': () => ok({ ok: true, redirect: '/admin/live' }),
  'events.finishEvent': () => ok({ ok: false, error: '9 matches have no result yet.' }),
  'events.deleteEvent': () => ok({ ok: true, redirect: '/admin' }),

  'tournaments.getTournamentBySlug': (i) =>
    i.slug === MENS_SLUG || i.slug === 'mixed-doubles-september'
      ? ok(bySlug('tournaments.getTournamentBySlug', tournamentMens, tournamentMixed)(i.slug))
      : notFound('There is no tournament at that address.'),
  'tournaments.listMatches': (i) =>
    ok(byId('tournaments.listMatches', matchesMens, matchesMixed)(i.tournamentId)),
  'tournaments.listTeams': (i) => ok(byId('tournaments.listTeams', teamsMens, teamsMixed)(i.tournamentId)),
  'tournaments.listTournamentPlayers': (i) =>
    ok(byId('tournaments.listTournamentPlayers', playersMens, playersMixed)(i.tournamentId)),
  'tournaments.standingsFor': (i) =>
    ok(byId('tournaments.standingsFor', standingsMens, standingsMixed)(i.tournamentId)),
  'tournaments.teamNameMap': (i) =>
    ok(byId('tournaments.teamNameMap', namesMens, namesMixed)(i.tournamentId)),
  'tournaments.gamesByMatch': (i) =>
    ok(byId('tournaments.gamesByMatch', gamesMens, gamesMixed)(i.tournamentId)),
  'tournaments.generateDraw': () => ok({ ok: true, count: 16 }),

  'teams.teamBoard': (i) => ok(byId('teams.teamBoard', teamBoardMens, teamBoardMixed)(i.tournamentId)),
  'teams.pairWith': () => ok({ ok: true, teamId: 'tm_new' }),
  'teams.splitTeam': () => ok({ ok: true }),
  'teams.pairRestRandomly': () => ok({ ok: true, made: 2, oddOut: null }),

  'registration.ensureRegistrationLink': () =>
    ok(fixture('registration.ensureRegistrationLink', registrationLink)),
  'registration.listRoster': (i) =>
    ok(byId('registration.listRoster', rosterMens, rosterMixed)(i.tournamentId)),
  'registration.addByHand': () => ok({ ok: true, added: 1, skipped: 0, flagged: [] }),
  'registration.removePlayer': () => ok({ ok: true, note: 'They are off the list.' }),
  'registration.mergePlayers': () =>
    ok({ ok: true, note: 'Rahul Menon and Meera Nair are one person on the list now.' }),
  'registration.keepBoth': () => ok({ ok: true }),
  'registration.resolveRegistrationToken': (i) =>
    i.token === '7K2QD-9XFB4'
      ? ok(fixture('registration.resolveRegistrationToken', tokenOpen))
      : i.token === 'CLOSED-00000'
        ? ok(fixture('registration.resolveRegistrationToken', tokenClosed))
        : notFound('That link does not work.'),
  'registration.submitRegistration': () => ok({ ok: true, alreadyIn: false }),

  'board.venueBoard': () => ok(fixture('board.venueBoard', venueBoard)),
  'board.moveOptions': () => ok(fixture('board.moveOptions', moveOptions)),
  'board.moveMatch': () => ok({ ok: true, redirect: '/admin/live' }),
  'board.clearCourt': () => ok({ ok: true, redirect: '/admin/live' }),
  'board.sendToCourt': () => ok({ ok: true, redirect: '/admin/live' }),

  'scoring.getMatchForScoring': () => ok(fixture('scoring.getMatchForScoring', matchForScoring)),
  'scoring.saveResult': () => ok({ ok: true }),

  'chaos.withdrawalEffect': (i) =>
    i.teamId ? ok(fixture('chaos.withdrawalEffect', withdrawalEffect)) : notFound('No such pair.'),
  'chaos.withdrawTeam': () =>
    ok({
      ok: true,
      walkovers: 2,
      note: 'Deepak Raj / Bala Murugan are out. 2 matches become walkovers to the other side.',
    }),
  'chaos.reinstateTeam': () =>
    ok({ ok: true, restored: 2, note: 'Deepak Raj / Bala Murugan are back in. 2 walkovers are undone.' }),
  'chaos.substitutionOptions': (i) =>
    ok(byId('chaos.substitutionOptions', substitutionMens, substitutionMixed)(i.tournamentId)),
  'chaos.substitutePlayer': () =>
    ok({
      ok: true,
      name: 'Karthik Subramanian / Vignesh Kumar',
      incoming: 'Vignesh Kumar',
      note: 'Karthik Subramanian / Sathish Kumar are now Karthik Subramanian / Vignesh Kumar. Their results and their place in the table stand.',
    }),
  'chaos.pauseDay': () => ok({ ok: true, note: 'Paused. The public page says so.' }),
  'chaos.resumeDay': () => ok({ ok: true, note: 'Going again.' }),
  'chaos.shortenFormat': (i) =>
    ok({
      ok: true,
      note: `What is left is now ${
        i.bestOf === 1 ? `one game to ${i.pointsToWin}` : `best of ${i.bestOf} to ${i.pointsToWin}`
      }.`,
    }),
  'chaos.voidMatch': () => ok({ ok: true, redirect: '/admin/live' }),

  'public.publicToday': () => ok(fixture('public.publicToday', publicToday)),
  'public.publicTournament': (i) =>
    i.slug === MENS_SLUG || i.slug === 'mixed-doubles-september'
      ? ok(bySlug('public.publicTournament', publicMens, publicMixed)(i.slug))
      : notFound('There is no tournament at that address.'),
}

/**
 * One switch, because the signed-out screens cannot otherwise be reached: a
 * `mpb-mock=signed-out` cookie makes `auth.me` answer 401, which is what puts
 * /login on screen and what sends an organiser-only page there.
 */
export function mockRpc(name: string, input: unknown, cookie = ''): MockResult {
  if (name === 'auth.me' && /(^|;\s*)mpb-mock=signed-out/.test(cookie)) {
    return { status: 401, body: { error: 'Sign in first.' } }
  }
  const handler = HANDLERS[name as RpcName] as ((i: unknown) => MockResult) | undefined
  if (!handler) return { status: 404, body: { error: `No fixture for ${name}.` } }
  return handler(input)
}

/**
 * The three version pollers. Constant, so a page left open reloads exactly
 * once a minute (the board's own "the clock has moved" tick) and never in a
 * loop.
 */
export function mockVersion(path: string): MockResult {
  if (path === 'today') return ok({ version: 'v-today-1' })
  if (path === 'venue') return ok({ version: 'v-venue-1' })
  if (path.startsWith('t/')) {
    const slug = path.slice(2)
    if (slug === MENS_SLUG) return ok({ version: 'v-mens-1' })
    if (slug === 'mixed-doubles-september') return ok({ version: 'v-mixed-1' })
    return notFound('No such tournament.')
  }
  return notFound('No such version.')
}
