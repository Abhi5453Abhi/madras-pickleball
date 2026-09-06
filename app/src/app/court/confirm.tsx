'use client'

import { useActionState } from 'react'
import { courtAgree, courtDispute, type ConfirmState } from './actions'

/**
 * The two taps the whole integrity story rests on.
 *
 * Plain `<form action>` with `useActionState`, deliberately: at the far end of
 * a court on venue wifi the page often paints before its JavaScript arrives,
 * and a confirmation that silently does nothing for four seconds is a
 * confirmation nobody gives. This works either way, and says "Saving…" when it
 * can.
 *
 * "Not right" sits behind a `details`, which also works with no JavaScript. It
 * is not friction for its own sake: a dispute pins a red alert on the
 * organiser's board and stops the winners advancing, and it is one thumb-width
 * below a button people tap without reading.
 */
export function ConfirmButtons({
  matchId,
  agreeingTeamId,
  agreeingName,
}: {
  matchId: string
  agreeingTeamId: string
  agreeingName: string | null
}) {
  // The initial state is built here, not imported. A 'use server' module may
  // export nothing but async functions — a single exported constant makes the
  // whole module throw at evaluation, which took every court action down with
  // it and turned every score submitted from the net post into a 500.
  const empty: ConfirmState = { error: null }
  const [agreeState, agree, agreeing] = useActionState(courtAgree, empty)
  const [disputeState, dispute, disputing] = useActionState(courtDispute, empty)
  const problem = agreeState.error ?? disputeState.error

  return (
    <div className="flex flex-col gap-3">
      {problem ? (
        <p role="alert" className="rounded-control bg-alert-soft px-3.5 py-3 text-body text-text">
          {problem}
        </p>
      ) : null}

      <form action={agree}>
        <input type="hidden" name="matchId" value={matchId} />
        <input type="hidden" name="teamId" value={agreeingTeamId} />
        <button
          disabled={agreeing}
          className="min-h-[84px] w-full rounded-control bg-ink px-4 text-[22px] font-bold text-white disabled:opacity-60"
        >
          {agreeing ? 'Saving…' : 'That’s right'}
        </button>
      </form>
      <p className="-mt-1 text-meta text-text-2">
        {agreeingName ? `Tap it and it is done — ${agreeingName} have agreed the score.` : null}
        {!agreeingName ? 'Tap it and the score is settled.' : null}
      </p>

      <details className="group">
        <summary className="tap-xl flex items-center justify-center rounded-control border-2 border-text-3 bg-paper px-4 text-center text-[18px] font-bold text-text">
          That’s not the score
        </summary>
        <div className="pt-3">
          <div className="rounded-card border border-line-strong bg-paper p-4">
            <p className="text-body text-text">
              Nothing goes on the board and nobody advances until an organiser has been over and
              decided. Only do this if the two of you can’t agree at the net.
            </p>
            <p className="mt-2 text-meta text-text-2">
              If it is only a digit out, it is quicker to ask them to type it again.
            </p>
            <form action={dispute} className="mt-3">
              <input type="hidden" name="matchId" value={matchId} />
              <button
                disabled={disputing}
                className="tap-lg w-full rounded-control border-2 border-alert bg-paper text-[18px] font-bold text-alert disabled:opacity-60"
              >
                {disputing ? 'Telling them…' : 'Get the organiser'}
              </button>
            </form>
          </div>
        </div>
      </details>
    </div>
  )
}
