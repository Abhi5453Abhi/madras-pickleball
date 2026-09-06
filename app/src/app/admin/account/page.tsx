import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { Card, Confirm, Notice } from '@/components/ui'
import { SECONDARY_LINK } from '../_ui'
import { logout } from '../../login/actions'
import { PinForm } from './pin-form'

export const metadata = { title: 'Your PIN · Madras Pickleball' }

export default async function AccountPage(props: PageProps<'/admin/account'>) {
  const user = await requireUser('admin', { allowPasswordChange: true })
  const { first } = await props.searchParams
  const forced = !!first || user.mustChangePassword

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Your account</p>
        <h1 className="mt-1 text-title text-text">{user.name}</h1>
      </header>

      {forced ? (
        <Notice tone="info" title="Temporary PIN" detail="Nothing else opens until this is done.">
          Pick your own before you carry on — the one you were given is written down somewhere.
        </Notice>
      ) : null}

      <Card className="p-4">
        <h2 className="text-section text-text">{forced ? 'Choose your PIN' : 'Change your PIN'}</h2>
        <p className="mt-1 mb-4 text-body text-text-2">
          Every other phone you are signed in on is signed out. This one stays signed in.
        </p>
        <PinForm forced={forced} />
      </Card>

      {forced ? null : (
        <>
          <Link href="/admin" className={SECONDARY_LINK}>
            Back to tournaments
          </Link>

          {/* Set apart from the link above it: two identical bordered rows,
              one of which signs you out mid-tournament, is a row you tap by
              accident. */}
          <div aria-hidden className="mt-2 h-px bg-line" />

          <Confirm
            label="Sign out"
            question="You will need your PIN to get back in. Nothing stops while you are out — the public page keeps showing the scores you have entered."
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
