import { requireUser } from '@/lib/auth'
import { Card, Notice } from '@/components/ui'
import { PasswordForm } from './password-form'

export default async function AccountPage(props: PageProps<'/admin/account'>) {
  const user = await requireUser('umpire', { allowPasswordChange: true })
  const { first } = await props.searchParams

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-xl font-bold text-ink">Your account</h1>
        <p className="text-sm text-muted">
          {user.name} · {user.username} · {user.role.replace('_', ' ')}
        </p>
      </div>

      {first || user.mustChangePassword ? (
        <Notice tone="info">
          Pick your own password before you carry on — the one you were given is temporary.
        </Notice>
      ) : null}

      <Card>
        <PasswordForm />
      </Card>
    </div>
  )
}
