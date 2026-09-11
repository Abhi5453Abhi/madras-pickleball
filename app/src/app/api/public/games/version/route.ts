import { publicSessionsVersion } from '@/server/daily-public'

/**
 * A few bytes. Phones poll this and fetch the list only when it moves.
 *
 * The value MUST come from the same function the page rendered with — a second
 * definition here is how every phone in the venue ends up hard-refreshing every
 * five seconds. No cookies are touched, so the CDN can cache it.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const v = await publicSessionsVersion()
  return Response.json(
    { v },
    { headers: { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10' } },
  )
}
