import Link from 'next/link'
import { desc, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { tournaments } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { Button, Card, CourtMark, StatusPill, statusWords } from '@/components/ui'
import { venueDate } from '@/lib/time'
import { ensureReady } from '@/server/bootstrap'

export default async function AdminHome() {
  await ensureReady()
  await requireUser('umpire')
  const list = await db
    .select()
    .from(tournaments)
    .where(isNull(tournaments.deletedAt))
    .orderBy(desc(tournaments.startDate))
    .limit(20)

  if (list.length === 0) {
    return (
      <div className="relative overflow-hidden rounded-card border border-line-strong bg-paper p-6 shadow-card">
        <CourtMark className="pointer-events-none absolute -right-6 -bottom-8 size-40 text-ink opacity-[0.05]" />
        <h1 className="text-title text-text">Nothing on yet</h1>
        <p className="mt-2 max-w-sm text-body text-text-2">
          Start one and you get a share link, a court board, and a QR card for every court.
        </p>
        <Link href="/admin/quick" className="mt-5 inline-block">
          <Button>Start a tournament</Button>
        </Link>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-title text-text">Tournaments</h1>
        <Link href="/admin/quick">
          <Button className="tap px-4 text-[16px]">New</Button>
        </Link>
      </div>

      <ul className="flex flex-col gap-3">
        {list.map((t) => {
          const s = statusWords(t.status)
          return (
            <li key={t.id}>
              <Link href={`/admin/t/${t.slug}`}>
                <Card className="flex items-center gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-section text-text">{t.name}</p>
                    <p className="num mt-0.5 text-meta text-text-3">
                      {venueDate(t.startDate)}
                    </p>
                  </div>
                  <StatusPill state={s.state}>{s.label}</StatusPill>
                </Card>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
