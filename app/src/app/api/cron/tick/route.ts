import { timingSafeEqual } from 'node:crypto'
import { ensureReady } from '@/server/bootstrap'
import { runTick } from '@/server/daily-reconcile'

/**
 * The scheduler tick — one of exactly three things in this app that may change
 * state (the others are a signed webhook, in stage 4, and an explicit command).
 * There is no page-render variant and there is not going to be one.
 *
 * **It wants to run every 5 to 15 minutes.** The confirmation gate fires three
 * hours before a game and again an hour before it, and a game that nobody ended
 * ends itself half an hour after it was due to finish. Vercel's free plan runs a
 * cron once a day, which is not enough for any of that — until the Pro plan
 * lands (stage 4, `m11`), point a free external pinger at this URL with the same
 * header. Nothing else about the design changes: `planSession` never reads a
 * clock, and the host can always run the gate by hand from the Tonight screen.
 *
 * Missing ticks costs time, not correctness. Three missed weeks produce one
 * catch-up, not three replayed cycles, and a boundary whose moment has gone is
 * recorded as missed rather than fired late.
 */
export const dynamic = 'force-dynamic'
export const maxDuration = 60

function authorised(req: Request): boolean {
  const expected = process.env.CRON_SECRET
  // No secret configured means the endpoint is closed, not open. An unguarded
  // state-changing GET on a public URL is the bug this whole design avoids.
  if (!expected) return false

  const header = req.headers.get('authorization') ?? ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : (req.headers.get('x-cron-key') ?? '')
  const a = Buffer.from(bearer)
  const b = Buffer.from(expected)
  // Length is compared first because timingSafeEqual throws on a mismatch; the
  // length of a secret is not the secret.
  return a.length === b.length && timingSafeEqual(a, b)
}

async function tick(req: Request) {
  if (!authorised(req)) return new Response('no', { status: 401 })
  await ensureReady()
  const result = await runTick()
  return Response.json(result, { status: result.error ? 500 : 200, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(req: Request) {
  return tick(req)
}

/** Vercel Cron sends GET; an external pinger may prefer POST. Same work. */
export async function POST(req: Request) {
  return tick(req)
}
