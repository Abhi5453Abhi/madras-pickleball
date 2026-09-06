import { redirect } from 'next/navigation'
import { exchangeToken } from '@/server/court-tokens'
import { ensureReady } from '@/server/bootstrap'

/**
 * The printed card's URL. Exchanges the token for a device-bound cookie and
 * redirects to a clean path, so the secret is out of the URL bar and out of
 * anyone's screenshot.
 *
 * A failure carries WHY into the query string, but only along the axis that is
 * safe to tell apart: "you have scanned too many times from this connection"
 * is about the phone, not about the card. "No such token" and "revoked" stay
 * identical, in wording and in timing, so this is never an oracle for whether
 * a code exists — a distinction the person at the net post does not need and
 * cannot act on differently anyway.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: RouteContext<'/c/[token]'>) {
  await ensureReady()
  const { token } = await ctx.params
  const result = await exchangeToken(token)
  if (result.ok) redirect('/court')
  redirect(result.reason === 'rate_limited' ? '/court?bad=rate' : '/court?bad=1')
}
