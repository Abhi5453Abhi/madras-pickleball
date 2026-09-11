'use client'

import { useActionState, useState } from 'react'
import { Button, Input } from '@/components/ui'
import { signUp, type SignupState } from './actions'

/**
 * A stable id for this browser, read at the moment of sending rather than on
 * mount, so there is no effect and nothing to hydrate. Best effort by design:
 * a private window or cleared storage simply means the organiser sorts it out,
 * which they were always going to have to do.
 */
function deviceId(): string {
  const KEY = 'mpb.device'
  try {
    const saved = localStorage.getItem(KEY)
    if (saved) return saved
    const made = crypto.randomUUID().replace(/-/g, '')
    localStorage.setItem(KEY, made)
    return made
  } catch {
    return ''
  }
}

export function SignupForm({
  token,
  doubles,
  tournamentName,
}: {
  token: string
  doubles: boolean
  tournamentName: string
}) {
  const [state, action, pending] = useActionState<SignupState, FormData>(signUp, {})
  const [together, setTogether] = useState(false)
  const [teammateName, setTeammateName] = useState('')

  if (state.ok) {
    // Registered together and it actually went through as a fresh pair —
    // not the "already on the list" fallback, which only ever saves a wish.
    const paired = together && !state.alreadyIn && teammateName.trim()
    return (
      <div className="rounded-card border border-line-key bg-paper p-4 shadow-card">
        <p className="text-section text-text">
          {state.alreadyIn ? 'You’re already on the list.' : 'You’re on the list.'}
        </p>
        <p className="mt-1 text-body text-text-2">
          {paired
            ? `You and ${teammateName.trim()} are both in, paired together.`
            : doubles
              ? 'The organiser sorts the pairs before the day. Ask your partner to sign up too and put your name down.'
              : 'The organiser makes the schedule before the day.'}
        </p>
        <ShareLinkRow token={token} tournamentName={tournamentName} />
      </div>
    )
  }

  return (
    <form
      action={(formData) => {
        formData.set('deviceId', deviceId())
        action(formData)
      }}
      className="flex flex-col gap-5"
    >
      <input type="hidden" name="token" value={token} />

      {state.error ? (
        <p role="alert" className="rounded-control bg-alert-soft px-3.5 py-3 text-body font-medium text-alert">
          {state.error}
        </p>
      ) : null}

      <label className="block">
        <span className="text-row text-text">Your name</span>
        <Input name="name" required autoComplete="name" className="mt-2 h-14" placeholder="Deepak Raj" />
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
        />
      </label>

      {doubles ? (
        <div className="flex flex-col gap-2.5">
          <label className="block">
            <span className="text-row text-text">
              {together ? 'Teammate’s name' : 'Playing with someone?'}
            </span>
            <Input
              name="partnerName"
              autoComplete="off"
              required={together}
              value={teammateName}
              onChange={(e) => setTeammateName(e.target.value)}
              className="mt-2 h-14"
              placeholder="Their name"
            />
            <span className="mt-1.5 block text-meta text-text-3">
              {together
                ? 'We’ll add them to the list and pair you together right away.'
                : 'If you leave this blank the organiser pairs you up.'}
            </span>
          </label>
          <label className="flex items-center gap-2.5 text-body text-text-2">
            <input
              type="checkbox"
              name="registerTeammate"
              checked={together}
              onChange={(e) => setTogether(e.target.checked)}
              className="h-5 w-5 shrink-0 rounded border-line-key"
            />
            Sign them up too, so they don’t need to open this link
          </label>
        </div>
      ) : null}

      <Button type="submit" disabled={pending} className="w-full">
        {pending ? 'Sending…' : 'Sign me up'}
      </Button>
    </form>
  )
}

/**
 * Once you're in, the fastest way to fill the rest of the sign-ups is to
 * pass the same link on — to the partner you just named, or the group chat.
 */
function ShareLinkRow({ token, tournamentName }: { token: string; tournamentName: string }) {
  const [copied, setCopied] = useState(false)
  const url = typeof window !== 'undefined' ? `${window.location.origin}/r/${token}` : ''

  async function copy() {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // Clipboard blocked in some in-app browsers — nothing more to do here;
      // the link is right there in the address bar to copy by hand.
    }
  }

  return (
    <div className="mt-4 border-t border-line pt-4">
      <p className="text-meta text-text-3">Know someone else who's playing? Share the sign-up link.</p>
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={copy}
          className="tap inline-flex items-center justify-center rounded-control border border-line-key bg-paper px-4 text-[16px] font-semibold text-text"
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <a
          href={`https://wa.me/?text=${encodeURIComponent(`Sign up for ${tournamentName}: ${url}`)}`}
          target="_blank"
          rel="noreferrer"
          aria-label="Share on WhatsApp"
          className="tap inline-flex items-center justify-center rounded-control border border-line-key bg-paper px-3.5 text-text"
        >
          <svg viewBox="0 0 24 24" className="h-6 w-6 fill-current" aria-hidden="true">
            <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.79 1.22h.01c5.46 0 9.91-4.45 9.91-9.91 0-2.65-1.03-5.14-2.9-7.01A9.82 9.82 0 0 0 12.04 2zm5.71 14.16c-.24.68-1.19 1.25-1.94 1.4-.5.1-1.16.19-3.38-.72-2.84-1.17-4.67-4.05-4.81-4.24-.14-.19-1.16-1.54-1.16-2.95 0-1.4.73-2.09 1-2.38.24-.26.53-.32.71-.32h.51c.16 0 .38-.03.6.46.24.55.79 1.9.86 2.04.07.14.11.31.02.5-.09.19-.14.31-.28.48-.14.16-.29.36-.41.49-.14.14-.28.29-.12.57.16.28.71 1.17 1.53 1.9 1.05.94 1.94 1.24 2.22 1.38.28.14.44.12.6-.07.16-.19.68-.79.86-1.06.18-.28.36-.23.6-.14.24.09 1.55.73 1.81.86.26.14.44.2.5.32.06.11.06.65-.18 1.33z" />
          </svg>
        </a>
      </div>
    </div>
  )
}
