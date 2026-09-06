/**
 * Screenshots for a walkthrough — every screen, plus the court flow the QR
 * opens, which the ordinary shot script cannot reach because it needs a card.
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3300'
const OUT = process.env.OUT ?? '/tmp/tour'
const EXE = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/usr/bin/chromium'].find((p) =>
  existsSync(p),
)
mkdirSync(OUT, { recursive: true })
const b = await chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] })
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const p = await ctx.newPage()
const shot = async (page, name) => {
  await page.waitForTimeout(700)
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
  console.log(name)
}
const T = (page) => page.evaluate(() => document.body.textContent ?? '')

await p.goto(`${BASE}/`)
const slug = (await p.$eval('a[href^="/t/"]', (a) => a.getAttribute('href'))).split('/t/')[1]

await p.goto(`${BASE}/t/${slug}`, { waitUntil: 'networkidle' })
await shot(p, '01-public')

await p.goto(`${BASE}/login`)
await p.fill('#username', 'saurabh')
await p.fill('#password', 'change-me-now')
await p.click('button[type=submit]')
await p.waitForURL(/\/(admin|umpire)/, { timeout: 20000 })
if (p.url().includes('/admin/account')) {
  const pw = await p.$$('input[type=password]')
  await pw[0].fill('change-me-now')
  await pw[1].fill('demo-password-2026')
  await pw[2].fill('demo-password-2026')
  await p.click('button[type=submit]')
  await p.waitForTimeout(2500)
}

for (const [n, path] of [
  ['02-tournament', `/admin/t/${slug}`],
  ['03-board', `/admin/t/${slug}/board`],
  ['04-results', `/admin/t/${slug}/results`],
  ['05-signups', `/admin/t/${slug}/registrations`],
  ['06-quick', `/admin/quick`],
]) {
  await p.goto(`${BASE}${path}`, { waitUntil: 'networkidle' }).catch(() => {})
  await shot(p, n)
}

// Court cards, and then the court screen itself.
await p.goto(`${BASE}/admin/t/${slug}/cards`, { waitUntil: 'networkidle' })
await p.click('button:has-text("Make the cards")')
await p.waitForFunction(() => (document.body.textContent ?? '').includes('shown once'), null, {
  timeout: 20000,
})
await shot(p, '07-court-cards')
const codes = [
  ...new Set(((await T(p)).match(/[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}/g) ?? [])),
]

const anon = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const court = await anon.newPage()
const chip = (n) => court.locator('button').filter({ hasText: new RegExp(`^${n}$`) }).first()

for (const code of codes) {
  await court.goto(`${BASE}/c/${code}`, { waitUntil: 'networkidle' })
  if (!/Who won game 1/.test(await T(court))) continue
  await shot(court, '08-court-entry')

  const sides = await court.$$eval('button[aria-pressed]', (els) =>
    els.map((e) => e.textContent?.trim() ?? '').filter(Boolean),
  )
  const win = sides[0]
  await court.locator('button').filter({ hasText: win }).first().click()
  await court.waitForTimeout(500)
  await shot(court, '09-court-scores')
  await chip(7).click()
  await court.waitForTimeout(700)
  await court.locator('button').filter({ hasText: win }).first().click()
  await court.waitForTimeout(500)
  await chip(9).click()
  await court.waitForTimeout(900)
  await shot(court, '10-court-submit')

  const holds = await court.$$('button:has-text("Hold")')
  if (holds.length) {
    const box = await holds[0].boundingBox()
    await court.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await court.mouse.down()
    await court.waitForTimeout(900)
    await court.mouse.up()
    await court.waitForTimeout(3000)
  }
  await shot(court, '11-court-confirm')
  break
}

// The public page again, now with the score on it.
await p.goto(`${BASE}/t/${slug}`, { waitUntil: 'networkidle' })
await shot(p, '12-public-after')

const desk = await b.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 })
const d = await desk.newPage()
await d.goto(`${BASE}/t/${slug}`, { waitUntil: 'networkidle' })
await shot(d, '13-public-desktop')

await b.close()
console.log('done')
