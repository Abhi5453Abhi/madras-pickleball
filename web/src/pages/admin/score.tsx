import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { rpc, RpcError } from '@/api/rpc'
import { useAction, useRpc } from '@/api/use-rpc'
import { Chevron, Confirm, Notice } from '@/components/ui'
import { SECONDARY_LINK } from '@/components/admin-ui'
import { ScoreEntry } from '@/components/score-entry'
import { Loading, LoadError, NotFoundCard, useTitle } from '@/lib/page'

/** The two states a result can already be in; the port has no reported/disputed. */
const STATE_WORDS: Record<string, string> = {
  final: 'The result is final',
  voided: 'This result was voided',
}

export function ScorePage() {
  useTitle('Enter a score · Madras Pickleball')
  const { matchId = '' } = useParams()
  const navigate = useNavigate()
  const loaded = useRpc('scoring.getMatchForScoring', { matchId })
  const { run } = useAction()
  const [err, setErr] = useState<string | null>(null)
  const [reason, setReason] = useState('')

  if (loaded.state === 'loading') return <Loading />
  if (loaded.state === 'missing') return <NotFoundCard>{loaded.error}</NotFoundCard>
  if (loaded.state !== 'ready') return <LoadError error={loaded.error} retry={() => void loaded.reload(false)} />

  const data = loaded.data
  const hasResult = data.match.resultState !== 'none'
  const back = '/admin/live'

  const existing = hasResult
    ? {
        scoreLine:
          data.games.length > 0 ? data.games.map((g) => `${g.scoreA}–${g.scoreB}`).join(', ') : null,
        winnerName:
          data.match.winnerTeamId === data.match.teamAId
            ? data.nameA
            : data.match.winnerTeamId === data.match.teamBId
              ? data.nameB
              : null,
        label: STATE_WORDS[data.match.resultState] ?? 'A result is already in',
      }
    : null

  async function voidThisMatch(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (reason.trim().length < 3) {
      setErr('Say why it is being cancelled — it goes in the log next to your name.')
      return
    }
    const res = await run('chaos.voidMatch', { matchId, reason: reason.trim() })
    // `voidMatch` refuses by naming the later match that was built off this
    // result. Throwing that sentence away is the bug that had to be fixed on
    // `sendToCourt`; it is the only thing that tells the organiser what to
    // sort out first.
    if (!res.ok) setErr(res.error)
  }

  return (
    <div className="flex flex-col gap-7">
      <Link
        to={back}
        className="tap -mb-4 -ml-2 inline-flex items-center gap-0.5 self-start px-2 text-[16px] font-semibold text-link"
      >
        <Chevron className="rotate-90" />
        Live board
      </Link>
      {err ? (
        <Notice tone="alert" title="Not done">
          {err}
        </Notice>
      ) : null}
      <ScoreEntry
        matchId={matchId}
        // The court only matters while they are on it; a correction an hour
        // later has no business shouting COURT 1 — the server sends it null
        // unless the match is live.
        courtName={data.courtName}
        courtColor={data.courtColorKey ?? undefined}
        categoryName={data.categoryName}
        roundName={data.match.roundName}
        teamAId={data.match.teamAId}
        teamBId={data.match.teamBId}
        nameA={data.nameA}
        nameB={data.nameB}
        rules={data.rules}
        authoritative
        existing={existing}
        onReload={() => void loaded.reload(false)}
        onSubmit={async (payload) => {
          try {
            const res = await rpc('scoring.saveResult', {
              matchId,
              games: payload.games,
              resultType: payload.resultType,
              winnerTeamId: payload.winnerTeamId,
              retiredTeamId: payload.retiredTeamId,
              reason: payload.reason,
            })
            if (res.ok) {
              navigate(back)
              return { ok: true }
            }
            return { ok: false, error: res.error }
          } catch (e) {
            if (e instanceof RpcError && e.redirect) navigate(e.redirect, { replace: true })
            return {
              ok: false,
              error: e instanceof Error ? e.message : 'Something went wrong. Try again in a moment.',
              recover: 'retry' as const,
            }
          }
        }}
      />

      {/* An organiser arrives here from the escape hatch to LOOK at a score as
          often as to change one, and leaving with the browser button loses the
          scroll position on the page they came from. */}
      <Link to={back} className={SECONDARY_LINK}>
        Back to the live board
      </Link>

      {/* Cancelling is not correcting: the match counts for nobody afterwards,
          in no table and no difference column. Organiser only, never while it
          is on court, and never silently — the reason is required. */}
      {data.match.status !== 'live' ? (
        <Confirm
          label="Cancel this match"
          question={`${data.nameA} v ${data.nameB} stops counting for anybody — no winner, no points, and it leaves both pairs' tables.`}
          detail="Use this when a match should never have existed. To fix a wrong score, change the score above instead."
        >
          <form onSubmit={voidThisMatch} className="flex flex-col gap-2">
            <input
              name="reason"
              required
              minLength={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why — e.g. entered against the wrong pair"
              aria-label="Why this match is being cancelled"
              className="tap w-full rounded-control border border-line-key bg-paper px-3.5 text-body text-text placeholder:text-text-3"
            />
            <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
              Cancel it
            </button>
          </form>
        </Confirm>
      ) : null}
    </div>
  )
}
