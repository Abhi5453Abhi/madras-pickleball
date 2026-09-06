import { clsx } from 'clsx'
import { and, eq, gt, inArray, or } from 'drizzle-orm'
import Link from 'next/link'
import { Fragment } from 'react'
import { db } from '@/db'
import { categories, matches, teams } from '@/db/schema'
import { COURT_COLORS, CourtMark, Disclosure, NetRule, splitTeam } from '@/components/ui'
import { AUTO_CONFIRM_MINUTES, getMatchForScoring, projectedState, rulesFor } from '@/server/scoring'
import { ensureReady } from '@/server/bootstrap'
import { currentCourtSession, scoreableMatches, type CourtSessionContext } from '@/server/court-tokens'
import { venueTime } from '@/lib/time'
import { CourtEntry } from './entry'
import { ConfirmButtons } from './confirm'

/**
 * What the QR on the net post opens — SPEC A1/A5.
 *
 * Six different people can scan this card inside one minute and none of them
 * is in the same place: a pair who have just finished, a pair mid-match, the
 * pair being asked to agree to a score, somebody whose match is under review,
 * somebody on an empty court, somebody holding last week's card. Every one of
 * those gets a screen that says where they are and what to do next. None of
 * them gets an error, and none of them gets a dead end.
 */
export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Score · Madras Pickleball',
  robots: { index: false, follow: false },
}

/** The court's own colour at a size you can check against the net post card. */
function CourtChip({ colorKey }: { colorKey: string }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'size-9 shrink-0 rounded-[6px] ring-2 ring-white/45',
        COURT_COLORS[colorKey] ?? 'bg-court-blue',
      )}
    />
  )
}

/**
 * The same header on every state, because the first question a phone has to
 * answer at a net post is "am I looking at the right court" — and the answer is
 * a colour and a number that both have to match the laminated card.
 *
 * Ink band: it is chrome, not body copy, and white on ink is 11.8:1 through a
 * screen protector at noon.
 */
function Shell({
  ctx,
  children,
  scanFailed,
}: {
  ctx: CourtSessionContext
  children: React.ReactNode
  /**
   * The scan that got here did not work, but an older session did. Without
   * saying so, somebody who has just scanned Court 3's new card sees Court 1's
   * match and puts a score on the wrong court — the failure looks exactly like
   * a success.
   */
  scanFailed?: boolean
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-ink text-white">
        <div className="mx-auto flex w-full max-w-md items-center gap-3 px-4 py-3">
          <CourtChip colorKey={ctx.colorKey} />
          <span className="font-score text-[40px] leading-none font-bold">
            {ctx.courtName.toUpperCase()}
          </span>
          {ctx.umpireUserId ? (
            <span className="font-score ml-auto rounded-full bg-white/20 px-2.5 py-1 text-eyebrow uppercase">
              Umpire
            </span>
          ) : null}
        </div>
        <NetRule />
      </header>
      <main className="mx-auto w-full max-w-md flex-1 p-4 pb-16">
        {scanFailed ? (
          <div className="mb-5 rounded-card border-2 border-alert/40 bg-alert-soft p-4">
            <p className="font-score text-eyebrow text-alert uppercase">That card didn’t open</p>
            <p className="mt-1.5 text-body text-text">
              You are still on {ctx.courtName}, from an earlier scan. Check the number and the
              colour against the card in front of you before you put a score in.
            </p>
          </div>
        ) : null}
        {children}
      </main>
    </div>
  )
}

function Stack({ name }: { name: string | null }) {
  const parts = splitTeam(name)
  if (!parts.length) return <span className="text-text-2">Still to be decided</span>
  return (
    <>
      {parts.map((p, i) => (
        <span key={`${p}-${i}`} className="block">
          {p}
        </span>
      ))}
    </>
  )
}

type MatchRow = typeof matches.$inferSelect

/**
 * Clock reads live outside the component. Rendering is meant to be pure, and
 * this page is `force-dynamic`, so "now" is settled once per request either
 * way — the helpers just keep it out of the render body.
 */
function minutesAgo(minutes: number): Date {
  return new Date(Date.now() - minutes * 60_000)
}

function isWithin(d: Date | null, minutes: number): boolean {
  return !!d && Date.now() - d.getTime() < minutes * 60_000
}

