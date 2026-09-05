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
            <Button disabled>Start a tournament</Button>
            <Button variant="secondary" disabled>
              Try it with sample data
            </Button>
          </div>
          <p className="text-xs text-muted">
            Being built now — roster, categories and pairing land next.
          </p>
        </Card>
        <p className="px-1 text-xs text-muted">Signed in as {user.username}</p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <h1 className="text-xl font-bold text-ink">Tournaments</h1>
      {list.map((t) => (
          <Card key={t.id} className="flex items-center gap-3">
            <StatusDot state={t.status === 'live' ? 'live' : t.status === 'completed' ? 'done' : 'waiting'} />
            <div className="min-w-0">
              <p className="truncate font-semibold text-ink">{t.name}</p>
              <p className="text-sm text-muted">
                {venueDate(t.startDate)} · {t.status}
              </p>
            </div>
          </Card>
      ))}
    </div>
  )
}
