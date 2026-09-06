import Link from 'next/link'
import { homeFor, requireUser } from '@/lib/auth'
import { CourtMark, NetRule, Wordmark } from '@/components/ui'

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
        {/* min-h, not h: at 200% text the band has to be allowed to grow
            rather than clip, and the account button has to survive whatever
            the wordmark does. */}
        <div className="mx-auto flex min-h-14 w-full max-w-3xl items-center gap-3 px-4">
          <Link
            href={homeFor(user) as never}
            className="tap -ml-1 flex min-w-0 items-center overflow-hidden px-1"
          >
            {/* Below ~320px of layout viewport — a phone at 200% text — the
                lockup is 380px of type and there is no size it fits at. The
                court mark is the half that still says whose app this is; the
                account button is the half that has to stay reachable. The
                label rides with the mark, so a screen reader never hears the
                venue's name twice. */}
            <span className="flex items-center min-[320px]:hidden">
              <CourtMark className="size-7 shrink-0 text-white" />
              <span className="sr-only">Madras Pickleball — home</span>
            </span>
            <span className="hidden min-[320px]:block">
              <Wordmark />
            </span>
          </Link>
          <Link
            href="/admin/account"
            aria-label="Your account"
            className="tap ml-auto -mr-1 grid shrink-0 place-items-center px-1"
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
