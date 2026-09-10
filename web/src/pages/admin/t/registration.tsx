import { useState, type FormEvent } from 'react'
import { Link, useParams } from 'react-router'
import type { Output } from '@/api/contract'
import { useAction, useRpc } from '@/api/use-rpc'
import { Card, Chevron, Confirm, EmptyState, Notice, Panel, Tag } from '@/components/ui'
import { ROW_BUTTON, SECONDARY_LINK } from '@/components/admin-ui'
import { venueDate } from '@/lib/time'
import { signupsClosed } from '@/lib/words'
import { Loading, LoadError, NotFoundCard, useTitle } from '@/lib/page'

type Tournament = Output<'tournaments.getTournamentBySlug'>

/**
 * Registration — SPEC v4. The link, then everyone who is in and how they got
 * there. "Add a player" sits right under the link for the ones who phoned.
 * Nobody waits for approval: a sign-up is on the list the moment it lands,
 * and the only question the organiser is ever asked is "same person?".
 */
export function RegistrationPage() {
  const { slug = '' } = useParams()
  const loaded = useRpc('tournaments.getTournamentBySlug', { slug })
  useTitle(
    loaded.state === 'ready'
      ? `Registration · ${loaded.data.name}`
      : 'Registration · Madras Pickleball',
  )

  if (loaded.state === 'loading') return <Loading />
  if (loaded.state === 'missing') return <NotFoundCard />
  if (loaded.state !== 'ready') return <LoadError error={loaded.error} retry={() => void loaded.reload(false)} />

  return <Registration slug={slug} tournament={loaded.data} reloadTournament={() => void loaded.reload()} />
}

