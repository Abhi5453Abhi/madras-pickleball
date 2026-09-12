import { publicSessionVersion } from '@/server/daily-public'

/** One game's poll. Same number the page rendered with. No cookies. */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: RouteContext<'/api/public/g/[slug]/version'>) {
  const { slug } = await ctx.params
  const v = await publicSessionVersion(slug)
  // A game that has not been published is not public, and neither is the fact
  // that it exists.
  if (v === null) return new Response('null', { status: 404 })

  return Response.json(
    { v },
    { headers: { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10' } },
  )
}
