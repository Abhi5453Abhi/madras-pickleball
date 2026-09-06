import Link from 'next/link'
import { requireUser } from '@/lib/auth'
import { CourtMark, NetRule, Wordmark } from '@/components/ui'

export default async function UmpireLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser('umpire', { allowPasswordChange: true })

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 bg-ink text-white">
        <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center gap-3 px-4">
          {/* The same lockup as everywhere else — the role is said once, in
              the page's own heading, not baked into the brand. */}
          <Link
            href="/umpire"
            className="tap -ml-1 flex min-w-0 items-center overflow-hidden px-1"
          >
            <span className="flex items-center min-[320px]:hidden">
              <CourtMark className="size-7 shrink-0 text-white" />
              <span className="sr-only">Madras Pickleball — your matches</span>
            </span>
            <span className="hidden min-[320px]:block">
              <Wordmark />
            </span>
          </Link>
          <Link
            href="/admin/account"
            className="tap ml-auto -mr-1 shrink-0 px-1 text-[15px] font-semibold text-on-ink-2"
          >
            {user.name}
          </Link>
        </div>
        <NetRule />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-5 pb-16">{children}</main>
    </div>
  )
}
