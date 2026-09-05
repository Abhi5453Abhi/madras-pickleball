import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/auth'
import { Card } from '@/components/ui'
import { LoginForm } from './login-form'

export const metadata = { title: 'Sign in · Madras Pickleball' }

export default async function LoginPage() {
  if (await currentUser()) redirect('/admin')

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-5 p-6">
      <div>
        <p className="text-xs font-semibold tracking-widest text-accent uppercase">
          Madras Pickleball
        </p>
        <h1 className="mt-1 text-2xl font-bold text-ink">Organiser sign in</h1>
        <p className="mt-1 text-sm text-muted">
          Scorers don&apos;t need an account — scan the QR on the net post.
        </p>
      </div>

      <Card>
        <LoginForm />
      </Card>

      <p className="text-center text-sm text-muted">
        Forgotten it? Ask the venue owner to reset it for you.{' '}
        <Link href="/" className="font-medium text-link">
          Back to scores
        </Link>
      </p>
    </main>
  )
}
