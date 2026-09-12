/**
 * Run the reconciler once, against whichever database this checkout is
 * pointed at. The same work `/api/cron/tick` does, without a server.
 *
 *   npm run tick
 *
 * Useful on a laptop, where nothing is pinging the endpoint, and as the
 * fallback when the scheduler is down and the host needs the gate to run.
 */
import 'dotenv/config'
import { ensureReady } from '../src/server/bootstrap'
import { runTick } from '../src/server/daily-reconcile'

async function main() {
  await ensureReady()
  const out = await runTick()
  if (out.skipped) {
    console.log('another tick is already running — nothing done')
    process.exit(0)
  }
  console.log(`${out.seen} game(s) looked at, ${out.applied} change(s) applied`)
  for (const s of out.sessions) console.log(`  ${s.slug}: ${s.actions.join(', ')}`)
  if (out.error) {
    console.error(out.error)
    process.exit(1)
  }
  process.exit(0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
