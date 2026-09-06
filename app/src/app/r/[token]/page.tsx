import { CourtMark, NetRule } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { resolveRegistrationToken } from '@/server/registration'
import { ensureReady } from '@/server/bootstrap'
import { RegisterForm } from './form'

/**
 * Player self-registration — SPEC A2. One link, shared in the group chat.
 *
 * Never indexed: it is a capability URL, and a search engine holding it is the
 * same as the link having leaked.
 */
export const dynamic = 'force-dynamic'
export const metadata = {
  title: 'Sign up · Madras Pickleball',
  robots: { index: false, follow: false },
}

export default async function RegisterPage(props: PageProps<'/r/[token]'>) {
  await ensureReady()
  const { token } = await props.params
  const view = await resolveRegistrationToken(token)

  if (!view) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16">
        <h1 className="text-title text-text">This link doesn’t work any more</h1>
        <p className="mt-2 text-body text-text-2">
          Sign-ups may have closed, or the organiser has issued a new link. Ask in the group.
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
          {venueDate(view.tournament.startDate)}
        </p>
        <div aria-hidden className="absolute inset-x-0 bottom-0 h-[3px] bg-accent-line" />
      </header>

      <div className="mx-auto w-full max-w-lg px-4 pt-6">
        <RegisterForm token={token} categories={view.categories} />
        <NetRule className="mt-8" />
        <p className="mt-3 text-meta text-text-3">
          Your name appears on the public page once the organiser puts you in the draw. Your phone
          number never does.
        </p>
      </div>
    </div>
  )
}
