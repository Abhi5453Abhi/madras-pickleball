import Link from 'next/link'
import { homeFor, requireUser } from '@/lib/auth'
import { CourtMark, NetRule } from '@/components/ui'

function initials(name: string) {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
}

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser('umpire', { allowPasswordChange: true })

  return (
    <div className="flex min-h-dvh flex-col">
      {/* Ink is a chrome fill, not body text — this band is where the blue
          becomes a brand instead of five thousand tiny glyph strokes. */}
      <header className="sticky top-0 z-20 bg-ink text-white">
        <div className="mx-auto flex h-14 w-full max-w-3xl items-center gap-3 px-4">
          <Link href={homeFor(user) as never} className="tap -ml-1 flex items-center gap-2.5 px-1">
            <CourtMark className="size-7 text-white" />
            <span className="font-score text-[19px] font-bold tracking-[0.02em]">
              Madras Pickleball
            </span>
          </Link>
          <Link
            href="/admin/account"
            aria-label="Your account"
            className="tap ml-auto -mr-1 grid place-items-center px-1"
          >
            <span className="grid size-11 place-items-center rounded-full bg-white/15 text-[15px] font-bold">
              {initials(user.name)}
            </span>
          </Link>
        </div>
        <NetRule />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 pt-5 pb-16">{children}</main>
    </div>
  )
}
