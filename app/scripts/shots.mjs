import { chromium } from 'playwright-core'
const BASE = process.env.BASE ?? 'http://localhost:3200'
const SLUG = process.env.SLUG
const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/google-chrome',
].filter(Boolean)
const { existsSync } = await import('node:fs')
const EXE = CHROME_CANDIDATES.find((p) => existsSync(p))
const b = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()

await p.goto(`${BASE}/t/${SLUG}`, { waitUntil: 'networkidle' })
await p.screenshot({ path: '/tmp/s-public.png', fullPage: true })

await p.goto(`${BASE}/login`)
await p.fill('#username', 'saurabh'); await p.fill('#password', 'change-me-now')
await p.click('button[type=submit]')
await p.waitForURL('**/admin**', { timeout: 20000 })
await p.goto(`${BASE}/admin`)
await p.screenshot({ path: '/tmp/s-admin.png', fullPage: true })
await p.goto(`${BASE}/admin/t/${SLUG}`, { waitUntil: 'networkidle' })
await p.screenshot({ path: '/tmp/s-tournament.png', fullPage: true })
await p.goto(`${BASE}/admin/t/${SLUG}/board`, { waitUntil: 'networkidle' })
await p.screenshot({ path: '/tmp/s-board.png', fullPage: true })

// score entry for the live match
const link = await p.$('a[href^="/admin/m/"]')
if (link) { await link.click(); await p.waitForTimeout(1500); await p.screenshot({ path: '/tmp/s-score.png', fullPage: true }) }
await p.goto(`${BASE}/admin/t/${SLUG}/results`, { waitUntil: 'networkidle' })
await p.screenshot({ path: '/tmp/s-results.png', fullPage: true })
await p.goto(`${BASE}/admin/t/${SLUG}/cards`, { waitUntil: 'networkidle' })
await p.click('button:has-text("Make the cards")')
await p.waitForFunction(() => document.body.innerText.includes('shown once'), null, { timeout: 20000 })
await p.waitForTimeout(1500)
await p.screenshot({ path: '/tmp/s-cards.png', fullPage: true })
await p.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await p.screenshot({ path: '/tmp/s-home.png', fullPage: true })
await b.close()
console.log('shots done')
