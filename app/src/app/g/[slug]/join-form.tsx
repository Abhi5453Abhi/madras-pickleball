'use client'

import { useActionState, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { Button, Input, Notice } from '@/components/ui'
import { joinGame, type JoinState } from './actions'

const DEVICE_KEY = 'mpb.device'
const SPOTS_KEY = 'mpb.spots'
const ME_KEY = 'mpb.me'

/**
 * A stable id for this browser, read at the moment of sending rather than on
 * mount, so there is no effect and nothing to hydrate. Best effort by design:
 * a private window or cleared storage means the host sorts it out, which they
 * were always going to have to do.
 */
function deviceId(): string {
  try {
    const saved = localStorage.getItem(DEVICE_KEY)
    if (saved) return saved
    const made = crypto.randomUUID().replace(/-/g, '')
    localStorage.setItem(DEVICE_KEY, made)
    return made
  } catch {
    return ''
  }
}

function readSpots(): Record<string, string> {
  try {
    const raw = localStorage.getItem(SPOTS_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/**
 * What this phone typed last time, so a regular does not re-enter their name and
 * number every Tuesday (s1b, "prefilled for a returning device").
 *
 * Filled in on mount rather than rendered, because localStorage does not exist
 * on the server and a mismatch here is a hydration error on the one page the
 * whole club opens at once. Uncontrolled inputs with a ref, so React is not
 * re-rendering the form on every keystroke.
 */
function readMe(): { name?: string; phone?: string } {
  try {
    const raw = localStorage.getItem(ME_KEY)
    return raw ? (JSON.parse(raw) as { name?: string; phone?: string }) : {}
  } catch {
    return {}
  }
}

function rememberMe(name: string, phone: string) {
  try {
    localStorage.setItem(ME_KEY, JSON.stringify({ name, phone }))
  } catch {
    /* storage is off; they type it again, which is what they do today */
  }
}

function rememberSpot(slug: string, token: string) {
  try {
    const all = readSpots()
    all[slug] = token
    localStorage.setItem(SPOTS_KEY, JSON.stringify(all))
  } catch {
    /* storage is off; the link on screen is still the way in */
  }
}

/**
 * The spot this phone already holds, if it holds one.
 *
 * Read in an effect rather than during render, because localStorage does not
 * exist on the server and a mismatch here is a hydration error on the one page
 * the whole club opens at once.
 */
export function MySpot({ slug }: { slug: string }) {
  const [token, setToken] = useState<string | null>(null)
  useEffect(() => {
    setToken(readSpots()[slug] ?? null)
  }, [slug])
  if (!token) return null
  return (
    <Link
      href={`/s/${token}` as never}
      className="tap-lg flex w-full items-center justify-center rounded-control bg-ink px-5 text-[19px] font-bold text-white"
    >
      Your spot
    </Link>
  )
}

export function JoinForm({ slug, full, closed }: { slug: string; full: boolean; closed: boolean }) {
  const [state, action, pending] = useActionState<JoinState, FormData>(joinGame, {})
  const nameRef = useRef<HTMLInputElement>(null)
  const phoneRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const me = readMe()
    if (nameRef.current && !nameRef.current.value && me.name) nameRef.current.value = me.name
    if (phoneRef.current && !phoneRef.current.value && me.phone) phoneRef.current.value = me.phone
  }, [])

  useEffect(() => {
    if (state.ok && state.token) rememberSpot(slug, state.token)
  }, [state.ok, state.token, slug])

  if (state.ok) {
    return (
      <div className="rounded-card border border-line-key bg-paper p-4 shadow-card">
        {/* One sentence for "just joined" and for "was already on the list".
            Telling them apart would answer, for any number typed in, whether
            that person is playing tonight. */}
        <p className="text-section text-text">
          {state.waiting ? 'You’re on the waitlist.' : 'You’re in.'}
        </p>
        <p className="mt-1 text-body text-text-2">
          {state.waiting
            ? 'If somebody drops out you move up automatically and your spot page will say so.'
            : 'Nothing to pay now — the host sorts the money out after you’ve played.'}
        </p>
        {state.token ? (
          <div className="mt-4">
            <Link
              href={`/s/${state.token}` as never}
              className="tap-lg flex w-full items-center justify-center rounded-control bg-ink px-5 text-[19px] font-bold text-white"
            >
              Your spot
            </Link>
            <p className="mt-2 text-meta text-text-3">
              Keep this page — it is how you confirm, or let the spot go if you can’t make it.
            </p>
          </div>
        ) : (
          <p className="mt-4 text-meta text-text-3">
            If you joined from another phone, open the link you got there to change anything.
          </p>
        )}
      </div>
    )
  }

  return (
    <form
      action={(formData) => {
        formData.set('deviceId', deviceId())
        rememberMe(String(formData.get('name') ?? ''), String(formData.get('phone') ?? ''))
        action(formData)
      }}
      className="flex flex-col gap-5"
    >
      <input type="hidden" name="slug" value={slug} />

      {state.error ? <Notice tone="alert">{state.error}</Notice> : null}

      <label className="block">
        <span className="text-row text-text">Your name</span>
        <Input ref={nameRef} name="name" required autoComplete="name" className="mt-2 h-14" placeholder="Deepak Raj" />
      </label>

      <label className="block">
        <span className="text-row text-text">Phone</span>
        <Input
          ref={phoneRef}
          name="phone"
          type="tel"
          inputMode="tel"
          required
          autoComplete="tel"
          className="mt-2 h-14"
          placeholder="98400 12345"
        />
        <span className="mt-1.5 block text-meta text-text-3">
          Your name goes on this page as a first name and an initial. Your phone number never does.
        </span>
      </label>

      <label className="tap flex items-center gap-2.5 text-body text-text-2">
        <input type="checkbox" name="hideFromPublic" className="h-5 w-5 shrink-0 rounded border-line-key" />
        Keep my name off the list
      </label>

      <Button type="submit" disabled={pending || closed} className="w-full">
        {pending ? 'Adding…' : closed ? 'Sign-ups closed' : full ? 'Join the waitlist' : 'Count me in'}
      </Button>
    </form>
  )
}
