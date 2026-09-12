import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { Chevron, Confirm, CourtSwatch, Input, Notice, Panel } from '@/components/ui'
import { venueCourts } from '@/server/venue'
import { ROW_BUTTON, SECONDARY_LINK } from '../_ui'
import { addCourtAction, removeCourtAction, renameCourtAction } from './actions'

export const metadata = { title: 'Courts · Madras Pickleball' }
export const dynamic = 'force-dynamic'

/**
 * The venue's courts. Rename one, add one, take one out. A court a tournament
 * is counting on cannot be taken out from here — that is done on the
 * tournament, so nothing loses a court by surprise.
 */
export default async function CourtsPage(props: PageProps<'/admin/courts'>) {
  await requireUser('admin')
  const { note, err } = await props.searchParams
  const list = await venueCourts()

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link
          href="/admin/account"
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
          {String(err)}
        </Notice>
      ) : null}
      {note ? <Notice tone="done">{String(note)}</Notice> : null}

      <Link href="/admin/courts/day" className={SECONDARY_LINK}>
        What is on today, and what is free
      </Link>

      <Panel>
        <ul className="divide-y divide-line">
          {list.map((c) => (
            <li key={c.id} className="flex flex-col gap-2 px-4 py-3">
              <form action={renameCourtAction} className="flex items-center gap-3">
                <input type="hidden" name="courtId" value={c.id} />
                <CourtSwatch colorKey={c.colorKey} size="md" />
                <Input
                  name="name"
                  defaultValue={c.name}
                  aria-label={`Name of ${c.name}`}
                  maxLength={40}
                  required
                  className="h-12 min-w-0 flex-1"
                />
                <button className={`${SECONDARY_LINK} h-12 shrink-0`}>Rename</button>
              </form>
              <div className="flex items-center justify-between gap-3 pl-8">
                <p className="text-meta text-text-3">
                  {c.heldBy.length ? `Used by ${c.heldBy.join(', ')}` : 'Nothing booked on it'}
                </p>
                {c.heldBy.length ? null : (
                  <Confirm
                    className="[&>summary]:border-0 [&>summary]:px-2 [&>summary]:text-link [&[open]]:w-full"
                    label="Take it out"
                    question={`${c.name} stops being offered to tournaments. Anything already played on it stays on the record.`}
                  >
                    <form action={removeCourtAction}>
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

      <form action={addCourtAction} className="flex gap-2">
        <Input
          name="name"
          placeholder={`Add a court — e.g. Court ${list.length + 1}`}
          aria-label="Add a court"
          maxLength={40}
          autoComplete="off"
          required
          className="h-14 min-w-0 flex-1 placeholder:text-[14px]"
        />
        <button className={`${ROW_BUTTON} shrink-0`}>Add</button>
      </form>

      <Link href="/admin" className={SECONDARY_LINK}>
        Back to tournaments
      </Link>
    </div>
  )
}
