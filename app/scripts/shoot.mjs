/**
 * Screenshots of every screen, phone-sized, against the demo tournament.
 *
 *   BASE=http://localhost:3300 SLUG=... OUT=/tmp/shots node scripts/shoot.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3300'
const OUT = process.env.OUT ?? '/tmp/shots'
const PASSWORD = process.env.PASSWORD ?? 'change-me-now'
const EXE = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean).find((p) => existsSync(p))

mkdirSync(OUT, { recursive: true })
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] })

async function shoot(page, name, width = 390) {
  await page.waitForTimeout(600)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  console.log(`${name}.png`)
}

const phone = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const p = await phone.newPage()

// slug
await p.goto(`${BASE}/`)
const href = await p.$eval('a[href^="/t/"]', (a) => a.getAttribute('href')).catch(() => null)
const SLUG = process.env.SLUG ?? (href ? href.split('/t/')[1] : null)
if (!SLUG) { console.error('No tournament found'); process.exit(1) }

await p.goto(`${BASE}/t/${SLUG}`, { waitUntil: 'networkidle' })
await shoot(p, '01-public')

await p.goto(`${BASE}/login`)
await shoot(p, '02-login')
await p.fill('#username', 'saurabh')
await p.fill('#password', PASSWORD)
await p.click('button[type=submit]')
await p.waitForURL(/\/(admin|umpire)/, { timeout: 20000 })
if (p.url().includes('/admin/account')) {
  await shoot(p, '03-first-password')
  const pw = await p.$$('input[type=password]')
  await pw[0].fill(PASSWORD); await pw[1].fill('demo-password-2026'); await pw[2].fill('demo-password-2026')
  await p.click('button[type=submit]')
  await p.waitForTimeout(2500)
}

for (const [name, path] of [
  ['04-admin-home', `/admin`],
  ['05-tournament', `/admin/t/${SLUG}`],
  ['06-board', `/admin/t/${SLUG}/board`],
  ['07-results', `/admin/t/${SLUG}/results`],
  ['08-registrations', `/admin/t/${SLUG}/registrations`],
  ['09-quick', `/admin/quick`],
  ['10-account', `/admin/account`],
]) {
  await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {})
  await shoot(p, name)
}

// score entry on the live match
await p.goto(`${BASE}/admin/t/${SLUG}/board`, { waitUntil: 'networkidle' })
const m = await p.$('a[href^="/admin/m/"]')
if (m) { await m.click(); await p.waitForTimeout(1200); await shoot(p, '11-score-entry') }

// desktop board — the organiser often has a laptop at the desk
const desk = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
const d = await desk.newPage()
await d.goto(`${BASE}/t/${SLUG}`, { waitUntil: 'networkidle' })
await shoot(d, '12-public-desktop')

await b.close()
console.log('done')