export default async function CourtPage(props: PageProps<'/court'>) {
  await ensureReady()
  const sp = await props.searchParams
  const bad = typeof sp.bad === 'string' ? sp.bad : null
  const wanted = typeof sp.m === 'string' ? sp.m : null
  const ctx = await currentCourtSession()

  // ── no card, or a card that has stopped working ──
  if (!ctx) {
    const title =
      bad === 'rate'
        ? 'Too many tries from here'
        : bad
          ? 'That card doesn’t work any more'
          : 'Scan the card on the net post'
    const body =
      bad === 'rate'
        ? 'Wait a minute and scan it again. If it still won’t open, the card is out of date — the organiser can print today’s in a minute.'
        : bad
          ? 'Cards are reprinted for every tournament, so last week’s stops working. Ask the organiser for today’s card — it takes them a minute to print.'
          : 'Each court has its own QR card, cable-tied to the net post. Scanning it opens the scoreboard for whatever match is on that court. Nothing to log in to.'
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <CourtMark className="size-12 text-ink" />
        <h1 className="text-title text-text">{title}</h1>
        <p className="text-body text-text-2">{body}</p>
        {bad ? (
          <p className="text-body text-text-2">
            Your score is not lost — nobody has typed it in yet. Read it out to the organiser and
            they will put it on the board.
          </p>
        ) : null}
      </main>
    )
  }

  const candidates = await scoreableMatches(ctx)

  // Everything else this court has been doing: what is queued next, what is
  // under review, and what has just gone final. One query — a court runs a
  // dozen matches in a day, not a thousand.
  const twoHoursAgo = minutesAgo(120)
  const onThisCourt = await db
    .select()
    .from(matches)
    .where(
      and(
        eq(matches.tournamentId, ctx.tournamentId),
        eq(matches.courtId, ctx.courtId),
        or(
          inArray(matches.status, ['pending', 'called', 'warming_up', 'live']),
          gt(matches.endedAt, twoHoursAgo),
        ),
      ),
    )

  const byRecency = (a: MatchRow, b: MatchRow) =>
    (b.endedAt?.getTime() ?? 0) - (a.endedAt?.getTime() ?? 0)

  const disputed = onThisCourt.filter((m) => m.resultState === 'disputed').sort(byRecency)[0] ?? null
  const settled =
    onThisCourt
      .filter(
        (m) =>
          m.status === 'completed' &&
          m.resultState !== 'disputed' &&
          projectedState(m) === 'final' &&
          isWithin(m.endedAt, 30),
      )
      .sort(byRecency)[0] ?? null
  const nextUp =
    onThisCourt
      .filter((m) => ['pending', 'called', 'warming_up'].includes(m.status))
      .sort(
        (a, b) =>
          (a.queuePosition ?? 9e9) - (b.queuePosition ?? 9e9) ||
          (a.scheduledAt?.getTime() ?? 9e12) - (b.scheduledAt?.getTime() ?? 9e12) ||
          a.seq - b.seq,
      )[0] ?? null

  // Every name any of these screens might need, in one read.
  const nameIds = new Set<string>()
  for (const m of [...candidates, ...onThisCourt]) {
    if (m.teamAId) nameIds.add(m.teamAId)
    if (m.teamBId) nameIds.add(m.teamBId)
  }
  const sides = nameIds.size
    ? await db
        .select({ id: teams.id, name: teams.name })
        .from(teams)
        .where(inArray(teams.id, [...nameIds]))
    : []
  const nameOf = (id: string | null) => (id ? (sides.find((s) => s.id === id)?.name ?? null) : null)
  const pairLine = (m: MatchRow) => `${nameOf(m.teamAId) ?? 'TBD'} v ${nameOf(m.teamBId) ?? 'TBD'}`

  const nextUpCard = nextUp ? (
    <div className="rounded-card border border-line-strong bg-paper p-4">
      <p className="font-score text-eyebrow text-text-2 uppercase">Next on {ctx.courtName}</p>
      <p className="mt-1.5 text-row text-text">{pairLine(nextUp)}</p>
      {nextUp.roundName ? <p className="text-meta text-text-2">{nextUp.roundName}</p> : null}
    </div>
  ) : null

  // ── nothing this court may write to ──
  if (!candidates.length) {
    if (disputed) {
      return (
        <Shell ctx={ctx} scanFailed={!!bad}>
          <div className="flex flex-col gap-5">
            <div className="rounded-card border-2 border-alert/40 bg-alert-soft p-4">
              <p className="font-score text-eyebrow text-alert uppercase">Under review</p>
              <h1 className="mt-1.5 text-title text-text">The two scores don’t match</h1>
              <p className="mt-1.5 text-body text-text">{pairLine(disputed)}</p>
              <p className="mt-2 text-body text-text-2">
                An organiser will come and sort it out, and what they decide stands. Nothing more
                can be entered for this match from the court card.
              </p>
            </div>
            {nextUpCard}
          </div>
        </Shell>
      )
    }

    if (settled) {
      const wName = nameOf(settled.winnerTeamId)
      const line = summaryLine(settled)
      return (
        <Shell ctx={ctx} scanFailed={!!bad}>
          <div className="flex flex-col gap-5">
            <div className="rounded-card border-2 border-ink bg-paper p-4">
              <p className="font-score text-eyebrow text-text-2 uppercase">That one’s in</p>
              <h1 className="mt-1.5 text-title text-text">
                <Stack name={wName} />
              </h1>
              <p className="mt-1 text-row text-text-2">
                won {Math.max(settled.gamesWonA, settled.gamesWonB)}–
                {Math.min(settled.gamesWonA, settled.gamesWonB)}
              </p>
              {line ? <p className="num mt-2 text-score text-text">{line}</p> : null}
              <p className="mt-3 text-meta text-text-2">
                Recorded at {settled.endedAt ? venueTime(settled.endedAt) : 'the end of the match'}.
                If that isn’t right, tell the organiser — it can still be changed.
              </p>
            </div>
            {nextUpCard}
          </div>
        </Shell>
      )
    }

    return (
      <Shell ctx={ctx} scanFailed={!!bad}>
        <div className="flex flex-col gap-5">
          <h1 className="text-title text-text">Nothing on {ctx.courtName} right now</h1>
          <p className="text-body text-text-2">
            When the organiser sends a match here it appears on this screen. Scan the card again the
            moment your match ends — that is when this page can take the score.
          </p>
          {nextUpCard}
          <p className="text-meta text-text-2">
            Leave the card on the net post. It is the only way onto this screen.
          </p>
        </div>
      </Shell>
    )
  }

  // ── which match this screen is about ──
  const explicit = wanted ? (candidates.find((m) => m.id === wanted) ?? null) : null
  const live = candidates.find((m) => m.status === 'live') ?? null
  const awaiting = candidates.find((m) => m.resultState === 'reported') ?? null
  // A score still waiting to be agreed beats an arbitrary pick from the list:
  // ordering by `started_at` puts a match that never got a start time first, and
  // that silently swallowed the confirmation screen the moment after a submit.
  const target = explicit ?? live ?? awaiting ?? candidates[0]

  // ── somebody is being asked to agree to a score ──
  // This wins the screen whenever it is the newest thing on the court. It used
  // to be skipped entirely if the board had already sent the next pair on,
  // which is precisely when it matters: the confirmation always happens after
  // the match.
  if (awaiting && awaiting.id === target.id) {
    return (
      <ConfirmScreen
        ctx={ctx}
        match={awaiting}
        nextUp={nextUp}
        pairLine={pairLine}
        scanFailed={!!bad}
      />
    )
  }

  const nameA = nameOf(target.teamAId)
  const nameB = nameOf(target.teamBId)

  const others = candidates.filter((m) => m.id !== target.id)
  const elsewhere = others.length ? (
    <Disclosure
      summary="This isn’t our match"
      meta={`${others.length} other ${others.length === 1 ? 'match' : 'matches'} this card can score`}
    >
      <div className="flex flex-col gap-3">
        {others.map((m) => (
          <Link
            key={m.id}
            href={`/court?m=${m.id}` as never}
            className="tap-lg flex flex-col justify-center rounded-control border border-line-strong bg-paper px-4"
          >
            <span className="text-row text-text">{pairLine(m)}</span>
            <span className="text-meta text-text-2">
              {m.roundName ?? 'Group stage'}
              {m.resultState === 'reported' ? ' · waiting to be agreed' : ''}
            </span>
          </Link>
        ))}
      </div>
    </Disclosure>
  ) : null

  // ── a match that has not got two sides yet ──
  if (!target.teamAId || !target.teamBId) {
    return (
      <Shell ctx={ctx} scanFailed={!!bad}>
        <div className="flex flex-col gap-5">
          <h1 className="text-title text-text">This match is still waiting on another result</h1>
          <p className="text-body text-text-2">
            {nameA ?? nameB
              ? `${nameA ?? nameB} are through. The other side is whoever wins a match still being played.`
              : 'Both sides come from matches that are still being played.'}{' '}
            The score can go in here as soon as both pairs are known.
          </p>
          {elsewhere}
        </div>
      </Shell>
    )
  }

  // ── a match that the court card is not allowed to score ──
  // Semi-finals onward default to an umpire or an admin (SPEC A1). Saying so is
  // the difference between "find the organiser" and a submit that fails after
  // somebody has typed three games in.
  if (target.scoringMode === 'authenticated' && !ctx.umpireUserId) {
    return (
      <Shell ctx={ctx} scanFailed={!!bad}>
        <div className="flex flex-col gap-5">
          <div className="rounded-card border border-accent/30 bg-accent-soft p-4">
            <p className="font-score text-eyebrow text-accent-hi uppercase">
              {target.roundName ?? 'Knockout'}
            </p>
            <h1 className="mt-1.5 text-title text-text">An umpire records this one</h1>
            <p className="mt-1.5 text-body text-text">
              {nameA} v {nameB}
            </p>
            <p className="mt-2 text-body text-text-2">
              From the semi-finals on, the score goes in with an umpire or the organiser rather than
              from the court card. Find them at the desk — they will have it done in a minute.
            </p>
          </div>
          {elsewhere}
        </div>
      </Shell>
    )
  }

  const [category] = await db
    .select()
    .from(categories)
    .where(eq(categories.id, target.categoryId))
    .limit(1)

  // Anything else this court still owes somebody, pinned above the match in
  // hand. A dispute or an un-agreed score used to be reachable only when the
  // court was otherwise empty, which is the one time nobody is standing at it.
  const disputeNote = disputed ? (
    <div className="rounded-card border-2 border-alert/40 bg-alert-soft p-4">
      <p className="font-score text-eyebrow text-alert uppercase">Under review</p>
      <p className="mt-1.5 text-row text-text">{pairLine(disputed)}</p>
      <p className="mt-1 text-meta text-text-2">
        The two scores didn’t match. An organiser will sort that one out — it can’t be entered from
        here.
      </p>
    </div>
  ) : null

  // The tap that agreed a score has to be acknowledged somewhere, and the board
  // may already have sent the next pair on by the time the page comes back.
  const settledNote =
    settled && isWithin(settled.endedAt, 10) ? (
      <div className="rounded-card border border-line-strong bg-done-soft p-4">
        <p className="font-score text-eyebrow text-text-2 uppercase">That one’s in</p>
        <p className="mt-1.5 text-row text-text">
          {nameOf(settled.winnerTeamId)} won
          {summaryLine(settled) ? <span className="num"> {summaryLine(settled)}</span> : null}
        </p>
      </div>
    ) : null

  // A confirmation still owed on an earlier match, pinned above the live one.
  const pinned =
    awaiting && awaiting.id !== target.id ? (
      <Link
        href={`/court?m=${awaiting.id}` as never}
        className="block rounded-card border-2 border-waiting/45 bg-waiting-soft p-4"
      >
        <p className="font-score text-eyebrow text-waiting uppercase">Still to be agreed</p>
        <p className="mt-1.5 text-row text-text">{pairLine(awaiting)}</p>
        <p className="mt-1 text-meta text-text-2">
          {summaryLine(awaiting) ?? 'A score is in'} · tap to check it
        </p>
      </Link>
    ) : null

  return (
    <Shell ctx={ctx} scanFailed={!!bad}>
      <div className="flex flex-col gap-5">
        {disputeNote}
        {pinned}
        {settledNote}
        {target.status === 'completed' ? (
          <p className="rounded-control bg-accent-soft px-3.5 py-3 text-body font-medium text-accent-hi">
            This match is marked finished. Put the score in and hand the phone over.
          </p>
        ) : null}
        <CourtEntry
          /* Without a key, navigating to another match on this court re-renders
             the same component: the names change and the games entered do not,
             so a score can be sent against a match it never belonged to. */
          key={target.id}
          matchId={target.id}
          courtName={null}
          courtColor={ctx.colorKey}
          categoryName={category?.name ?? ''}
          roundName={target.roundName}
          teamAId={target.teamAId}
          teamBId={target.teamBId}
          nameA={nameA ?? '—'}
          nameB={nameB ?? '—'}
          rules={rulesFor(category!)}
        />
        {elsewhere}
        <p className="text-meta text-text-2">
          Scores go final {AUTO_CONFIRM_MINUTES} minutes after they are entered, unless somebody says
          they are wrong.
        </p>
      </div>
    </Shell>
  )
}

