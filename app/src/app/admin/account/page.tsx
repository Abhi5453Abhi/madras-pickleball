import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { Card, Confirm, Notice, Panel } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { listOrganisers } from '@/server/organisers'
import { SECONDARY_LINK } from '../_ui'
import { logout } from '../../login/actions'
import { PinForm } from './pin-form'
import { removeOrganiserAction } from './actions'
import { AddOrganiserForm } from './add-organiser'

export const metadata = { title: 'Your PIN · Madras Pickleball' }

export default async function AccountPage(props: PageProps<'/admin/account'>) {
  const user = await requireUser('admin', { allowPasswordChange: true })
  const { first, note, err } = await props.searchParams
  const forced = !!first || user.mustChangePassword
  const owner = user.role === 'super_admin'
  const organisers = owner && !forced ? await listOrganisers() : []

  return (
    <div className="flex flex-col gap-5">
      <header>
        <p className="font-score text-eyebrow text-accent uppercase">Your account</p>
        <h1 className="mt-1 text-title text-text">{user.name}</h1>
      </header>

      {err ? (
        <Notice tone="alert" title="Not done">
          {String(err)}
        </Notice>
      ) : null}
      {note ? <Notice tone="done">{String(note)}</Notice> : null}

      {forced ? (
        <>
          <Notice tone="info" title="Temporary PIN" detail="Nothing else opens until this is done.">
            Pick your own before you carry on — the one you were given is written down somewhere.
          </Notice>
          <Card className="p-4">
            <h2 className="text-section text-text">
              {forced ? 'Choose your PIN' : 'Change your PIN'}
            </h2>
            <p className="mt-1 mb-4 text-body text-text-2">
              Every other phone you are signed in on is signed out. This one stays signed in.
            </p>
            <PinForm forced={forced} />
          </Card>
        </>
      ) : null}

      {owner && !forced ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">
            Organisers
            <small className="num ml-1 font-normal normal-case text-text-3">
              {organisers.length}
            </small>
          </h2>
          <Panel>
            <ul className="divide-y divide-line">
              {organisers.map((o) => (
                <li key={o.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-row text-text">{o.name}</span>
                    <span className="block text-meta text-text-3">
                      {o.id === user.id
                        ? 'you · venue owner'
                        : o.lastLoginAt
                          ? `last signed in ${venueDate(o.lastLoginAt)}`
                          : 'has not signed in yet'}
                    </span>
                  </span>
                  {o.id === user.id ? null : (
                    <Confirm
                      className="ml-auto shrink-0 [&>summary]:border-0 [&>summary]:px-2 [&>summary]:text-link [&[open]]:w-full"
                      label="Remove"
                      question={`${o.name}'s PIN stops working straight away. Everything they entered stays.`}
                    >
                      <form action={removeOrganiserAction}>
                        <input type="hidden" name="userId" value={o.id} />
                        <button className="tap-lg w-full rounded-control bg-ink px-4 text-[18px] font-bold text-white">
                          Remove {o.name}
                        </button>
                      </form>
                    </Confirm>
                  )}
                </li>
              ))}
            </ul>
          </Panel>
          <AddOrganiserForm />
          <p className="text-meta text-text-3">
            They get a PIN of their own, shown here once. Every organiser can do everything except
            this list.
          </p>
        </section>
      ) : null}

      {forced ? null : (
        <>
          <Link href="/admin/courts" className={SECONDARY_LINK}>
            The venue&rsquo;s courts
          </Link>
          <Card className="p-4">
            <h2 className="text-section text-text">
              {forced ? 'Choose your PIN' : 'Change your PIN'}
            </h2>
            <p className="mt-1 mb-4 text-body text-text-2">
              Every other phone you are signed in on is signed out. This one stays signed in.
            </p>
            <PinForm forced={forced} />
          </Card>

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
