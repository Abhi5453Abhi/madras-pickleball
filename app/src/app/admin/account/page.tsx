import Link from 'next/link'
import { homeFor, requireUser } from '@/lib/auth'
import { Card, Notice } from '@/components/ui'
import { Confirm, SECONDARY_LINK } from '../_ui'
import { logout } from '../../login/actions'
import { PasswordForm } from './password-form'

/** No raw enum ever reaches a screen (SPEC D4). */
const ROLE_WORDS: Record<string, string> = {
  super_admin: 'Venue owner — you can add organisers and reset their passwords',
  admin: 'Organiser — you can run tournaments end to end',
  umpire: 'Umpire — you can score the matches you are put on',
}

export default async function AccountPage(props: PageProps<'/admin/account'>) {
  const user = await requireUser('umpire', { allowPasswordChange: true })
  const { first } = await props.searchParams
  const forced = !!first || user.mustChangePassword

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Your account</p>
        <h1 className="mt-1 text-title text-text">{user.name}</h1>
        <p className="mt-1.5 text-meta text-text-3">Signed in as {user.username}</p>
        <p className="mt-0.5 text-meta text-text-2">{ROLE_WORDS[user.role] ?? user.role}</p>
      </header>

      {forced ? (
        <Notice tone="info">
          Pick your own password before you carry on — the one you were given is temporary, and it
          was typed on somebody else&rsquo;s phone to get here.
        </Notice>
      ) : null}

      <Card className="p-4">
        <h2 className="text-section text-text">Change your password</h2>
        <p className="mt-1 mb-4 text-body text-text-2">
          Every other device you are signed in on is signed out. This one stays signed in.
        </p>
        <PasswordForm />
      </Card>

      {forced ? null : (
        <>
          <Link href={homeFor(user) as never} className={SECONDARY_LINK}>
            Back to {user.role === 'umpire' ? 'scoring' : 'your tournaments'}
          </Link>

          <Confirm
            label="Sign out"
            question="You will need your username and password to get back in. If a tournament is running, the court board and the QR cards keep working without you."
          >
            <form action={logout}>
              <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                Sign out of this phone
              </button>
            </form>
          </Confirm>
        </>
      )}
    </div>
  )
}
