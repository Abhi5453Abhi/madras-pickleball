import Link from 'next/link'
import { and, asc, gte, inArray, isNull, lt } from 'drizzle-orm'
import { db } from '@/db'
import { gameSessions } from '@/db/schema'
import { Chevron, EmptyState, Notice, Panel, SectionHead } from '@/components/ui'
import { requireUser } from '@/lib/auth'
import { rupees } from '@/lib/display'
import { venueDate, venueDayKey } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { dayEnd, dayStart } from '@/server/courts'
import { dayTally, debtorsFor, moneyDrift, oldestOpenChargeFor } from '@/server/money'
import { getVenue } from '@/server/tournaments'
import { SECONDARY_LINK } from '../_ui'

/**
 * The day's money — m4.
 *
 * Split by method, because cash has to match the drawer and everything else has
 * to match somebody's statement. The moment one number stands for both, a
 * shortfall in the drawer is hidden by a surplus online and nobody trusts the
 * app again.
 *
 * Everything here is a pure read. There is no button on this screen: money
 * moves from the desk, on the night's own game screen, where the host is
 * standing in front of the person paying.
 */
export const dynamic = 'force-dynamic'
export const metadata = { title: 'Money · Madras Pickleball' }

const METHOD_WORDS: Record<string, string> = {
  cash: 'Cash',
  venue_qr: 'Venue QR',
  gateway: 'Online',
  bank_transfer: 'Bank transfer',
}

function shiftDay(dayKey: string, days: number): string {
  return venueDayKey(new Date(dayStart(dayKey).getTime() + days * 24 * 60 * 60_000))
}

