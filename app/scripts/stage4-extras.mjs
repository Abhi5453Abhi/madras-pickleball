/**
 * The venue's furniture and the people with keys: courts added, renamed and
 * taken out; a list pasted into Registration; a second organiser given a PIN
 * and then removed. Screenshots to /tmp/shots-extras/.
 *
 *   BASE=http://localhost:3200 node scripts/stage4-extras.mjs
 *
 * Expects a fresh database with the organiser on the temporary PIN 123456.
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3200'
const EXE = [process.env.CHROME, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(Boolean).find((p) => existsSync(p))
const OUT = process.env.OUT ?? '/tmp/shots-extras'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
const bad = []
page.on('pageerror', (e) => console.log('   pageerror:', e.message.slice(0, 160)))
page.on('response', (r) => r.status() >= 500 && bad.push(`${r.status()} ${r.url()}`))

const fails = []
const ok = (l, c, extra = '') => (c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l} ${extra}`)))
const body = (p = page) => p.evaluate(() => document.body.textContent ?? '')
// textContent keeps the RSC payload of earlier renders around after a
// client-side navigation; for "this word is gone" use what is on screen.
const seen = (p = page) => p.evaluate(() => document.body.innerText ?? '')
let n = 0
const shot = async (name, p = page) => {
  n += 1
  await p.waitForLoadState('networkidle').catch(() => {})
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-${name}.png`, fullPage: true })
}
const goto = async (url, p = page) => {
  await p.goto(url, { waitUntil: 'networkidle' })
  return body(p)
}
/** A server action answers with a redirect; wait for the page to say so. */
const until = async (re, p = page, ms = 15000) => {
  const end = Date.now() + ms
  let t = await body(p)
  while (!re.test(t) && Date.now() < end) {
    await p.waitForTimeout(150)
    t = await body(p)
  }
  return t
}

console.log('\n1. sign in')
await page.goto(`${BASE}/login`)
await page.fill('#pin', '123456')
await page.click('button[type=submit]')
await page.waitForURL(/\/admin/, { timeout: 20000 })
if (page.url().includes('/admin/account')) {
  await page.fill('#current', '123456')
  await page.fill('#next', '482913')
  await page.fill('#confirm', '482913')
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin$/, { timeout: 20000 })
}

console.log('\n2. the venue’s courts')
let t = await goto(`${BASE}/admin/account`)
ok('the account page links to the courts', /The venue’s courts/.test(t))
t = await goto(`${BASE}/admin/courts`)
ok('four courts to start with', /4 at the venue/.test(t) && /Court 4/.test(t), t.slice(0, 200))
await shot('courts')
await page.fill('input[aria-label="Add a court"]', 'Court 5')
await page.click('form:has(input[aria-label="Add a court"]) button')
t = await until(/Court 5 is in|There is already/)
ok('Court 5 is in', /5 at the venue/.test(t) && /Court 5 is in\./.test(t), t.slice(0, 300))
await page.fill('input[aria-label="Add a court"]', 'court 5')
await page.click('form:has(input[aria-label="Add a court"]) button')
t = await until(/There is already a Court 5/)
ok('the same name again is refused', /There is already a Court 5/.test(t), t.slice(0, 300))
// rename Court 5 → Centre Court
const fifth = page.locator('input[aria-label="Name of Court 5"]')
await fifth.fill('Centre Court')
await page.locator('form:has(input[aria-label="Name of Court 5"]) button:has-text("Rename")').click()
t = await until(/Renamed\./)
ok('renamed to Centre Court', /Renamed\./.test(t) && /Centre Court/.test(t) && !/Court 5/.test(await seen()), t.slice(0, 300))
await shot('courts-five')

