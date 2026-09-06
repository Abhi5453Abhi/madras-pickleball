import { publicVersion } from '@/server/public'

/**
 * ~30 bytes. Clients poll this and fetch the page only when it moves.
 *
 * The number MUST come from the same function the page rendered with — see
 * `composeVersion`. A second definition here is how every phone in the venue
 * ends up hard-refreshing every five seconds.
 *
 * No cookies are touched, so the CDN can cache it.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: RouteContext<'/api/public/t/[slug]/version'>) {
  const { slug } = await ctx.params
  const v = await publicVersion(slug)
  // An unpublished tournament is not public, and its existence is not either.
  if (v === null) return new Response('null', { status: 404 })

  return Response.json(
    { v },
    { headers: { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10' } },
  )
}
