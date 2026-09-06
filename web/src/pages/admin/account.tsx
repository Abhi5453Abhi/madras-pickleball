import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { rpc } from '@/api/rpc'
import { useAction, useRpc } from '@/api/use-rpc'
import { Button, Card, Confirm, Input, Label, Notice, Panel } from '@/components/ui'
import { SECONDARY_LINK, ROW_BUTTON } from '@/components/admin-ui'
import { venueDate } from '@/lib/time'
import { Loading, useTitle } from '@/lib/page'
import { useMe, usePatchMe } from './layout'

export function AccountPage() {
  useTitle('Your PIN · Madras Pickleball')
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const user = useMe()
  const first = params.get('first')
  const forced = !!first || user.mustChangePin
  const owner = user.role === 'owner'
  const [note, setNote] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  async function signOut(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    await rpc('auth.logout', {})
    navigate('/login')
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Your account</p>
        <h1 className="mt-1 text-title text-text">{user.name}</h1>
      </header>

      {err ? (
        <Notice tone="alert" title="Not done">
          {err}
        </Notice>
      ) : null}
      {note ? <Notice tone="done">{note}</Notice> : null}

      {forced ? (
        <>
          <Notice tone="info" title="Temporary PIN">
            Pick your own before you carry on — the one you were given is written down somewhere.
          </Notice>
          <Card className="p-4">
            <h2 className="mb-4 text-section text-text">Choose your PIN</h2>
            <PinForm forced={forced} />
          </Card>
        </>
      ) : null}

      {/* The list is a whole component so the RPC is not fired at all for an
          organiser who is not the owner — it would 403, and the reference
          never asked. */}
      {owner && !forced ? (
        <Organisers meId={user.id} onDone={setNote} onFailed={setErr} />
      ) : null}

      {forced ? null : (
        <>
          <Link to="/admin/courts" className={SECONDARY_LINK}>
            The venue&rsquo;s courts
          </Link>
          <Card className="p-4">
            <h2 className="text-section text-text">Change your PIN</h2>
            <p className="mt-1 mb-4 text-body text-text-2">
              Any other phone signed in with the old one is signed out.
            </p>
            <PinForm forced={forced} />
          </Card>

          <Link to="/admin" className={SECONDARY_LINK}>
            Back to tournaments
          </Link>

          {/* Set apart from the link above it: two identical bordered rows,
              one of which signs you out mid-tournament, is a row you tap by
              accident. */}
          <div aria-hidden className="mt-2 h-px bg-line" />

          <Confirm
            label="Sign out"
            question="You will need your PIN to get back in. Nothing stops while you are out — the public page keeps showing the scores you have entered."
          >
            <form onSubmit={signOut}>
              <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                Sign out of this phone
              </button>
            </form>
          </Confirm>
        </>
      )}
    </div>
  )
}

