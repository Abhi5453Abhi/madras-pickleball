'use client'

import Link from 'next/link'
import { Button, NetRule, Wordmark } from '@/components/ui'

/**
 * What replaces the screen when something throws — SPEC A8's worst moment.
 *
 * Next's own boundary puts a hex digest where the sentence should be, and a
 * player standing at a net post with a score in their head cannot do anything
 * with a hex digest. So: what happened, what it probably is, and two ways out
 * — one that retries and one that always works.
 *
 * `retry`, not `reset`: this version's `reset` re-renders the same children
 * without re-fetching, which for a failed fetch is a button that redraws the
 * failure. `retry` goes back to the server. (Next 16.3; see
 * node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/error.md.)
 *
 * The digest is kept, but demoted to the bottom in small type and labelled as
 * something to read out, because that is the only thing anybody can do with
 * it. In production it is all the server will hand over.
 */
export default function Error({
  error,
  retry,
}: {
  error: Error & { digest?: string }
  retry: () => void
}) {
  return (
    <div className="min-h-dvh bg-ground">
      <header className="masthead relative overflow-hidden bg-ink px-4 pt-6 pb-6 text-white">
        <div className="mx-auto w-full max-w-3xl">
          <Wordmark />
          <h1 className="mt-3 text-hero">This page didn&rsquo;t load</h1>
        </div>
        <NetRule className="absolute inset-x-0 bottom-0" />
      </header>

      <main id="main" className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4">
        <p className="text-body text-text-2">
          It is usually the connection rather than the day. Nothing at the venue has changed
          because of this, and no score has been lost — anything already entered is on the board.
        </p>

        <Button onClick={() => retry()} className="w-full">
          Try again
        </Button>

        <Link
          href="/"
          className="tap flex items-center justify-center rounded-control border border-line-key bg-paper text-[17px] font-semibold text-text"
        >
          Back to today&rsquo;s tournament
        </Link>

        <p className="mt-2 border-t border-line pt-4 text-meta text-text-3">
          Still stuck? Scan the card on the net post again, or find the organiser. If it keeps
          happening, read them this code
          {error.digest ? (
            <>
              : <span className="num text-text-2">{error.digest}</span>
            </>
          ) : (
            <> — there isn&rsquo;t one this time, so tell them what you were doing instead.</>
          )}
        </p>
      </main>
    </div>
  )
}
