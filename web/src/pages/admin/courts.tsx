import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import { useAction, useRpc } from '@/api/use-rpc'
import { Chevron, Confirm, CourtSwatch, Input, Notice, Panel } from '@/components/ui'
import { ROW_BUTTON, SECONDARY_LINK } from '@/components/admin-ui'
import { Loading, LoadError, useTitle } from '@/lib/page'

/**
 * The venue's courts. Rename one, add one, take one out. A court a tournament
 * is counting on cannot be taken out from here — that is done on the
 * tournament, so nothing loses a court by surprise.
 */
export function CourtsPage() {
  useTitle('Courts · Madras Pickleball')
  const courts = useRpc('venue.venueCourts', {})
  const { run } = useAction()
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [adding, setAdding] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})

  const list = courts.state === 'ready' ? courts.data : []

  /** After every one: reload the list and show `note` or `error`. */
  async function settle(res: { ok: true; note: string } | { ok: false; error: string }) {
    // The list first, then the word: a "Renamed." over a list that still
    // shows the old name reads as a lie for the half second it lasts.
    if (res.ok) await courts.reload()
    if (res.ok) {
      setErr(null)
      setNote(res.note)
    } else {
      setNote(null)
      setErr(res.error)
    }
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('venue.addCourt', { name: adding })
    if (res.ok) setAdding('')
    await settle(res)
  }

  async function rename(e: FormEvent<HTMLFormElement>, courtId: string, fallback: string) {
    e.preventDefault()
    const res = await run('venue.renameCourt', { courtId, name: names[courtId] ?? fallback })
    if (res.ok) {
      setNames((n) => {
        const rest = { ...n }
        delete rest[courtId]
        return rest
      })
    }
    await settle(res)
  }

  async function remove(e: FormEvent<HTMLFormElement>, courtId: string) {
    e.preventDefault()
    await settle(await run('venue.removeCourt', { courtId }))
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          to="/admin/account"
          className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link"
        >
          <Chevron className="rotate-90" />
          Your account
        </Link>
        <h1 className="mt-1 text-title text-text">Courts</h1>
        <p className="num mt-1 text-meta text-text-3">
          {list.length} at the venue · every tournament picks from these
        </p>
      </header>

      {err ? (
        <Notice tone="alert" title="Not done">
          {err}
        </Notice>
      ) : null}
      {note ? <Notice tone="done">{note}</Notice> : null}

      {courts.state === 'loading' ? <Loading /> : null}
      {courts.state === 'error' ? <LoadError error={courts.error} retry={() => void courts.reload(false)} /> : null}

      {courts.state === 'ready' ? (
        <Panel>
          <ul className="divide-y divide-line">
            {list.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 px-4 py-3">
                <form onSubmit={(e) => rename(e, c.id, c.name)} className="flex items-center gap-3">
                  <input type="hidden" name="courtId" value={c.id} />
                  <CourtSwatch colorKey={c.colorKey} size="md" />
                  <Input
                    name="name"
                    // Keyed on the name so a rename that lands from a reload
                    // replaces what is in the box, as a defaultValue did.
                    key={c.name}
                    defaultValue={c.name}
                    onChange={(e) => setNames((n) => ({ ...n, [c.id]: e.target.value }))}
                    aria-label={`Name of ${c.name}`}
                    maxLength={40}
                    required
                    className="h-12 min-w-0 flex-1"
                  />
                  <button className={`${SECONDARY_LINK} h-12 shrink-0`}>Rename</button>
                </form>
                <div className="flex items-center justify-between gap-3 pl-8">
                  <p className="text-meta text-text-3">
                    {c.heldBy.length ? `Used by ${c.heldBy.join(', ')}` : 'Free'}
                  </p>
                  {c.heldBy.length ? null : (
                    <Confirm
                      className="[&>summary]:border-0 [&>summary]:px-2 [&>summary]:text-link [&[open]]:w-full"
                      label="Take it out"
                      question={`${c.name} stops being offered to tournaments. Anything already played on it stays on the record.`}
                    >
                      <form onSubmit={(e) => remove(e, c.id)}>
                        <input type="hidden" name="courtId" value={c.id} />
                        <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                          Take {c.name} out
                        </button>
                      </form>
                    </Confirm>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <form onSubmit={add} className="flex gap-2">
        <Input
          name="name"
          placeholder={`Add a court — e.g. Court ${list.length + 1}`}
          aria-label="Add a court"
          maxLength={40}
          autoComplete="off"
          required
          value={adding}
          onChange={(e) => setAdding(e.target.value)}
          className="h-14 min-w-0 flex-1 placeholder:text-[14px]"
        />
        <button className={`${ROW_BUTTON} shrink-0`}>Add</button>
      </form>

      <Link to="/admin" className={SECONDARY_LINK}>
        Back to tournaments
      </Link>
    </div>
  )
}