function Organisers({
  meId,
  onDone,
  onFailed,
}: {
  meId: string
  onDone: (note: string | null) => void
  onFailed: (error: string | null) => void
}) {
  const organisers = useRpc('organisers.listOrganisers', {})
  const { run } = useAction()

  async function removeOrganiser(e: FormEvent<HTMLFormElement>, userId: string) {
    e.preventDefault()
    const res = await run('organisers.removeOrganiser', { userId })
    if (res.ok) {
      // The list first, then the word, so "Removed" never sits over a
      // list that still shows the person.
      await organisers.reload()
      onFailed(null)
      onDone(res.note)
    } else {
      onDone(null)
      onFailed(res.error)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <h2 className="font-score text-eyebrow text-text-2 uppercase">
        Organisers
        <small className="num ml-1 font-normal normal-case text-text-3">
          {organisers.state === 'ready' ? organisers.data.length : ''}
        </small>
      </h2>
      {organisers.state === 'ready' ? (
        <Panel>
          <ul className="divide-y divide-line">
            {organisers.data.map((o) => (
              <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                <span className="min-w-0 flex-1">
                  <span className="block text-row text-text">{o.name}</span>
                  <span className="block text-meta text-text-3">
                    {o.id === meId
                      ? 'you · venue owner'
                      : o.lastLoginAt
                        ? `last signed in ${venueDate(o.lastLoginAt)}`
                        : 'has not signed in yet'}
                  </span>
                </span>
                {o.id === meId ? null : (
                  <Confirm
                    className="ml-auto shrink-0 [&>summary]:border-0 [&>summary]:px-2 [&>summary]:text-link [&[open]]:w-full"
                    label="Remove"
                    question={`${o.name}'s PIN stops working straight away. Everything they entered stays.`}
                  >
                    <form onSubmit={(e) => removeOrganiser(e, o.id)}>
                      <input type="hidden" name="userId" value={o.id} />
                      <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                        Remove {o.name}
                      </button>
                    </form>
                  </Confirm>
                )}
              </li>
            ))}
          </ul>
        </Panel>
      ) : organisers.state === 'loading' ? (
        <Loading lines={1} />
      ) : (
        <Notice tone="alert">{organisers.error}</Notice>
      )}
      <AddOrganiserForm onAdded={() => organisers.reload()} />
      <p className="text-meta text-text-3">
        They get a PIN of their own, shown here once. Every organiser can do everything except this
        list.
      </p>
    </section>
  )
}

const FIELD =
  'tap w-full rounded-control border border-line-key bg-paper px-3.5 text-center font-score text-[24px] font-bold tracking-[0.35em] text-text placeholder:tracking-[0.35em] placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none'

function PinField({
  id,
  name,
  label,
  autoComplete,
  value,
  onChange,
}: {
  id: string
  name: string
  label: string
  autoComplete: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <input
        id={id}
        name={name}
        type="password"
        inputMode="numeric"
        pattern="[0-9]*"
        maxLength={6}
        minLength={6}
        autoComplete={autoComplete}
        placeholder="••••••"
        className={FIELD}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  )
}

function PinForm({ forced }: { forced?: boolean }) {
  const { run, pending } = useAction()
  const patchMe = usePatchMe()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    // The layout must learn the PIN is no longer temporary before the
    // redirect lands, or its guard bounces the dashboard straight back here.
    const res = await run('organisers.changePin', { current, next, confirm }, () => patchMe({ mustChangePin: false }))
    if (!res.ok) setError(res.error)
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {error ? <Notice>{error}</Notice> : null}
      <PinField id="current" name="current" label="Current PIN" autoComplete="current-password" value={current} onChange={setCurrent} />
      <PinField id="next" name="next" label="New PIN" autoComplete="new-password" value={next} onChange={setNext} />
      <PinField id="confirm" name="confirm" label="Type it again" autoComplete="new-password" value={confirm} onChange={setConfirm} />
      <p className="text-meta text-text-2">Six digits. Not your birthday, not 123456.</p>
      <Button type="submit" disabled={pending}>
        {pending ? 'Saving…' : forced ? 'Save my PIN' : 'Change PIN'}
      </Button>
    </form>
  )
}

/**
 * One line, one button. The temporary PIN is shown here, once, and only
 * here — it never travels in a URL, which would put it in browser history and
 * in the host's logs.
 */
function AddOrganiserForm({ onAdded }: { onAdded: () => Promise<unknown> }) {
  const { run, pending } = useAction()
  const [name, setName] = useState('')
  const [made, setMade] = useState<{ name: string; pin: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const res = await run('organisers.addOrganiser', { name })
    if (res.ok) {
      // The list first, then the PIN: the new name should be on the list
      // by the time the owner reads the PIN out to them.
      await onAdded()
      setError(null)
      setMade({ name: res.name, pin: res.pin })
      setName('')
    } else {
      setError(res.error)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {made ? (
        <Notice tone="done" title={`${made.name} is in`}>
          Their PIN is <b className="num text-text">{made.pin}</b>. Tell them now — it is not shown
          again — and they choose their own the first time they sign in.
        </Notice>
      ) : null}
      <form onSubmit={onSubmit} className="flex gap-2">
        <Input
          name="name"
          placeholder="Add an organiser — their name"
          aria-label="Add an organiser"
          autoComplete="off"
          maxLength={60}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="h-14 min-w-0 flex-1 placeholder:text-[14px]"
        />
        <button className={`${ROW_BUTTON} shrink-0`} disabled={pending}>
          {pending ? 'Adding…' : 'Add'}
        </button>
      </form>
      {error ? (
        <p role="alert" className="text-body font-medium text-alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
