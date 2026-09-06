/**
 * Walks the organiser's first hour in a real browser: PIN sign-in, a forced
 * PIN change, an empty dashboard, a new tournament, its checklist, and the
 * three setup screens. Screenshots go to /tmp/shots/stage1-*.png.
 *
 *   BASE=http://localhost:3200 node scripts/stage1.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3200'
const EXE = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
const OUT = process.env.OUT ?? '/tmp/shots'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('   pageerror:', e.message.slice(0, 160)))
const bad = []
page.on('response', (r) => {
  if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`)
})

const fails = []
const ok = (l, c, extra = '') =>
  c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l} ${extra}`))
const body = () => page.evaluate(() => document.body.textContent ?? '')
let n = 0
const shot = async (name) => {
  n += 1
  // Streamed pages can still be swapping a loading skeleton out.
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/stage1-${String(n).padStart(2, '0')}-${name}.png`, fullPage: true })
}

console.log('\n1. sign in with the temporary PIN')
await page.goto(`${BASE}/login`)
await shot('login')
await page.fill('#pin', '000000')
await page.click('button[type=submit]')
await page.waitForTimeout(800)
ok('a wrong PIN says so and counts down', /not it.*4 tries left/.test(await body()), (await body()).slice(0, 200))
await shot('login-wrong')
await page.fill('#pin', '123456')
await page.click('button[type=submit]')
await page.waitForURL(/\/admin/, { timeout: 20000 })
ok('a temporary PIN lands on the choose-your-PIN screen', page.url().includes('/admin/account'))
await shot('first-pin')

await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' })
ok('and it cannot be walked around', page.url().includes('/admin/account'))

console.log('\n2. choose a PIN')
await page.fill('#current', '123456')
await page.fill('#next', '111111')
await page.fill('#confirm', '111111')
await page.click('button[type=submit]')
await page.waitForTimeout(800)
ok('six of the same digit is refused', /six of the same digit/.test(await body()))
await page.fill('#current', '123456')
await page.fill('#next', '482913')
await page.fill('#confirm', '482913')
await page.click('button[type=submit]')
await page.waitForURL(/\/admin$/, { timeout: 20000 })
ok('a real PIN goes through to the dashboard', /Nothing on yet/.test(await body()))
await shot('dashboard-empty')

console.log('\n3. sign out and back in with the new PIN')
await page.context().clearCookies()
await page.goto(`${BASE}/login`)
await page.fill('#pin', '123456')
await page.click('button[type=submit]')
await page.waitForTimeout(800)
ok('the old PIN no longer works', /not it/.test(await body()))
await page.fill('#pin', '482913')
await page.click('button[type=submit]')
await page.waitForURL(/\/admin$/, { timeout: 20000 })
ok('the new one does', page.url().endsWith('/admin'))

console.log('\n4. make a tournament')
await page.click('a:has-text("Make a tournament")')
await page.waitForURL(/\/admin\/new/, { timeout: 20000 })
await shot('new')
const suggested = await page.inputValue('#name')
ok('the name writes itself from the category', /Men's Doubles — \w+/.test(suggested), suggested)
await page.click('button:has-text("Court 1")')
await page.click('button:has-text("Court 2")')
await shot('new-filled')
await page.click('button:has-text("Create")')
await page.waitForURL(/\/admin\/t\//, { timeout: 20000 })
const slug = page.url().split('/admin/t/')[1].split(/[/?]/)[0]
ok('lands on the tournament page', !!slug)
let t = await body()
ok('with the four steps', /Registration/.test(t) && /Teams/.test(t) && /Schedule & courts/.test(t) && /Start/.test(t))
ok('courts show on the schedule step', /Court 1, Court 2/.test(t))
ok('sign-ups are open from the start', /link is open/.test(t))
await shot('hub-setup')

console.log('\n5. a second tournament the same day cannot take those courts')
await page.goto(`${BASE}/admin/new`)
await page.click('button:has-text("Mixed")')
t = await body()
ok('Court 1 and 2 are named as taken', /Court 1\s*· Men's Doubles/.test(t) && /Court 2\s*· Men's Doubles/.test(t) && /A greyed court belongs to another tournament/.test(t), t.slice(0, 400))
const disabled = await page.$eval('button:has-text("Court 1")', (b) => b.disabled)
ok('and not pickable', disabled)
await page.click('button:has-text("Court 3")')
await shot('new-second')
await page.click('button:has-text("Create")')
await page.waitForURL(/\/admin\/t\//, { timeout: 20000 })
const slug2 = page.url().split('/admin/t/')[1].split(/[/?]/)[0]
ok('the second one is made', !!slug2 && slug2 !== slug)

console.log('\n6. the dashboard shows both')
await page.goto(`${BASE}/admin`)
t = await body()
ok('both are on today', /On today/.test(t) && /Men's Doubles/.test(t) && /Mixed Doubles/.test(t))
ok('each with its courts', /Court 1/.test(t) && /Court 3/.test(t))
await shot('dashboard-two')

console.log('\n7. the three setup screens open')
await page.goto(`${BASE}/admin/t/${slug}/registration`)
ok('registration', /Registration|Sign-up|sign-up/i.test(await body()))
await shot('registration')
await page.goto(`${BASE}/admin/t/${slug}/teams`)
ok('teams', /Nobody has signed up yet/.test(await body()))
await shot('teams-empty')
await page.goto(`${BASE}/admin/t/${slug}/schedule`)
t = await body()
ok('schedule shows the courts and no schedule', /Court 1, Court 2/.test(t) && /schedule not made yet/.test(t))
await shot('schedule-empty')

console.log('\n8. courts can be changed, never stolen')
await page.goto(`${BASE}/admin/t/${slug2}/schedule`)
t = await body()
ok('the other tournament sees Courts 1 and 2 as taken', /Court 1.*Men's Doubles/.test(t))
// pick Court 4 as well for Mixed
await page.click('label:has-text("Court 4")')
await page.click('button:has-text("Save courts")')
await page.waitForTimeout(1500)
await page.goto(`${BASE}/admin/t/${slug2}/schedule`)
t = await body()
ok('Mixed now holds Court 3 and 4', /Court 3, Court 4/.test(t), t.slice(0, 120))
await shot('schedule-courts')

console.log('\n9. sign out')
await page.goto(`${BASE}/admin/account`)
await shot('account')

ok('no 5xx anywhere', bad.length === 0, bad.join(' '))
await browser.close()
console.log(fails.length ? `\n${fails.length} failed:\n  ${fails.join('\n  ')}` : '\nall good')
process.exit(fails.length ? 1 : 0)