/**
 * "11–9, 8–11, 11–6" from the denormalised summary the ledger keeps. It is
 * jsonb — an array of `[scoreA, scoreB]` pairs — so it is read the way any
 * other untyped column is read: checked, not cast and hoped for.
 */
function summaryLine(match: MatchRow): string | null {
  const raw = match.scoreSummary
  if (!Array.isArray(raw)) return null
  const parts: string[] = []
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) return null
    const [a, b] = entry as unknown[]
    if (!Number.isInteger(a) || !Number.isInteger(b)) return null
    parts.push(`${a as number}–${b as number}`)
  }
  return parts.length ? parts.join(', ') : null
}

/**
 * The integrity mechanism of the whole product, and for a long time it looked
 * like a footnote.
 *
 * It has one job: the person now holding the phone is NOT the person who typed
 * the score, and they have five seconds and one glance. So the screen names
 * them, shows the numbers under the two pairs' names at 34px, and gives them
 * two targets and nothing else to read.
 */
async function ConfirmScreen({
  ctx,
  match,
  nextUp,
  pairLine,
  scanFailed,
}: {
  ctx: CourtSessionContext
  match: MatchRow
  nextUp: MatchRow | null
  pairLine: (m: MatchRow) => string
  scanFailed: boolean
}) {
  const loaded = await getMatchForScoring(match.id)
  const nameA = loaded?.nameA ?? null
  const nameB = loaded?.nameB ?? null
  const games = loaded?.games ?? []

  const submission = [...(loaded?.submissions ?? [])].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  )[0]
  const submittedBy = submission?.submittingTeamId ?? null

  // The side that did NOT put it in is the side being asked. A submission that
  // declared no side names nobody, and says so rather than guessing.
  const askingTeamId = !submittedBy
    ? null
    : submittedBy === match.teamAId
      ? match.teamBId
      : submittedBy === match.teamBId
        ? match.teamAId
        : null
  const askingName =
    askingTeamId && askingTeamId === match.teamAId
      ? nameA
      : askingTeamId && askingTeamId === match.teamBId
        ? nameB
        : null
  const winnerName = match.winnerTeamId
    ? match.winnerTeamId === match.teamAId
      ? nameA
      : nameB
    : null
  const goesFinalAt = match.reportedAt
    ? venueTime(new Date(match.reportedAt.getTime() + AUTO_CONFIRM_MINUTES * 60_000))
    : null

  return (
    <Shell ctx={ctx} scanFailed={scanFailed}>
      <div className="flex flex-col gap-5">
        <div>
          <p className="font-score text-eyebrow text-accent-hi uppercase">Hand the phone to</p>
          <h1 className="mt-1 text-title text-text">
            {askingName ? <Stack name={askingName} /> : 'Whoever didn’t type it in'}
          </h1>
          <p className="mt-1.5 text-body text-text-2">
            {askingName
              ? 'They read it, they tap. Five seconds and the court is yours again.'
              : 'The other pair should read this and tap, not the pair who typed it.'}
          </p>
        </div>

        <div className="rounded-card border-2 border-ink bg-paper p-4">
          <p className="font-score text-eyebrow text-text-2 uppercase">The score they’ve put in</p>
          <p className="mt-1.5 text-title text-text">
            {match.resultType === 'walkover'
              ? `${winnerName ?? 'The other pair'} go through — nobody turned up`
              : match.resultType === 'retired'
                ? `${winnerName ?? 'The other pair'} go through — someone couldn’t carry on`
                : winnerName
                  ? `${winnerName} won ${Math.max(match.gamesWonA, match.gamesWonB)}–${Math.min(match.gamesWonA, match.gamesWonB)}`
                  : `Games ${match.gamesWonA}–${match.gamesWonB}`}
          </p>

          {games.length ? (
            <div className="mt-4 grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1fr)] items-end gap-x-3 gap-y-2.5">
              <span />
              <span className="border-b-4 border-side-a pb-1.5 text-meta text-text">
                <Stack name={nameA} />
              </span>
              <span className="border-b-4 border-side-b pb-1.5 text-meta text-text">
                <Stack name={nameB} />
              </span>
              {games.map((g) => (
                <Fragment key={g.gameNo}>
                  <span className="font-score self-center text-eyebrow text-text-2 uppercase">
                    G{g.gameNo}
                  </span>
                  <span className="num text-score text-text">{g.scoreA}</span>
                  <span className="num text-score text-text">{g.scoreB}</span>
                </Fragment>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-body text-text-2">
              No games were played out — check that the reason above is the right one.
            </p>
          )}
        </div>

        <ConfirmButtons
          matchId={match.id}
          agreeingTeamId={askingTeamId ?? ''}
          agreeingName={askingName}
        />

        <p className="text-meta text-text-2">
          They’ve already left? Leave it be — it goes final on its own
          {goesFinalAt ? ` at ${goesFinalAt}` : ` after ${AUTO_CONFIRM_MINUTES} minutes`}.
        </p>

        {nextUp ? (
          <div className="rounded-card border border-line-strong bg-paper p-4">
            <p className="font-score text-eyebrow text-text-2 uppercase">Next on {ctx.courtName}</p>
            <p className="mt-1.5 text-row text-text">{pairLine(nextUp)}</p>
          </div>
        ) : null}
      </div>
    </Shell>
  )
}
