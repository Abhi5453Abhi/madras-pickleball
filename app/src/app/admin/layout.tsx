import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { logout } from '../login/actions'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser('umpire')

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 border-b border-line bg-paper/95 backdrop-blur">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-3 px-4 py-3">
          <Link href="/admin" className="flex min-w-0 flex-col leading-tight">
            <span className="text-[11px] font-semibold tracking-widest text-accent uppercase">
              Madras Pickleball
            </span>
            <span className="truncate text-sm font-bold text-ink">Organiser</span>
          </Link>
          <div className="ml-auto flex items-center gap-3">
            <Link href="/admin/account" className="truncate text-sm font-medium text-muted">
              {user.name}
            </Link>
            <form action={logout}>
              <button className="text-sm font-semibold text-link">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 p-4">{children}</main>
    </div>
  )
}
