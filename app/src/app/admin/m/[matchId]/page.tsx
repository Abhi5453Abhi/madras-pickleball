import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { courts, tournaments } from '@/db/schema'
import { requireUser } from '@/lib/auth'
import { getMatchForScoring } from '@/server/scoring'
import { AdminEntry } from './entry'

export default async function AdminMatchPage(props: PageProps<'/admin/m/[matchId]'>) {
  await requireUser('umpire')
  const { matchId } = await props.params

  const loaded = await getMatchForScoring(matchId)
  if (!loaded || !loaded.match.teamAId || !loaded.match.teamBId) notFound()

  const [tournament] = await db
    .select({ slug: tournaments.slug })
    .from(tournaments)
    .where(eq(tournaments.id, loaded.match.tournamentId))
    .limit(1)

  const court = loaded.match.courtId
    ? (await db.select().from(courts).where(eq(courts.id, loaded.match.courtId)).limit(1))[0]
    : null

  return (
    <AdminEntry
      matchId={matchId}
      courtName={court?.name ?? null}
      courtColor={court?.colorKey}
      categoryName={loaded.category.name}
      roundName={loaded.match.roundName}
      teamAId={loaded.match.teamAId}
      teamBId={loaded.match.teamBId}
      nameA={loaded.nameA ?? '—'}
      nameB={loaded.nameB ?? '—'}
      rules={loaded.rules}
      back={`/admin/t/${tournament?.slug ?? ''}/board`}
    />
  )
}
