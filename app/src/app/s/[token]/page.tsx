import Link from 'next/link'
import { Button, Card, Confirm, Notice, StatusPill } from '@/components/ui'
import { courtsLabel, rupees } from '@/lib/display'
import { gatePhase } from '@/lib/daily-clock'
import { venueDate, venueTime } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'
import { resolveSpotToken, sessionCourts } from '@/server/sessions'
import { Masthead } from '../../t/court-card'
import { confirmMySpot, releaseMySpot } from './actions'
import { isSpotOutcome, type SpotOutcome } from './outcome'

/**
 * A player's own spot.
 *
 * No login: the link is the authority. It is what the confirmation gate asks
 * you to tap and what lets you give the spot up without messaging anybody —
 * and in stage 1 the host is the only delivery channel there is, so this page
 * has to work from a WhatsApp forward on somebody else's phone.
 */
export const dynamic = 'force-dynamic'

export const metadata = {
  title: 'Your spot · Madras Pickleball',
  robots: { index: false, follow: false },
}

/** Fixed sentences for fixed codes — nothing from the URL is ever rendered. */
const OUTCOME: Record<SpotOutcome, { tone: 'done' | 'alert' | 'waiting'; text: string }> = {
  confirmed: { tone: 'done', text: 'You’re confirmed. See you there.' },
  released: { tone: 'done', text: 'Spot let go. Thanks for saying so.' },
  'released-promoted': { tone: 'done', text: 'Spot let go — the next person on the waitlist moves up.' },
  gone: { tone: 'alert', text: 'That link isn’t working any more. Ask the host.' },
  over: { tone: 'alert', text: 'That game has finished, so nothing changed.' },
  started: { tone: 'alert', text: 'That game has started. Have a word with the host — nothing changed.' },
  nothing: { tone: 'waiting', text: 'Nothing to do — that had already happened.' },
}

const WORDS: Record<string, { label: string; tone: 'live' | 'waiting' | 'done' | 'ready' | 'alert' }> = {
  joined: { label: 'Not confirmed', tone: 'waiting' },
  confirmed: { label: 'Confirmed', tone: 'ready' },
  waitlisted: { label: 'Waiting', tone: 'waiting' },
  checked_in: { label: 'Here', tone: 'live' },
  played: { label: 'Played', tone: 'done' },
  absent: { label: 'Marked away', tone: 'alert' },
  withdrawn: { label: 'Not on the list', tone: 'done' },
}

