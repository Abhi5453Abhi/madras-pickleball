import { eq } from 'drizzle-orm'
import { db } from '@/db'
import { matches, tournaments } from '@/db/schema'
import { and, sql } from 'drizzle-orm'

/**
 * ~30 bytes. Clients poll this and fetch the page only when it moves.
 *
 * While anything is still `reported`, the response also carries the current
 * minute: the ten-minute auto-confirm boundary writes nothing, so without it
 * the day's last result would stay marked provisional on every phone.
 *
 * No cookies are touched here, so the CDN can cache it.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: RouteContext<'/api/public/t/[slug]/version'>) {
  const { slug } = await ctx.params
  const [row] = await db
    .select({ id: tournaments.id, v: tournaments.streamVersion })
    .from(tournaments)
    .where(eq(tournaments.slug, slug))
    .limit(1)

  if (!row) return new Response('null', { status: 404 })

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(matches)
    .where(and(eq(matches.tournamentId, row.id), eq(matches.resultState, 'reported')))

  const v = Number(row.v) + (n > 0 ? Math.floor(Date.now() / 60_000) : 0)

  return Response.json(
    { v },
    { headers: { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10' } },
  )
}