console.log('\n3. a tournament on Centre Court, then the court cannot be taken out')
await goto(`${BASE}/admin/new`)
await page.click('button:has-text("Centre Court")')
await page.click('button:has-text("Create")')
await page.waitForURL(/\/admin\/t\//, { timeout: 20000 })
const slug = page.url().split('/admin/t/')[1].split(/[/?]/)[0]
t = await goto(`${BASE}/admin/courts`)
ok('Centre Court says who uses it', /Centre Court[\s\S]*Used by Men's Doubles/.test(t), t.slice(0, 500))
const takeOut = await page.$$eval('summary', (ss) => ss.filter((s) => /Take it out/.test(s.textContent ?? '')).length)
ok('four courts can be taken out, not the one in use', takeOut === 4, String(takeOut))
// take Court 4 out
await page.locator('li:has-text("Court 4") summary:has-text("Take it out")').click()
await page.locator('button:has-text("Take Court 4 out")').click()
t = await until(/Taken out\./)
ok('Court 4 is out', /Taken out\./.test(t) && /4 at the venue/.test(t) && !/Court 4/.test(await seen()), t.slice(0, 300))
t = await goto(`${BASE}/admin/live`)
ok('the live board has no Court 4 and has Centre Court', !/Court 4/.test(t) && /Centre Court/.test(t), t.slice(0, 400))
await shot('live-five')
t = await goto(`${BASE}/admin/t/${slug}/schedule`)
ok('the schedule page links to the courts page', /Add or rename the venue’s courts/.test(t))
// bring Court 4 back
await goto(`${BASE}/admin/courts`)
await page.fill('input[aria-label="Add a court"]', 'Court 4')
await page.click('form:has(input[aria-label="Add a court"]) button')
t = await until(/Court 4 is in/)
ok('Court 4 comes back', /5 at the venue/.test(t) && /Court 4/.test(t), t.slice(0, 300))

console.log('\n4. paste a list into Registration')
t = await goto(`${BASE}/admin/t/${slug}/registration`)
ok('the add box invites a paste', /paste a list/.test(await page.getAttribute('textarea[name=text]', 'placeholder')))
await page.fill('textarea[name=text]', '1. Karthik Subramanian ✅\n2. Sathish Kumar 98400 12345\n3. Ravi Shankar\n4. Arun Prakash\n5. Hari Venkatesh\n6. Naveen Krishnan')
await shot('registration-paste')
await page.click('form:has(textarea[name=text]) button')
t = await until(/6 in · sign-ups open/)
ok('six players are in', /6 in · sign-ups open/.test(t) && /Karthik Subramanian/.test(t) && /Naveen Krishnan/.test(t), t.slice(0, 400))
await page.fill('textarea[name=text]', 'Ravi Shankar\nDeepak Raj')
await page.click('form:has(textarea[name=text]) button')
await page.waitForLoadState('networkidle')
await page.waitForTimeout(600)
t = await body()
ok('a repeat is skipped, a new name added', /7 in · sign-ups open/.test(t) && /Deepak Raj/.test(t), t.slice(0, 400))
await page.fill('textarea[name=text]', 'Bala Murugan')
await page.keyboard.press('Enter')
t = await until(/8 in · sign-ups open/)
ok('Enter adds a single name', /8 in · sign-ups open/.test(t) && /Bala Murugan/.test(t), t.slice(0, 400))
await shot('registration-eight')

console.log('\n5. the hub shares the public page')
t = await goto(`${BASE}/admin/t/${slug}`)
ok('Share and a plain public-page link', /Share/.test(t) && /Public page — what players see/.test(t), t.slice(0, 400))
await page.click('button:has-text("Share")')
await page.waitForTimeout(500)
t = await body()
ok('on a laptop, Share copies the link', /Link copied/.test(t), t.slice(0, 300))
await shot('hub-shared')

console.log('\n6. a second organiser')
t = await goto(`${BASE}/admin/account`)
ok('the owner sees the organisers list with themself', /Organisers/.test(t) && /you · venue owner/.test(t), t.slice(0, 400))
await page.fill('input[aria-label="Add an organiser"]', 'Priya Ramesh')
await page.click('form:has(input[aria-label="Add an organiser"]) button')
t = await until(/Their PIN is \d{6}/)
const pinMatch = t.match(/Their PIN is (\d{6})/)
ok('Priya is in, with a PIN shown once', !!pinMatch && /Priya Ramesh/.test(t) && /has not signed in yet/.test(t), t.slice(0, 400))
await shot('account-organisers')
const priyaPin = pinMatch?.[1] ?? '000000'
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } })
const p2 = await ctx2.newPage()
await p2.goto(`${BASE}/login`)
await p2.fill('#pin', priyaPin)
await p2.click('button[type=submit]')
await p2.waitForURL(/\/admin/, { timeout: 20000 })
ok('Priya can sign in with it and must choose her own', p2.url().includes('/admin/account'))
await p2.fill('#current', priyaPin)
await p2.fill('#next', '917364')
await p2.fill('#confirm', '917364')
await p2.click('button[type=submit]')
await p2.waitForURL(/\/admin$/, { timeout: 20000 })
t = await body(p2)
ok('and lands on the same dashboard', /Men's Doubles/.test(t), t.slice(0, 200))
t = await goto(`${BASE}/admin/account`, p2)
ok('Priya does not see the organisers list', !/Organisers/.test(await seen(p2)) && /Priya Ramesh/.test(t), t.slice(0, 300))
await p2.fill('#current', '917364')
await p2.fill('#next', '482913')
await p2.fill('#confirm', '482913')
await p2.click('button[type=submit]')
await p2.waitForTimeout(800)
t = await body(p2)
ok('Priya cannot take the owner’s PIN', /Another organiser already uses that PIN/.test(t), t.slice(0, 400))
// the owner removes Priya
await goto(`${BASE}/admin/account`)
await page.locator('li:has-text("Priya Ramesh") summary:has-text("Remove")').click()
await page.locator('button:has-text("Remove Priya Ramesh")').click()
t = await until(/Removed\. Their PIN no longer works/)
ok('Priya is removed', /Removed\. Their PIN no longer works\./.test(t) && !/has not signed in yet/.test(await seen()), t.slice(0, 300))
await p2.goto(`${BASE}/admin`, { waitUntil: 'networkidle' })
ok('and her session is gone', p2.url().includes('/login'), p2.url())
await p2.fill('#pin', '917364')
await p2.click('button[type=submit]')
await p2.waitForTimeout(800)
ok('her PIN no longer works', /not it/.test(await body(p2)))
await ctx2.close()

ok('no 5xx anywhere', bad.length === 0, bad.join(' '))
await browser.close()
console.log(fails.length ? `\n${fails.length} failed:\n  ${fails.join('\n  ')}` : '\nall good')
process.exit(fails.length ? 1 : 0)
