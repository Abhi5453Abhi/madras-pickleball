import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { getTournamentBySlug } from '@/server/tournaments'
import { Cards } from './cards'

export const dynamic = 'force-dynamic'

export default async function CardsPage(props: PageProps<'/admin/t/[slug]/cards'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const tournament = await getTournamentBySlug(slug)
  if (!tournament) notFound()

  return (
    <div className="flex flex-col gap-6">
      <header className="print:hidden">
        <p className="font-score text-eyebrow text-accent uppercase">Court cards</p>
        <h1 className="mt-1 text-title text-text">{tournament.name}</h1>
        <p className="mt-1 text-body text-text-2">
          One card per court, taped to the net post. Anyone can scan it and enter the score — no
          account, no app.
        </p>
      </header>
      <Cards slug={slug} />
    </div>
  )
}
