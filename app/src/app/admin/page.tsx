import Link from 'next/link'
import { desc, isNull } from 'drizzle-orm'
import { db } from '@/db'
import { tournaments } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { Card, Button, StatusDot } from '@/components/ui'
import { venueDate } from '@/lib/time'

export default async function AdminHome() {
  const user = await requireUser('umpire')
  const list = await db
    .select()
    .from(tournaments)
    .where(isNull(tournaments.deletedAt))
    .orderBy(desc(tournaments.startDate))
    .limit(20)

  if (list.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <Card className="flex flex-col items-start gap-3">
          <h1 className="text-xl font-bold text-ink">Nothing on yet</h1>
          <p className="text-sm text-muted">
            Start a tournament and you&apos;ll get a share link, a court board and a QR card for
            each court.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/admin/quick">
              <Button>Start a tournament</Button>
            </Link>
            <Link href="/admin/sample">
              <Button variant="secondary">Try it with sample data</Button>
            </Link>
          </div>
        </Card>
        <p className="px-1 text-xs text-muted">Signed in as {user.username}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-ink">Tournaments</h1>
        <Link href="/admin/quick">
          <Button className="tap px-4 text-sm">New</Button>
        </Link>
      </div>
      {list.map((t) => (
        <Link key={t.id} href={`/admin/t/${t.slug}`}>
          <Card className="flex items-center gap-3">
            <StatusDot state={t.status === 'live' ? 'live' : t.status === 'completed' ? 'done' : 'waiting'} />
            <div className="min-w-0">
              <p className="truncate font-semibold text-ink">{t.name}</p>
              <p className="text-sm text-muted">
                {venueDate(t.startDate)} · {t.status}
              </p>
            </div>
          </Card>
        </Link>
      ))}
    </div>
  )
}
