import { publicTodayVersion } from '@/server/public'

/**
 * The venue "Today" page's poll. One number for the whole day, computed the
 * same way the page computes it — see `publicToday`. No cookies, so the CDN
 * can cache it.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const v = await publicTodayVersion()
  return Response.json(
    { v },
    { headers: { 'Cache-Control': 'public, s-maxage=2, stale-while-revalidate=10' } },
  )
}