export default async function MoneyDay(props: PageProps<'/admin/money'>) {
  await requireUser('admin')
  await ensureReady()
  const { day } = await props.searchParams

  const now = new Date()
  const todayKey = venueDayKey(now)
  const dayKey = typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : todayKey
  const isToday = dayKey === todayKey
  const from = dayStart(dayKey)
  const until = dayEnd(dayKey)

  const venue = await getVenue()
  const [tally, drift, onTheDay, debtors] = await Promise.all([
    dayTally(venue.id, from, until),
    moneyDrift(venue.id),
    // Asked of the database by date, not filtered out of the most recent sixty
    // games: the tally beside this panel is a proper range query, and the two
    // disagreeing — "18 charges raised" over an empty list of games — is worse
    // than either being wrong on its own.
    db
      .select({ id: gameSessions.id, slug: gameSessions.slug, title: gameSessions.title })
      .from(gameSessions)
      .where(
        and(
          isNull(gameSessions.deletedAt),
          gte(gameSessions.startsAt, from),
          lt(gameSessions.startsAt, until),
        ),
      )
      .orderBy(asc(gameSessions.startsAt)),
    // Venue-wide and longest-waiting first, because a debt belongs to a person
    // rather than to the Tuesday it came from. One query, not one per debtor.
    debtorsFor(venue.id),
  ])

  /**
   * The night each debt came from, and the game it was.
   *
   * Two reads for the whole list rather than one per person: this page is
   * `force-dynamic` and a hundred debtors used to mean a hundred round trips
   * just to put a name on a link. The query count is fixed now, whoever owes.
   */
  const oldest = await oldestOpenChargeFor(
    debtors.map((d) => d.playerId),
    venue.id,
  )
  const fromSessions = [
    ...new Set([...oldest.values()].map((o) => o.sessionId).filter((id): id is string => !!id)),
  ]
  const games = new Map<string, { slug: string; title: string }>()
  if (fromSessions.length) {
    const rows = await db
      .select({ id: gameSessions.id, slug: gameSessions.slug, title: gameSessions.title })
      .from(gameSessions)
      .where(inArray(gameSessions.id, fromSessions))
    for (const g of rows) games.set(g.id, { slug: g.slug, title: g.title })
  }

  const debts = debtors.map((d) => {
    const o = oldest.get(d.playerId) ?? null
    return { ...d, oldest: o, game: o?.sessionId ? (games.get(o.sessionId) ?? null) : null }
  })

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/admin/games"
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          Games
        </Link>
        <h1 className="mt-1 text-title text-text">{venueDate(from)}</h1>
        <p className="num mt-1 text-meta text-text-3">
          {isToday ? 'Today · ' : ''}
          {tally.charges} {tally.charges === 1 ? 'charge' : 'charges'} raised
        </p>
      </header>

      <div className="flex items-center justify-between gap-2">
        <Link href={`/admin/money?day=${shiftDay(dayKey, -1)}` as never} className={SECONDARY_LINK}>
          ← {venueDate(dayStart(shiftDay(dayKey, -1)))}
        </Link>
        <Link href={`/admin/money?day=${shiftDay(dayKey, 1)}` as never} className={SECONDARY_LINK}>
          {venueDate(dayStart(shiftDay(dayKey, 1)))} →
        </Link>
      </div>

      {/* Shown only when it is bad news. An empty answer is the whole point of
          asking, and a green "the books agree" on every load is the line that
          stops being read on the day it changes. */}
      {drift.length > 0 ? (
        <Notice
          tone="alert"
          title="The books disagree with the rows"
          detail={drift.map((d) => `${d.id} · ${rupees(d.stored)} on the row, ${rupees(d.fromRows)} in the ledger`).join(' — ')}
        >
          A settlement counter no longer matches the rows it summarises, so nothing on this page can
          be trusted to add up. Send these ids on before taking any more money.
        </Notice>
      ) : null}

      <section className="flex flex-col gap-2.5">
        <SectionHead
          title="Money in"
          meta="Cash matches the drawer. Everything else matches somebody’s statement."
        />
        <Panel>
          <ul className="divide-y divide-line">
            {tally.byMethod.length === 0 ? (
              <li className="px-4 py-3.5 text-row text-text-3">Nothing came in on this day.</li>
            ) : (
              tally.byMethod.map((m) => (
                <li key={m.method} className="flex items-center gap-3 px-4 py-3.5">
                  <span className="min-w-0 flex-1 text-row text-text">
                    {METHOD_WORDS[m.method] ?? m.method}
                    <span className="ml-1.5 text-meta text-text-3">
                      {m.count} {m.count === 1 ? 'payment' : 'payments'}
                    </span>
                  </span>
                  <span className="num text-row text-text">{rupees(m.paise)}</span>
                </li>
              ))
            )}
            <li className="flex items-center gap-3 bg-sunken px-4 py-3.5">
              <span className="min-w-0 flex-1 text-row font-semibold text-text">Taken</span>
              <span className="num text-section text-text">{rupees(tally.takenPaise)}</span>
            </li>
          </ul>
        </Panel>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionHead
          title="The night"
          meta="Counted by when the charge was raised, while money in above is counted by when it arrived — these are not two halves of one sum. A credit is value given, not money received, so it never joins the cash line."
        />
        <Panel>
          <ul className="divide-y divide-line">
            <li className="flex items-center gap-3 px-4 py-3.5">
              <span className="min-w-0 flex-1 text-row text-text">Charged</span>
              <span className="num text-row text-text">{rupees(tally.chargedPaise)}</span>
            </li>
            <li className="flex items-center gap-3 px-4 py-3.5">
              <span className="min-w-0 flex-1 text-row text-text">
                Credits
                <span className="ml-1.5 text-meta text-text-3">given, not banked</span>
              </span>
              <span className="num text-row text-text">{rupees(tally.creditedPaise)}</span>
            </li>
            <li className="flex items-center gap-3 px-4 py-3.5">
              <span className="min-w-0 flex-1 text-row text-text">Refunded</span>
              <span className="num text-row text-text">{rupees(tally.refundedPaise)}</span>
            </li>
            <li className="flex items-center gap-3 bg-sunken px-4 py-3.5">
              <span className="min-w-0 flex-1 text-row font-semibold text-text">Still owed</span>
              <span className="num text-section text-text">{rupees(tally.owedPaise)}</span>
            </li>
          </ul>
        </Panel>
      </section>

      <section className="flex flex-col gap-2.5">
        <SectionHead
          title="Who owes"
          meta={
            debts.length
              ? `${debts.length} ${debts.length === 1 ? 'person' : 'people'} · longest waiting first · the whole venue, not just this day`
              : undefined
          }
        />
        {debts.length === 0 ? (
          <EmptyState title="Nobody is short">
            <p>Nothing is outstanding anywhere at the venue.</p>
          </EmptyState>
        ) : (
          <Panel>
            <ul className="divide-y divide-line">
              {debts.map((d) => (
                <li key={d.playerId} className="flex flex-col gap-2 px-4 py-3.5 sm:flex-row sm:items-center sm:gap-3">
                  <div className="min-w-0 sm:flex-1">
                    <p className="text-row text-text">{d.name}</p>
                    <p className="num mt-0.5 text-meta text-text-3">
                      {d.phone ?? 'no number'} · {d.oldest?.reason ?? 'open charges'}
                      {d.openCharges > 1 ? ` · ${d.openCharges - 1} more open` : ''}
                    </p>
                    {/* What the figure beside them is made of. The headline is
                        the balance — what to actually ask for — and on account
                        is money of theirs the venue is already holding, so
                        leaving it implied is how a host asks for ₹300 while
                        sitting on ₹100 of it. */}
                    <p className="num mt-0.5 text-meta text-text-3">
                      {d.oldestOpenAt ? `since ${venueDate(d.oldestOpenAt)} · ` : ''}
                      {rupees(d.owedPaise)} on open charges
                      {d.onAccountPaise > 0 ? ` · ${rupees(d.onAccountPaise)} of theirs on account` : ''}
                    </p>
                  </div>
                  <span className="num shrink-0 text-section text-text">{rupees(d.balancePaise)}</span>
                  {d.game ? (
                    <Link href={`/admin/g/${d.game.slug}` as never} className={`${SECONDARY_LINK} shrink-0`}>
                      {d.game.title}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </section>

      {onTheDay.length > 0 ? (
        <section className="flex flex-col gap-2.5">
          <SectionHead title="Games on this day" />
          <Panel>
            <ul className="divide-y divide-line">
              {onTheDay.map((s) => (
                <li key={s.id}>
                  <Link
                    href={`/admin/g/${s.slug}` as never}
                    className="flex min-h-[64px] items-center gap-3 px-4 py-3 active:bg-sunken"
                  >
                    <span className="min-w-0 flex-1 text-row text-text">{s.title}</span>
                    <span aria-hidden className="text-text-3">
                      &rsaquo;
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}
    </div>
  )
}
