import { redirect } from 'next/navigation'
import { exchangeToken } from '@/server/court-tokens'
import { ensureReady } from '@/server/bootstrap'

/**
 * The printed card's URL. Exchanges the token for a device-bound cookie and
 * redirects to a clean path, so the secret is out of the URL bar and out of
 * anyone's screenshot.
 */
export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: RouteContext<'/c/[token]'>) {
  await ensureReady()
  const { token } = await ctx.params
  const result = await exchangeToken(token)
  redirect(result.ok ? '/court' : '/court?bad=1')
}
