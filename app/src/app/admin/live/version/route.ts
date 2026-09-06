import { currentUser } from '@/lib/auth'
import { venueVersion } from '@/server/board'

/**
 * A few bytes, for the board's own refresh. The number must come from the
 * same function the board rendered with, or every phone hard-refreshes every
 * five seconds. Organiser only — it says which tournaments are on today.
 */
export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await currentUser()
  if (!user) return new Response('null', { status: 401 })
  const v = await venueVersion()
  return Response.json({ v }, { headers: { 'Cache-Control': 'no-store' } })
}
