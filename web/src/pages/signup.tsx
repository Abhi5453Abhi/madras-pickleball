import { useState, type FormEvent } from 'react'
import { useParams } from 'react-router'
import { rpc, RpcError } from '@/api/rpc'
import { useRpc } from '@/api/use-rpc'
import { Button, CourtMark, Input, NetRule } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { PublicLoading, useTitle } from '@/lib/page'

/**
 * The sign-up form — SPEC v4. Opens from the link in the group. Name, phone if
 * they want, and who they would like to play with. No password, no cookie.
 *
 * Never indexed: it is a capability URL, and a search engine holding it is the
 * same as the link having leaked.
 */
export function SignupPage() {
  useTitle('Sign up · Madras Pickleball')
  const { token = '' } = useParams()
  const loaded = useRpc('registration.resolveRegistrationToken', { token })

  if (loaded.state === 'loading') return <PublicLoading />
  if (loaded.state !== 'ready') {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <h1 className="text-title text-text">This link doesn’t work any more</h1>
        <p className="mt-2 text-body text-text-2">
          Sign-ups may have closed, or the organiser has sent a new link. Ask in the group.
        </p>
      </div>
    )
  }

  const view = loaded.data
  return (
    <div className="min-h-dvh bg-ground pb-16">
      <header className="relative overflow-hidden bg-ink px-4 pt-6 pb-5 text-white">
        <CourtMark className="pointer-events-none absolute -right-8 -bottom-10 w-56 text-white opacity-[0.07]" />
        <p className="font-score text-eyebrow text-accent-line uppercase">Madras Pickleball</p>
        <h1 className="mt-1 text-hero">{view.tournament.name}</h1>
        <p className="num mt-1.5 text-body text-on-ink-2">
          {venueDate(view.tournament.day)} · sign up
        </p>
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-accent-line" />
      </header>

      <main className="mx-auto w-full max-w-lg px-4 pt-6">
        {view.closed ? (
          <div className="rounded-card border border-line-key bg-paper p-4 shadow-card">
            <p className="text-section text-text">Sign-ups have closed — ask the organiser.</p>
          </div>
        ) : (
          <>
            <SignupForm token={token} doubles={view.discipline === 'doubles'} />
            <NetRule className="mt-8" />
            <p className="mt-3 text-meta text-text-3">
              Your name goes on the public page. Your phone number never does.
            </p>
          </>
        )}
      </main>
    </div>
  )
}

/**
 * A stable id for this browser, read at the moment of sending rather than on
 * mount, so there is no effect and nothing to hydrate. Best effort by design:
 * a private window or cleared storage simply means the organiser sorts it out,
 * which they were always going to have to do. Deliberately not a cookie — the
 * page stays cookie-free.
 */
function deviceId(): string | null {
  const KEY = 'mpb.device'
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) return saved
    const made = crypto.randomUUID().replace(/-/g, '')
    localStorage.setItem(KEY, made)
    return made
  } catch {
    return null
  }
}

function SignupForm({ token, doubles }: { token: string; doubles: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ alreadyIn: boolean } | null>(null)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [partnerName, setPartnerName] = useState('')

  if (done) {
    return (
      <div className="rounded-card border border-line-key bg-paper p-4 shadow-card">
        <p className="text-section text-text">
          {done.alreadyIn ? 'You’re already on the list.' : 'You’re on the list.'}
        </p>
        <p className="mt-1 text-body text-text-2">
          {doubles
            ? 'The organiser sorts the pairs before the day. Ask your partner to sign up too and put your name down.'
            : 'The organiser makes the schedule before the day.'}
        </p>
      </div>
    )
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending(true)
    try {
      const res = await rpc('registration.submitRegistration', {
        token,
        name: name.slice(0, 200),
        phone: phone.slice(0, 40) || null,
        partnerName: doubles ? partnerName.slice(0, 200) || null : null,
        deviceId: deviceId(),
      })
      if (res.ok) setDone({ alreadyIn: res.alreadyIn })
      else setError(res.error)
    } catch (err) {
      setError(
        err instanceof RpcError && err.status === 404
          ? 'This link doesn’t work any more. Ask the organiser.'
          : err instanceof Error
            ? err.message
            : 'Something went wrong. Try again in a moment.',
      )
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-5">
      {error ? (
        <p role="alert" className="rounded-control bg-alert-soft px-3.5 py-3 text-body font-medium text-alert">
          {error}
        </p>
      ) : null}

      <label className="block">
        <span className="text-row text-text">Your name</span>
        <Input
          name="name"
          required
          autoComplete="name"
          className="mt-2 h-14"
          placeholder="Deepak Raj"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <label className="block">
        <span className="text-row text-text">
          Phone <span className="font-normal text-text-3">· optional</span>
        </span>
        <Input
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          className="mt-2 h-14"
          placeholder="98400 12345"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
      </label>

      {doubles ? (
        <label className="block">
          <span className="text-row text-text">Playing with someone?</span>
          <Input
            name="partnerName"
            autoComplete="off"
            className="mt-2 h-14"
            placeholder="Their name"
            value={partnerName}
            onChange={(e) => setPartnerName(e.target.value)}
          />
          <span className="mt-1.5 block text-meta text-text-3">
            If you leave this blank the organiser pairs you up.
          </span>
        </label>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Sending…' : 'Sign me up'}
      </Button>
    </form>
  )
}
