import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { rpc, RpcError } from '@/api/rpc'
import { Card, CourtMark, NetRule } from '@/components/ui'
import { Button, Label } from '@/components/ui'
import { useTitle } from '@/lib/page'

/**
 * The front door for the one person who has a key. Players never see it —
 * the sign-up link and the results page are open — so it does not explain
 * itself beyond saying so.
 *
 * The reference's "Demo copy" notice is gone: the Go build has no demo mode.
 */
export function LoginPage() {
  useTitle('Sign in · Madras Pickleball')
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const next = params.get('next') ?? undefined

  // A visitor who is already signed in has no business looking at the door.
  // A bare `rpc` rather than `useRpc`, because useRpc's own 401 handling would
  // send them to /login?next=/login.
  useEffect(() => {
    let gone = false
    rpc('auth.me', {})
      .then(() => {
        if (!gone) navigate('/admin', { replace: true })
      })
      .catch(() => {})
    return () => {
      gone = true
    }
  }, [navigate])

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 p-6">
      <div>
        <div className="flex items-center gap-2.5 text-ink">
          <CourtMark className="size-8" />
          <span className="font-score text-[19px] font-bold tracking-[0.02em] text-text">
            Madras Pickleball
          </span>
        </div>
        <NetRule className="mt-3 mb-4" />
        <h1 className="text-title text-text">Organiser</h1>
        <p className="mt-1.5 text-body text-text-2">Your six-digit PIN.</p>
      </div>

      <Card className="p-4">
        <LoginForm next={next} />
      </Card>

      <div className="text-center text-meta text-text-2">
        <p>Forgotten it? Whoever set the app up can give you a new one.</p>
        <Link to="/" className="tap mt-1 inline-flex items-center px-2 font-semibold text-link">
          Back to the scores
        </Link>
      </div>
    </main>
  )
}

/**
 * One field. Six digits, numeric keyboard, big and centred so it can be typed
 * with a thumb while holding a clipboard. The field is a password field so
 * the digits are dots on a phone that other people are looking at.
 */
function LoginForm({ next }: { next?: string }) {
  const navigate = useNavigate()
  const [pin, setPin] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setPending(true)
    setError(null)
    try {
      const res = await rpc('auth.login', { pin, next: next ?? null })
      if (res.ok) {
        navigate(res.redirect)
        return
      }
      setError(res.error)
    } catch (err) {
      setError(err instanceof RpcError ? err.message : 'Something went wrong. Try again in a moment.')
    } finally {
      setPending(false)
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <div className="flex flex-col gap-2">
        <Label htmlFor="pin">PIN</Label>
        <input
          id="pin"
          name="pin"
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={6}
          minLength={6}
          enterKeyHint="go"
          autoFocus
          required
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'pin-error' : undefined}
          className={[
            'tap-lg w-full rounded-control border bg-paper px-3.5 text-center font-score text-[28px] font-bold tracking-[0.4em] text-text',
            'placeholder:tracking-[0.4em] placeholder:text-text-3 focus:border-link focus:ring-2 focus:ring-link/25 focus:outline-none',
            error ? 'border-alert' : 'border-line-key',
          ].join(' ')}
          placeholder="••••••"
        />
      </div>
      {error ? (
        <p id="pin-error" role="alert" className="text-row text-alert">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={pending}>
        {pending ? 'Checking…' : 'Sign in'}
      </Button>
    </form>
  )
}
