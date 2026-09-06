import { CourtMark, NetRule } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { resolveRegistrationToken } from '@/server/registration'
import { ensureReady } from '@/server/bootstrap'
import { SignupForm } from './form'

/**
 * The sign-up form — SPEC v4. Opens from the link in the group. Name, phone if
 * they want, and who they would like to play with. No password, no cookie.
 *
 * Never indexed: it is a capability URL, and a search engine holding it is the
 * same as the link having leaked.
 */
export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Sign up · Madras Pickleball',
  robots: { index: false, follow: false },
}

export default async function SignupPage(props: PageProps<'/r/[token]'>) {
  await ensureReady()
  const { token } = await props.params
  const view = await resolveRegistrationToken(token)

  if (!view) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <h1 className="text-title text-text">This link doesn’t work any more</h1>
        <p className="mt-2 text-body text-text-2">
          Sign-ups may have closed, or the organiser has sent a new link. Ask in the group.
        </p>
      </div>
    )
  }

  return (
    <div className="min-h-dvh bg-ground pb-16">
      <header className="relative overflow-hidden bg-ink px-4 pt-6 pb-5 text-white">
        <CourtMark className="pointer-events-none absolute -right-8 -bottom-10 w-56 text-white opacity-[0.07]" />
        <p className="font-score text-eyebrow text-accent-line uppercase">Madras Pickleball</p>
        <h1 className="mt-1 text-hero">{view.tournament.name}</h1>
        <p className="num mt-1.5 text-body text-on-ink-2">
          {venueDate(view.tournament.startDate)} · sign up
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
