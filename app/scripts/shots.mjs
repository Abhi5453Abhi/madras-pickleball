import { chromium } from 'playwright-core'
const BASE = process.env.BASE ?? 'http://localhost:3200'
const SLUG = process.env.SLUG
const b = await chromium.launch({ executablePath: process.env.CHROME, args: ['--no-sandbox'] })
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
await b.close()
console.log('shots done')
