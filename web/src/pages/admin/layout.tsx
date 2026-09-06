import { createContext, use, useCallback, useState } from 'react'
import { Link, Outlet, useLocation, useNavigate } from 'react-router'
import type { Output } from '@/api/rpc'
import { useRpc } from '@/api/use-rpc'
import { CourtMark, NetRule, Wordmark } from '@/components/ui'
import { Loading } from '@/lib/page'
import { useEffect } from 'react'

export type Me = Output<'auth.me'>

const MeContext = createContext<Me | null>(null)
const PatchMeContext = createContext<(patch: Partial<Me>) => void>(() => {})

/** Who is signed in, for the screens under the layout that need more than initials. */
export function useMe(): Me {
  const me = use(MeContext)
  if (!me) throw new Error('useMe outside the admin layout')
  return me
}

/**
 * Lets a screen tell the layout that the signed-in organiser changed — a
 * PIN chosen, a name — without a round trip, so the layout's own guard
 * does not bounce the next navigation on stale data.
 */
export function usePatchMe() {
  return use(PatchMeContext)
}

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

export function AdminLayout() {
  const navigate = useNavigate()
  const location = useLocation()
  const loaded = useRpc('auth.me', {})
  const [patch, setPatch] = useState<Partial<Me>>({})
  const me = loaded.state === 'ready' ? { ...loaded, data: { ...loaded.data, ...patch } } : loaded
  const patchMe = useCallback((p: Partial<Me>) => setPatch((prev) => ({ ...prev, ...p })), [])

  // A temporary PIN closes every screen but this one. The server enforces it
  // too; this is so the organiser lands on the form rather than on a refusal.
  const onAccount = location.pathname === '/admin/account'
  const mustChange = me.state === 'ready' && me.data.mustChangePin
  useEffect(() => {
    if (mustChange && !onAccount) navigate('/admin/account?first=1', { replace: true })
  }, [mustChange, onAccount, navigate])

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Ink is a chrome fill, not body text — this band is where the blue
          becomes a brand instead of five thousand tiny glyph strokes. */}
      <header className="sticky top-0 z-20 bg-ink text-white">
        {/* min-h, not h: at 200% text the band has to be allowed to grow
            rather than clip, and the account button has to survive whatever
            the wordmark does. */}
        <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center gap-3 px-4">
          <Link to="/admin" className="tap -ml-1 flex min-w-0 items-center overflow-hidden px-1">
            {/* Below ~320px of layout viewport — a phone at 200% text — the
                lockup is 380px of type and there is no size it fits at. The
                court mark is the half that still says whose app this is; the
                account button is the half that has to stay reachable. */}
            <span className="flex items-center min-[320px]:hidden">
              <CourtMark className="size-7 shrink-0 text-white" />
              <span className="sr-only">Madras Pickleball — home</span>
            </span>
            <span className="hidden min-[320px]:block">
              <Wordmark />
            </span>
          </Link>
          <Link
            to="/admin/account"
            aria-label="Your account"
            className="tap ml-auto -mr-1 grid shrink-0 place-items-center px-1"
          >
            <span className="grid size-11 place-items-center rounded-full bg-white/15 text-[15px] font-bold">
              {me.state === 'ready' ? initials(me.data.name) : ''}
            </span>
          </Link>
        </div>
        <NetRule />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-5 pb-16">
        {me.state === 'ready' ? (
          mustChange && !onAccount ? (
            <Loading lines={1} />
          ) : (
            <MeContext value={me.data}>
              <PatchMeContext value={patchMe}>
                <Outlet />
              </PatchMeContext>
            </MeContext>
          )
        ) : me.state === 'loading' ? (
          <Loading />
        ) : (
          <p className="text-body text-text-2">{me.error}</p>
        )}
      </main>
    </div>
  )
}
