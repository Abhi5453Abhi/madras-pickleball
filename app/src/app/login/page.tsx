import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth'
import { Card, CourtMark, NetRule } from '@/components/ui'
import { LoginForm } from './login-form'
import { ensureReady } from '@/server/bootstrap'

export const metadata = { title: 'Sign in · Madras Pickleball' }

/**
 * The only screen in the product that a person reaches without knowing what
 * this is. It carries the brand band because it is the front door — and it says
 * plainly that scorers do not belong here, because the most common way to end
 * up on this page is scanning a court card that has expired.
 */
export default async function LoginPage() {
  await ensureReady()
  if (await currentUser()) redirect('/admin')

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
        <h1 className="text-title text-text">Organiser sign in</h1>
        <p className="mt-1.5 text-body text-text-2">
          Scorers don&rsquo;t need an account — scan the QR taped to the net post and the score goes
          in from there.
        </p>
      </div>

      <Card className="p-4">
        <LoginForm />
      </Card>

      <div className="text-center text-meta text-text-2">
        <p>Forgotten it? The venue owner can reset it for you.</p>
        <Link href="/" className="tap mt-1 inline-flex items-center px-2 font-semibold text-link">
          Back to the scores
        </Link>
      </div>
    </main>
  )
}
