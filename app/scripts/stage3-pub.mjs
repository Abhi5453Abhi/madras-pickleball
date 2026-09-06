/**
 * Walks the public pages, More and the results list in a real browser.
 * Expects the database seeded by scripts/seed-pub.ts (two doubles tournaments
 * today: Men's part-played with two matches on court, Mixed finished) and a
 * fresh organiser PIN of 123456.
 *
 *   BASE=http://localhost:3404 MENS=<slug> MIXED=<slug> node scripts/stage3-pub.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3404'
const MENS = process.env.MENS
const MIXED = process.env.MIXED
if (!MENS || !MIXED) throw new Error('MENS and MIXED slugs are required')
const PIN = process.env.PIN ?? '482913'
const EXE = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
const OUT = process.env.OUT ?? '/tmp/shots-pub'
mkdirSync(OUT, { recursive: true })

const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ['--no-sandbox'] })
const fails = []
const ok = (l, c, extra = '') =>
  c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l} ${extra}`))
const bad = []
let n = 0

function watch(page) {
  page.on('pageerror', (e) => console.log('   pageerror:', e.message.slice(0, 160)))
  page.on('response', (r) => {
    if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`)
  })
}
// innerText, not textContent: after a client-side navigation the old page's
// inline RSC scripts are still in the body, and they contain every name.
// Uppercase eyebrows come back uppercased, so every check below is case-blind.
// And only once the stream has finished: a page behind `loading.tsx` swaps
// its skeleton out after load, so the text is read after the network goes quiet.
const textOf = async (page) => {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(150)
  return page.evaluate(() => document.body.innerText ?? '')
}
const shot = async (page, name) => {
  n += 1
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-${name}.png`, fullPage: true })
}

// ── public, with no cookies at all ──────────────────────────────────────────
const pub = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const page = await pub.newPage()
watch(page)

console.log('\n1. the public tournament page')
let res = await page.goto(`${BASE}/t/${MENS}`)
ok('answers with no set-cookie', !res.headers()['set-cookie'])
ok('and the browser holds no cookie', (await pub.cookies()).length === 0)
let t = await textOf(page)
ok('header says played of total and the courts', /7 of 16 played · Courts 1, 2/i.test(t), t.slice(0, 200))
ok('on court now, one card per live court', /On court now[\s\S]*Court 1[\s\S]*against[\s\S]*Court 2[\s\S]*against/i.test(t))
ok('up next with Next and Then', /Up next[\s\S]*Next[\s\S]*Then/i.test(t))
ok('table with the cut line', /Table[\s\S]*Won[\s\S]*Points[\s\S]*Top 2 play the final/i.test(t))
ok('played, newest first, with scores', /Played[\s\S]*beat[\s\S]*Round 3[\s\S]*Round 1/i.test(t))
ok('no phone number anywhere', !/\+91\d{10}/i.test(t) && !/98765/i.test(t))
await shot(page, 'public-running')

console.log('\n2. the finished one')
await page.goto(`${BASE}/t/${MIXED}`)
t = await textOf(page)
ok('winners on top', /Winners[\s\S]*beat[\s\S]*in the final/i.test(t), t.slice(0, 300))
ok('header says finished', /finished \d\d:\d\d/i.test(t))
ok('final table, no cut line', /Final table/i.test(t) && !/play the final/i.test(t))
ok('every match played is listed', /Played\s*7/i.test(t))
await shot(page, 'public-finished')

console.log('\n3. the venue Today page')
res = await page.goto(`${BASE}/`)
ok('answers with no set-cookie', !res.headers()['set-cookie'])
t = await textOf(page)
ok('header names the day and both tournaments', /Today[\s\S]*Men's Doubles · Mixed Doubles/i.test(t), t.slice(0, 200))
ok('every court is on it', /Court 1[\s\S]*Court 2[\s\S]*Court 3[\s\S]*Court 4/i.test(t))
ok('courts 1 and 2 have matches, 3 and 4 are free', /Court 1[\s\S]*against[\s\S]*Court 2[\s\S]*against[\s\S]*Court 3\s*Free[\s\S]*Court 4\s*Free/i.test(t))
ok('links to both tournaments', /Men's Doubles — table & results/i.test(t) && /Mixed Doubles — final table & results/i.test(t))
await shot(page, 'today')
const versionRes = await page.request.get(`${BASE}/api/public/today/version`)
ok('today version endpoint answers a number', /"v":\d+/i.test(await versionRes.text()))

// ── organiser ────────────────────────────────────────────────────────────────
const adm = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const a = await adm.newPage()
watch(a)

console.log('\n4. sign in')
await a.goto(`${BASE}/login`)
await a.fill('#pin', '123456')
await a.click('button[type=submit]')
await a.waitForURL(/\/admin/, { timeout: 20000 })
if (a.url().includes('/admin/account')) {
  await a.fill('#current', '123456')
  await a.fill('#next', PIN)
  await a.fill('#confirm', PIN)
  await a.click('button[type=submit]')
  await a.waitForURL(/\/admin$/, { timeout: 20000 })
}
ok('on the dashboard', a.url().endsWith('/admin'))

console.log('\n5. More')
await a.goto(`${BASE}/admin/t/${MENS}/more`)
t = await textOf(a)
for (const label of [
  'Fix a score that’s already in',
  'A pair has pulled out',
  'Swap a player',
  'Change the courts',
  'Change the order of play',
  'Shorten what’s left',
  'Pause the tournament',
  'Add or remove players',
  'Delete this tournament',
]) ok(`lists "${label}"`, t.includes(label))
await shot(a, 'more')

console.log('\n6. fix a score')
await a.click('a:has-text("Fix a score")')
await a.waitForURL(/do=fix/)
t = await textOf(a)
ok('lists the played matches, newest first', /Round 3[\s\S]*Round 1/i.test(t) && /beat/i.test(t))
await shot(a, 'more-fix')
await a.click('a[href^="/admin/m/"]')
await a.waitForURL(/\/admin\/m\//, { timeout: 20000 })
ok('opens score entry', /\/admin\/m\//i.test(a.url()))

console.log('\n7. a pair has pulled out')
await a.goto(`${BASE}/admin/t/${MENS}/more?do=withdraw`)
t = await textOf(a)
ok('asks who', /Who’s pulled out\?/i.test(t))
ok('lists the pairs with Tap', /Suresh Babu[\s\S]*Ganesh Iyer[\s\S]*Tap/i.test(t))
await shot(a, 'more-withdraw')
// Suresh / Ganesh are on Court 2 right now — the page must say so.
await a.click('a:has-text("Suresh Babu")')
await a.waitForURL(/team=/)
t = await textOf(a)
ok('a pair on court is refused with the reason', /is on court right now/i.test(t), t.slice(-300))
await shot(a, 'more-withdraw-blocked')
// Deepak / Bala have played 3 and have 2 left, none on court.
await a.click('a:has-text("Deepak Raj")')
// The URL already has a team in it, so wait for the card itself.
await a.locator('text=Deepak Raj / Bala Murugan pull out').waitFor({ timeout: 20000 })
t = await textOf(a)
ok('the confirm says what happens, with the numbers', /Deepak Raj \/ Bala Murugan pull out[\s\S]*The 3 matches they played stand\. The 2 they had left become walkovers to the other pair/i.test(t), t.slice(-500))
await shot(a, 'more-withdraw-confirm')
await a.click('button:has-text("Yes, they’re out")')
await a.waitForURL(/\/more\?done=/, { timeout: 20000 })
t = await textOf(a)
ok('back on the list with a sentence', /Deepak Raj \/ Bala Murugan are out\. 2 matches become walkovers/i.test(t), t.slice(0, 300))
await shot(a, 'more-withdrawn')
await a.goto(`${BASE}/admin/t/${MENS}/more?do=withdraw`)
t = await textOf(a)
ok('the pair now reads Out', /Deepak Raj[\s\S]*Bala Murugan[\s\S]*Out/i.test(t))
await a.click('a:has-text("Deepak Raj")')
await a.locator('text=Deepak Raj / Bala Murugan go back in').waitFor({ timeout: 20000 })
t = await textOf(a)
ok('and offers to put them back', /Put them back/i.test(t))
await a.click('button:has-text("Put them back")')
await a.waitForURL(/\/more\?done=/, { timeout: 20000 })
t = await textOf(a)
ok('put back, walkovers undone', /are back in\. 2 walkovers are undone/i.test(t), t.slice(0, 300))

console.log('\n8. the public page shows the walkover came and went')
await page.goto(`${BASE}/t/${MENS}`)
t = await textOf(page)
ok('still 7 played', /7 of 16 played/i.test(t))

console.log('\n9. swap a player')
await a.goto(`${BASE}/admin/t/${MENS}/more?do=swap`)
t = await textOf(a)
ok('the form is there', /Who is coming out[\s\S]*Who is going in/i.test(t))
await shot(a, 'more-swap')

console.log('\n10. shorten')
await a.goto(`${BASE}/admin/t/${MENS}/more?do=shorten`)
t = await textOf(a)
ok('a match is on court, so not yet', /A match is on court/i.test(t), t.slice(0, 300))
await shot(a, 'more-shorten')

console.log('\n11. pause')
await a.goto(`${BASE}/admin/t/${MENS}/more?do=pause`)
await a.fill('#pause-note', 'Rain — back at three')
await a.click('button:has-text("Stop the day")')
await a.waitForURL(/\/more\?done=/, { timeout: 20000 })
t = await textOf(a)
ok('the list now offers Start again', /Start again/i.test(t))
await shot(a, 'more-paused')
await page.goto(`${BASE}/t/${MENS}`)
t = await textOf(page)
ok('the public page says the day is stopped', /The day is stopped[\s\S]*Rain — back at three/i.test(t))
await shot(page, 'public-paused')
await page.goto(`${BASE}/`)
t = await textOf(page)
ok('and so does Today', /The day is stopped[\s\S]*Men's Doubles — Rain — back at three/i.test(t))
await shot(page, 'today-paused')
await a.goto(`${BASE}/admin/t/${MENS}/more?do=pause`)
await a.click('button:has-text("Start the day again")')
await a.waitForURL(/\/more\?done=/, { timeout: 20000 })
await page.goto(`${BASE}/t/${MENS}`)
ok('resumed', !/The day is stopped/i.test(await textOf(page)))

console.log('\n12. results list')
await a.goto(`${BASE}/admin/t/${MENS}/results`)
t = await textOf(a)
ok('all 16, grouped by round', /7 of 16 played/i.test(t) && /Round 1[\s\S]*Round 5[\s\S]*Final/i.test(t), t.slice(0, 200))
ok('says which are on court and which not played', /on Court 1 now/i.test(t) && /on Court 2 now/i.test(t) && /not played yet/i.test(t))
ok('scores on the played ones', /11–7, 11–9/i.test(t))
await shot(a, 'results')
const links = await a.$$eval('a[href^="/admin/m/"]', (as) => as.length)
ok('played and live rows link to score entry', links >= 9, String(links))

console.log('\n13. delete')
await a.goto(`${BASE}/admin/t/${MENS}/more?do=delete`)
t = await textOf(a)
ok('refused while a match is on court', /There is a match on Court \d right now/i.test(t), t.slice(-300))
await shot(a, 'more-delete-blocked')
await a.goto(`${BASE}/admin/t/${MIXED}/more?do=delete`)
t = await textOf(a)
ok('the finished one says what goes', /Its 8 players and 7 matches go with it\. Court 3 comes free/i.test(t), t.slice(-300))
await shot(a, 'more-delete')
await a.click('button:has-text("Yes, delete it")')
await a.waitForURL(/\/admin$/, { timeout: 20000 })
t = await textOf(a)
ok('gone from the dashboard', !/Mixed Doubles/i.test(t))
await shot(a, 'dashboard-after-delete')
await page.goto(`${BASE}/t/${MIXED}`)
ok('its public page is gone', /nothing at this link/i.test(await textOf(page)))
await page.goto(`${BASE}/`)
t = await textOf(page)
ok('Today no longer lists it, Court 3 is free', !/Mixed Doubles/i.test(t) && /Court 3\s*Free/i.test(t))
await a.goto(`${BASE}/admin/new`)
await a.click('button:has-text("Mixed")')
const c3 = await a.$eval('button:has-text("Court 3")', (b) => b.disabled)
ok('Court 3 can be picked for a new tournament', c3 === false)
await shot(a, 'new-court-free')

ok('no 5xx anywhere', bad.length === 0, bad.join(' '))
await browser.close()
console.log(fails.length ? `\n${fails.length} failed:\n  ${fails.join('\n  ')}` : '\nall good')
process.exit(fails.length ? 1 : 0)
