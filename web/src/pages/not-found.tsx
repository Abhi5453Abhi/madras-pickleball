import { Link } from 'react-router'
import { NetRule, Wordmark } from '@/components/ui'

/**
 * A link that leads nowhere, and the two reasons it usually does here: it is
 * last month's tournament, forwarded through the group chat one Sunday too
 * late, or a character fell off the end of it on the way.
 *
 * Both have the same answer, so the page is one sentence and one target. No
 * "404" — the number tells a person nothing they can act on.
 */
export function NotFound({ message }: { message?: string }) {
  return (
    <div className="min-h-dvh bg-ground">
      <header className="masthead relative overflow-hidden bg-ink px-4 pt-6 pb-6 text-white">
        <div className="mx-auto w-full max-w-3xl">
          <Wordmark />
          <h1 className="mt-3 text-hero">There&rsquo;s nothing at this link</h1>
        </div>
        <NetRule className="absolute inset-x-0 bottom-0" />
      </header>

      <main id="main" className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        <p className="text-body text-text-2">
          {message ??
            'It is probably an older tournament that has since been taken down, or a link that lost a character being passed on. Today’s play is on the front page.'}
        </p>

        <Link
          to="/"
          className="tap-lg flex w-full items-center justify-center rounded-control bg-ink px-5 text-[19px] font-bold text-white"
        >
          Go to today&rsquo;s tournament
        </Link>

        <p className="mt-2 border-t border-line pt-4 text-meta text-text-3">
          Scoring a match? The QR card on the net post is the way in — this page is not.
        </p>
      </main>
    </div>
  )
}
