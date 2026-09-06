import Link from 'next/link'
import { notFound } from 'next/navigation'
import { requireUser } from '@/lib/auth'
import { Chevron, EmptyState, Notice, Panel, TeamName } from '@/components/ui'
import { hub } from '@/server/events'
import { listTeams, listTournamentPlayers } from '@/server/tournaments'
import { db } from '@/db'
import { teamPlayers, teams } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { PRIMARY_LINK, SECONDARY_LINK } from '../../../_ui'
import { pairEveryoneAction } from './actions'

export const metadata = { title: 'Teams · Madras Pickleball' }
export const dynamic = 'force-dynamic'

/**
 * Stage 1: the pairs so far and who is still to pair, with one button that
 * pairs everyone at random. Partner requests, "Pair with…", split and merge
 * come with the registration work.
 */
export default async function TeamsPage(props: PageProps<'/admin/t/[slug]/teams'>) {
  await requireUser('admin')
  const { slug } = await props.params
  const { err } = await props.searchParams
  const h = await hub(slug)
  if (!h) notFound()
  const { tournament: t, category } = h
  const doubles = category.discipline === 'doubles'

  const [roster, teamList, members] = await Promise.all([
    listTournamentPlayers(t.id),
    listTeams(category.id),
    db
      .select({ teamId: teamPlayers.teamId, playerId: teamPlayers.playerId })
      .from(teamPlayers)
      .innerJoin(teams, eq(teams.id, teamPlayers.teamId))
      .where(eq(teams.categoryId, category.id)),
  ])
  const paired = new Set(members.map((m) => m.playerId))
  const unpaired = roster.filter((p) => !p.withdrawn && !paired.has(p.id))
  const active = teamList.filter((x) => x.status !== 'withdrawn')
  const locked = h.matchesPlayed > 0

  return (
    <div className="flex flex-col gap-6">
      <header>
        <Link href={`/admin/t/${slug}`} className="tap -ml-2 inline-flex items-center gap-0.5 px-2 text-[16px] font-semibold text-link">
          <Chevron className="rotate-90" />
          {t.name}
        </Link>
        <h1 className="mt-1 text-title text-text">{doubles ? 'Teams' : 'Players'}</h1>
        <p className="num mt-1 text-meta text-text-3">
          {doubles
            ? `${active.length} of ${h.teamsNeeded} pairs made${unpaired.length ? ` · ${unpaired.length} still to pair` : ''}`
            : `${active.length} in the draw${unpaired.length ? ` · ${unpaired.length} not in yet` : ''}`}
        </p>
      </header>

      {err ? <Notice tone="alert">{String(err)}</Notice> : null}

      {roster.length === 0 ? (
        <EmptyState title="Nobody has signed up yet">
          <p>Share the sign-up link, or add players by hand under Registration.</p>
          <Link href={`/admin/t/${slug}/registration` as never} className={`${SECONDARY_LINK} mt-3 max-w-[16rem]`}>
            Registration
          </Link>
        </EmptyState>
      ) : null}

      {unpaired.length && !locked ? (
        <form action={pairEveryoneAction}>
          <input type="hidden" name="slug" value={slug} />
          <button className={PRIMARY_LINK}>
            {doubles
              ? active.length
                ? 'Pair everyone again at random'
                : 'Pair everyone at random'
              : 'Put everyone in the draw'}
          </button>
          {doubles && active.length ? (
            <p className="mt-2 text-center text-meta text-text-2">Remakes every pair, not just the ones left.</p>
          ) : null}
        </form>
      ) : null}

      {active.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">
            {doubles ? 'Pairs' : 'In the draw'}
            <small className="num ml-1 font-normal normal-case text-text-3">{active.length}</small>
          </h2>
          <Panel>
            <ul className="divide-y divide-line">
              {active.map((tm) => (
                <li key={tm.id} className="flex items-center gap-3 px-4 py-3">
                  <span className="num w-6 text-meta text-text-3">{tm.seed}</span>
                  <TeamName name={tm.name} />
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}

      {unpaired.length ? (
        <section className="flex flex-col gap-3">
          <h2 className="font-score text-eyebrow text-text-2 uppercase">
            {doubles ? 'Still to pair' : 'Not in yet'}
            <small className="num ml-1 font-normal normal-case text-text-3">{unpaired.length}</small>
          </h2>
          <Panel>
            <ul className="divide-y divide-line">
              {unpaired.map((p) => (
                <li key={p.id} className="flex min-h-[52px] items-center px-4 text-row text-text">
                  {p.name}
                </li>
              ))}
            </ul>
          </Panel>
        </section>
      ) : null}

      <Link href={`/admin/t/${slug}`} className={SECONDARY_LINK}>
        Back to {t.name}
      </Link>
    </div>
  )
}
