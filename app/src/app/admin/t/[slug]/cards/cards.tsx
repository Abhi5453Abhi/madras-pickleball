'use client'

import { useActionState, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { makeCards, revokeCards, type CardsState, type Card } from './actions'
import { Button, CourtMark, CourtSwatch, NetRule, Notice } from '@/components/ui'

const COURT_DOT: Record<string, string> = {
  blue: 'bg-court-blue',
  orange: 'bg-court-orange',
  teal: 'bg-court-teal',
  violet: 'bg-court-violet',
}

function CardFace({ card }: { card: Card }) {
  const [svg, setSvg] = useState('')

  // The origin is read in here rather than held in the parent's state: a card
  // only ever exists after the organiser has tapped Make, so there is no first
  // paint to keep in step, and lifting it out meant a setState in an effect
  // body on every render of the screen.
  useEffect(() => {
    QRCode.toString(`${window.location.origin}/c/${card.raw}`, {
      type: 'svg',
      margin: 0,
      errorCorrectionLevel: 'M',
    })
      .then(setSvg)
      .catch(() => setSvg(''))
  }, [card.raw])

  return (
    <article className="break-inside-avoid rounded-card border-2 border-line-strong bg-paper p-5">
      <div className="flex items-center gap-2">
        <CourtSwatch colorKey={card.colorKey} />
        <span className="font-score text-[44px] leading-none font-bold text-text uppercase">
          {card.courtName}
        </span>
        <CourtMark className="ml-auto size-8 text-ink" />
      </div>
      <NetRule className="my-3" />
      <div
        className="mx-auto w-44 [&>svg]:h-auto [&>svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <p className="num mt-3 text-center text-[26px] font-bold tracking-[0.06em] text-text">
        {card.raw}
      </p>
      <p className="mt-2 text-center text-body text-text-2">
        Scan when your match ends. Type the score.
      </p>
      <div aria-hidden className={`mt-4 h-1.5 rounded-full ${COURT_DOT[card.colorKey] ?? 'bg-court-blue'}`} />
    </article>
  )
}

export function Cards({ slug }: { slug: string }) {
  const [state, action, pending] = useActionState(makeCards, { cards: [] } as CardsState)
  const [revokeState, revokeAction] = useActionState(revokeCards, { cards: [] } as CardsState)
  const [armed, setArmed] = useState(false)

  return (
    <div className="flex flex-col gap-5">
      {state.error ? <Notice>{state.error}</Notice> : null}
      {revokeState.revoked ? (
        <Notice tone="waiting">
          {revokeState.revoked} card{revokeState.revoked === 1 ? '' : 's'} retired. Anyone holding
          the old ones can no longer enter scores.
        </Notice>
      ) : null}

      <div className="flex flex-wrap gap-2 print:hidden">
        <form action={action}>
          <input type="hidden" name="slug" value={slug} />
          <Button disabled={pending}>{pending ? 'Making them…' : 'Make the cards'}</Button>
        </form>
        {state.cards.length ? (
          <Button variant="secondary" type="button" onClick={() => window.print()}>
            Print
          </Button>
        ) : null}
      </div>

      {/* Revoking mid-day stops every phone at every net post from entering a
          score, and there is no undo — the codes are gone. Two taps, and the
          second one says so. */}
      <div className="print:hidden">
        {armed ? (
          <form action={revokeAction} className="flex flex-col gap-2">
            <input type="hidden" name="slug" value={slug} />
            <p className="rounded-control bg-alert-soft px-3.5 py-3 text-body font-medium text-alert">
              Every card taped to a net post stops working immediately, and nobody can enter a score
              until you print new ones. Do this when the QR has been posted somewhere it shouldn’t
              be.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" className="flex-1 basis-[9rem]">
                Yes — retire every card
              </Button>
              <Button
                type="button"
                variant="secondary"
                className="flex-1 basis-[9rem]"
                onClick={() => setArmed(false)}
              >
                Leave them
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="secondary" type="button" onClick={() => setArmed(true)}>
            Revoke all the cards
          </Button>
        )}
      </div>

      {state.cards.length ? (
        <>
          <p className="rounded-control bg-waiting-soft px-3.5 py-3 text-body font-medium text-waiting print:hidden">
            These codes are shown once. Print them now — if you lose the sheet, make new cards,
            which retires these.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {state.cards.map((c) => (
              <CardFace key={c.raw} card={c} />
            ))}
          </div>
        </>
      ) : (
        <p className="rounded-card border border-line-strong bg-paper p-4 text-body text-text-2 print:hidden">
          Making the cards prints a fresh code for every court and <strong>retires any old ones</strong> —
          so do it once, before the first match, not halfway through the day. Laminate them and
          cable-tie one to each net post.
        </p>
      )}
    </div>
  )
}