export default async function SpotPage(props: PageProps<'/s/[token]'>) {
  await ensureReady()
  const { token } = await props.params
  const { r } = await props.searchParams
  const outcome = isSpotOutcome(r) ? OUTCOME[r] : null
  const spot = await resolveSpotToken(token)

  if (!spot) {
    return (
      <main id="main" className="min-h-dvh bg-ground pb-16">
        <Masthead title="That link isn’t working" sub="Madras Pickleball" />
        <div className="mx-auto w-full max-w-3xl px-4 pt-6">
          <Notice tone="alert" title="No spot here">
            It is probably an older game that has since finished, or a link that lost a character
            being passed on. Ask the host to put you back on.
          </Notice>
          <Link
            href="/games"
            className="tap mt-4 flex items-center justify-center rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text"
          >
            See what else is on
          </Link>
        </div>
      </main>
    )
  }

  const { participant: p, session: s } = spot
  // The court names, read live: a spot link is opened at the gate, and which
  // court is the thing the person standing there does not know.
  const courtNames = (await sessionCourts(s.id)).map((c) => c.name)
  const now = new Date()
  const word = WORDS[p.state] ?? WORDS.joined
  const gate = gatePhase(s, now)
  const over = s.status === 'ended' || s.status === 'locked' || s.status === 'cancelled'
  const gone = p.state === 'withdrawn'
  const canLeave = !over && !gone && now < s.startsAt
  const mustConfirm = !over && !gone && p.state === 'joined' && gate !== 'before'

  return (
    <main id="main" className="min-h-dvh bg-ground pb-16">
      <Masthead
        title={s.title}
        sub={`${venueDate(s.startsAt)} · ${venueTime(s.startsAt)}–${venueTime(s.endsAt)}`}
      />

      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pt-6">
        {outcome ? <Notice tone={outcome.tone}>{outcome.text}</Notice> : null}

        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <p className="text-title text-text">{p.displayName}</p>
              <p className="num mt-0.5 text-meta text-text-2">
                {s.pricePaise > 0 ? rupees(s.pricePaise) : 'Free'} ·{' '}
                {courtsLabel(courtNames, s.courtCount)}
              </p>
            </div>
            <StatusPill state={word.tone}>{word.label}</StatusPill>
          </div>

          {s.status === 'cancelled' ? (
            <p className="mt-3 text-body text-text-2">
              This game was called off. Nobody is charged for it.
            </p>
          ) : /* `over` first: a waitlisted player on a game that has finished must
                 not be told they might still move up. */
          over && p.state === 'waitlisted' ? (
            <p className="mt-3 text-body text-text-2">
              That game has finished and a spot never came free. Nothing to pay.
            </p>
          ) : p.state === 'waitlisted' ? (
            <p className="mt-3 text-body text-text-2">
              You’re on the waitlist. If somebody drops out you move up on your own and this page
              says so — there is nothing to keep checking.
            </p>
          ) : p.state === 'absent' ? (
            <p className="mt-3 text-body text-text-2">
              The host has you down as not having played, so there’s nothing to pay. If that’s
              wrong, tell them.
            </p>
          ) : p.state === 'played' ? (
            <p className="mt-3 text-body text-text-2">You played. The host settles up afterwards.</p>
          ) : gone ? (
            <p className="mt-3 text-body text-text-2">
              You’re not on this list any more. You can join again from the game page if there’s
              room.
            </p>
          ) : (
            <p className="mt-3 text-body text-text-2">
              Nothing to pay now — the host sorts the money out after you’ve played.
            </p>
          )}
        </Card>

        {mustConfirm ? (
          <section className="flex flex-col gap-3">
            <Notice
              tone="waiting"
              title="Say you’re coming"
              detail={
                s.confirmDeadlineAt
                  ? `Spots that aren’t confirmed by ${venueTime(s.confirmDeadlineAt)} go to whoever is waiting.`
                  : undefined
              }
            >
              Tap once so the host knows. It costs you nothing and it frees the spot for somebody
              else if you can’t make it.
            </Notice>
            <form action={confirmMySpot}>
              <input type="hidden" name="token" value={token} />
              <Button type="submit" className="w-full">
                Yes, I’m coming
              </Button>
            </form>
          </section>
        ) : null}

        {p.state === 'confirmed' && !over ? (
          <p className="text-body text-text-2">
            You’re confirmed{p.promotedAt ? ' — you came off the waitlist' : ''}. See you at{' '}
            <span className="num">{venueTime(s.startsAt)}</span>.
          </p>
        ) : null}

        {canLeave ? (
          <Confirm
            label="I can’t make it"
            question={`Give up your spot for ${s.title}?`}
            detail="Whoever is first on the waitlist takes it straight away. You can join again if a spot opens up."
          >
            <form action={releaseMySpot}>
              <input type="hidden" name="token" value={token} />
              <Button type="submit" variant="secondary" className="w-full">
                Let the spot go
              </Button>
            </form>
          </Confirm>
        ) : null}

        {!over && !canLeave && !gone ? (
          <p className="text-meta text-text-3">
            The game has started, so this can’t be changed here — have a word with the host.
          </p>
        ) : null}

        <div className="border-t border-line pt-4">
          <Link
            href={`/g/${s.slug}` as never}
            className="tap flex items-center justify-center rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text"
          >
            See who else is playing
          </Link>
          {p.isGuest ? <p className="mt-2 text-meta text-text-3">You’re down as somebody’s guest.</p> : null}
        </div>
      </div>
    </main>
  )
}
