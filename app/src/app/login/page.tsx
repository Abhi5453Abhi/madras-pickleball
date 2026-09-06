import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth'
import { Card, CourtMark, NetRule } from '@/components/ui'
import { LoginForm } from './login-form'
import { ensureReady } from '@/server/bootstrap'

export const metadata = { title: 'Sign in · Madras Pickleball' }

/**
 * The front door for the one person who has a key. Players never see it —
 * the sign-up link and the results page are open — so it does not explain
 * itself beyond saying so.
 */
export default async function LoginPage(props: PageProps<'/login'>) {
  await ensureReady()
  if (await currentUser()) redirect('/admin')
  const { next } = await props.searchParams

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
        <p className="mt-1.5 text-body text-text-2">
          Your six-digit PIN. This phone stays signed in for two weeks.
        </p>
      </div>

      <Card className="p-4">
        <LoginForm next={typeof next === 'string' ? next : undefined} />
      </Card>

      <div className="text-center text-meta text-text-2">
        <p>Forgotten it? Whoever set the app up can give you a new one.</p>
        <Link href="/" className="tap mt-1 inline-flex items-center px-2 font-semibold text-link">
          Back to the scores
        </Link>
      </div>
    </main>
  )
}
