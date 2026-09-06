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

function CardFace({ card, origin }: { card: Card; origin: string }) {
  const [svg, setSvg] = useState('')
  const url = `${origin}/c/${card.raw}`

  useEffect(() => {
    QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' })
      .then(setSvg)
      .catch(() => setSvg(''))
  }, [url])

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
  const [origin, setOrigin] = useState('')

  useEffect(() => setOrigin(window.location.origin), [])

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
        <form action={revokeAction}>
          <input type="hidden" name="slug" value={slug} />
          <Button variant="secondary">Revoke all</Button>
        </form>
        {state.cards.length ? (
          <Button variant="secondary" type="button" onClick={() => window.print()}>
            Print
          </Button>
        ) : null}
      </div>

      {state.cards.length ? (
        <>
          <p className="rounded-control bg-waiting-soft px-3.5 py-3 text-body font-medium text-waiting print:hidden">
            These codes are shown once. Print them now — if you lose the sheet, make new cards,
            which retires these.
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            {state.cards.map((c) => (
              <CardFace key={c.raw} card={c} origin={origin} />
            ))}
          </div>
        </>
      ) : (
        <p className="rounded-card border border-line-strong bg-paper p-4 text-body text-text-2 print:hidden">
          Making the cards prints a fresh code for every court and retires any old ones. Laminate
          them and cable-tie one to each net post.
        </p>
      )}
    </div>
  )
}