function Registration({
  slug,
  tournament,
  reloadTournament,
}: {
  slug: string
  tournament: Tournament
  reloadTournament: () => void
}) {
  const tournamentId = tournament.id
  const link = useRpc('registration.ensureRegistrationLink', { tournamentId })
  const roster = useRpc('registration.listRoster', { tournamentId })
  const { run } = useAction()
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const closed = signupsClosed(tournament)
  const started = tournament.status !== 'setup'
  // Once it is over, the list is a record: nobody is added to or taken off a
  // finished tournament.
  const over = tournament.status === 'completed'
  const doubles = tournament.discipline !== 'singles'

  const rows = roster.state === 'ready' ? roster.data : []
  // A possible duplicate is the one row that needs a decision, so it goes to
  // the top of the list rather than wherever it arrived.
  const flagged = rows.filter((r) => r.duplicateOf).length
  const ordered = [...rows.filter((r) => r.duplicateOf), ...rows.filter((r) => !r.duplicateOf)]

  /** After every one: reload the roster (and the tournament) and say what happened. */
  async function settle(res: { ok: true; note?: string } | { ok: false; error: string }) {
    if (res.ok) {
      setErr(null)
      setNote(res.note ?? null)
    } else {
      setNote(null)
      setErr(res.error)
    }
    reloadTournament()
    await roster.reload()
    await link.reload()
  }

  /** "Same as Ravi Shankar?" — Same person merges, Different clears the flag. */
  async function settleDuplicate(e: FormEvent<HTMLFormElement>, playerId: string, keepId: string) {
    e.preventDefault()
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null
    const same = submitter?.value === 'same'
    await settle(
      same
        ? await run('registration.mergePlayers', { tournamentId, keepId, dropId: playerId })
        : await run('registration.keepBoth', { tournamentId, playerId }),
    )
  }

  const token = link.state === 'ready' ? link.data?.token : undefined
  const fullLink = token ? `${window.location.origin}/r/${token}` : ''
  const shown = token ? `${window.location.host}/r/${token}` : ''

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          to={`/admin/t/${slug}`}
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          {tournament.name}
        </Link>
        <h1 className="mt-1 text-title text-text">Registration</h1>
        <p className="num mt-1 text-meta text-text-3">
          {rows.length} in · sign-ups {closed ? 'closed' : 'open'}
          {flagged ? ` · ${flagged} possible ${flagged === 1 ? 'duplicate' : 'duplicates'}` : ''}
        </p>
      </header>

      {err ? (
        <Notice tone="alert" title="Not done">
          {err}
        </Notice>
      ) : null}
      {note ? <Notice tone="done">{note}</Notice> : null}

      {/* Started: the sub line already says sign-ups are closed, and there is
          nothing to reopen, so the card would only explain itself. */}
      {closed && started ? null : closed ? (
        <Card className="border-line-key p-4">
          <p className="font-score text-eyebrow text-text-2 uppercase">Sign-ups closed</p>
          <p className="mt-1 text-body text-text-2">
            Players who open the link see “Sign-ups have closed — ask the organiser.”
          </p>
          <form
            className="mt-3"
            onSubmit={async (e) => {
              e.preventDefault()
              await settle(await run('events.reopenRegistration', { tournamentId }))
            }}
          >
            <input type="hidden" name="slug" value={slug} />
            <button className={SECONDARY_LINK}>Reopen sign-ups</button>
          </form>
        </Card>
      ) : link.state !== 'ready' ? (
        <Loading lines={1} />
      ) : !token ? (
        <Card className="border-line-key p-4">
          <p className="font-score text-eyebrow text-text-2 uppercase">The day has passed</p>
          <p className="mt-1 text-body text-text-2">
            The sign-up link stopped working at the end of {venueDate(tournament.day)}. You can still
            add or remove people here.
          </p>
        </Card>
      ) : (
        <>
          <LinkCard shown={shown} full={fullLink} />
          <Confirm
            label="Close sign-ups"
            question="The link stops taking new names straight away. Everyone already on the list stays, and you can still add or remove people here."
          >
            <form
              onSubmit={async (e) => {
                e.preventDefault()
                await settle(await run('events.closeRegistration', { tournamentId }))
              }}
            >
              <input type="hidden" name="slug" value={slug} />
              <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                Close sign-ups
              </button>
            </form>
          </Confirm>
        </>
      )}

      {over ? null : <AddPlayerForm tournamentId={tournamentId} onAdded={() => void settle({ ok: true })} />}

      <section className="flex flex-col gap-3">
        <h2 className="font-score text-eyebrow text-text-2 uppercase">
          Players
          {rows.length ? (
            <small className="num ml-1 font-normal normal-case text-text-3">{rows.length}</small>
          ) : null}
        </h2>
        {roster.state === 'loading' ? <Loading lines={1} /> : null}
        {roster.state === 'ready' && rows.length === 0 ? (
          <EmptyState title="Nobody on the list yet">
            <p>
              {closed
                ? 'Sign-ups are closed. Add people by hand above.'
                : 'Send the link to the group, or add people by hand above.'}
            </p>
          </EmptyState>
        ) : null}
        {rows.length ? (
          <Panel>
            <ul className="divide-y divide-line">
              {ordered.map((r) => {
                // "wants Sathish Kumar · via link". A flagged row skips "no
                // partner named": the tag under it is the thing to read.
                const meta = [
                  doubles && r.partner ? `wants ${r.partner}` : null,
                  doubles && !r.partner && !r.duplicateOf ? 'no partner named' : null,
                  r.source === 'link' ? 'via link' : 'added by you',
                ]
                  .filter(Boolean)
                  .join(' · ')
                return (
                  <li key={r.playerId} className="flex flex-col gap-2 px-4 py-3">
                    <div className="flex flex-wrap items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-row text-text">{r.name}</p>
                        <p className="text-meta text-text-3">{meta}</p>
                        {r.duplicateOf ? (
                          <p className="mt-1.5">
                            <Tag tone="waiting">Same as {r.duplicateOf.name}?</Tag>
                          </p>
                        ) : null}
                      </div>
                      {over ? null : (
                        <Confirm
                          className="ml-auto shrink-0 [&>summary]:border-0 [&>summary]:px-2 [&>summary]:text-link [&[open]]:w-full"
                          label="Remove"
                          question={`${r.name} comes off the list. If they are in a pair that has not played, the pair is split.`}
                        >
                          <form
                            onSubmit={async (e) => {
                              e.preventDefault()
                              await settle(
                                await run('registration.removePlayer', {
                                  tournamentId,
                                  playerId: r.playerId,
                                }),
                              )
                            }}
                          >
                            <input type="hidden" name="slug" value={slug} />
                            <input type="hidden" name="playerId" value={r.playerId} />
                            <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                              Take {r.name} off
                            </button>
                          </form>
                        </Confirm>
                      )}
                    </div>
                    {r.duplicateOf ? (
                      // One form with two named buttons, as the reference had
                      // it: which one was pressed is read off the submitter,
                      // so Enter in the row still settles it the same way.
                      <form onSubmit={(e) => settleDuplicate(e, r.playerId, r.duplicateOf!.playerId)} className="flex gap-2">
                        <input type="hidden" name="slug" value={slug} />
                        <input type="hidden" name="playerId" value={r.playerId} />
                        <input type="hidden" name="keepId" value={r.duplicateOf.playerId} />
                        <button name="decision" value="same" className={`${ROW_BUTTON} flex-1`}>
                          Same person
                        </button>
                        <button name="decision" value="different" className={`${SECONDARY_LINK} flex-1`}>
                          Different
                        </button>
                      </form>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Panel>
        ) : null}
      </section>
    </div>
  )
}

/**
 * The sign-up link, with the two things the organiser does with it: copy it,
 * or send it straight to WhatsApp.
 */
function LinkCard({ shown, full }: { shown: string; full: string }) {
  const [copied, setCopied] = useState<'no' | 'yes' | 'select'>('no')
  const [text, setText] = useState<HTMLParagraphElement | null>(null)

  async function copy() {
    try {
      await navigator.clipboard.writeText(full)
      setCopied('yes')
    } catch {
      // Blocked in plenty of in-app browsers. Select the text instead, so a
      // long press does what the button could not.
      if (text) {
        const range = document.createRange()
        range.selectNodeContents(text)
        const sel = window.getSelection()
        sel?.removeAllRanges()
        sel?.addRange(range)
      }
      setCopied('select')
    }
  }

  return (
    <Card className="p-4">
      <p className="font-score text-eyebrow text-text-2 uppercase">Sign-up link</p>
      <p ref={setText} className="num mt-1 text-body break-all text-text-2 select-all">
        {shown}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" onClick={copy} className={ROW_BUTTON}>
          {copied === 'yes' ? 'Copied' : 'Copy'}
        </button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(`Sign up here — name, phone, and who you want to play with: ${full}`)}`}
          target="_blank"
          rel="noreferrer"
          aria-label="Send on WhatsApp"
          className="tap inline-flex items-center justify-center rounded-control border border-line-key bg-paper px-3.5 text-text"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden="true">
            <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm5.71 14.16c-.24.68-1.19 1.25-1.94 1.4-.5.1-1.16.19-3.38-.72-2.84-1.17-4.67-4.05-4.81-4.24-.14-.19-1.16-1.54-1.16-2.95 0-1.4.73-2.09 1-2.38.24-.26.53-.32.71-.32h.51c.16 0 .38-.03.6.46.24.55.79 1.9.86 2.04.07.14.11.31.02.5-.09.19-.14.31-.28.48-.14.16-.29.36-.41.49-.14.14-.28.29-.12.57.16.28.71 1.17 1.53 1.9 1.05.94 1.94 1.24 2.22 1.38.28.14.44.12.6-.07.16-.19.68-.79.86-1.06.18-.28.36-.23.6-.14.24.09 1.55.73 1.81.86.26.14.44.2.5.32.06.11.06.65-.18 1.33z" />
          </svg>
        </a>
      </div>
      {copied === 'select' ? (
        <p className="mt-2 text-meta text-text-2">
          Copying is blocked here — the link is selected, so hold and copy.
        </p>
      ) : null}
    </Card>
  )
}

/**
 * One line, one button. A textarea, not an input: the list from the group chat
 * is one name per line, and an input would flatten it into one long name.
 */
function AddPlayerForm({ tournamentId, onAdded }: { tournamentId: string; onAdded: () => void }) {
  const { run, pending } = useAction()
  const [text, setText] = useState('')
  const [rows, setRows] = useState(1)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('registration.addByHand', { tournamentId, text })
    if (res.ok) {
      setError(null)
      setText('')
      setRows(1)
      onAdded()
    } else {
      setError(res.error)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-2">
      <div className="flex gap-2">
        <textarea
          name="text"
          required
          autoComplete="off"
          enterKeyHint="done"
          aria-label="Add a player, or paste a list"
          placeholder="Add a player, or paste a list"
          rows={rows}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setRows(Math.min(8, Math.max(1, e.target.value.split('\n').length)))
          }}
          onKeyDown={(e) => {
            // Enter adds one name; a pasted list keeps its newlines.
            if (e.key === 'Enter' && !e.shiftKey && !e.currentTarget.value.includes('\n')) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
          className="tap min-w-0 flex-1 resize-none rounded-control border border-line-key bg-paper px-3.5 py-[15px] text-body leading-[26px] text-text placeholder:text-[14px] placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none"
        />
        <button className={`${ROW_BUTTON} shrink-0 self-start`} disabled={pending}>
          {pending ? 'Adding…' : 'Add'}
        </button>
      </div>
      {error ? (
        <p role="alert" className="text-body font-medium text-alert">
          {error}
        </p>
      ) : null}
    </form>
  )
}
