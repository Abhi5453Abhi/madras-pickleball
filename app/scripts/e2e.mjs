/**
 * Drives a whole tournament in a real browser: sign in, Quick Play, send a
 * match to a court, score it from the court QR, confirm it at the net, and
 * check the table and the bracket react.
 *
 *   BASE=http://localhost:3200 node scripts/e2e.mjs
 */
import { chromium } from 'playwright-core'

const BASE = process.env.BASE ?? 'http://localhost:3200'
const CHROME_CANDIDATES = [
  process.env.CHROME,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)
const { existsSync } = await import('node:fs')
const EXE = CHROME_CANDIDATES.find((p) => existsSync(p))
if (!EXE) {
  console.error('No Chrome found. Set CHROME=/path/to/chrome')
  process.exit(1)
}
const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => console.log('   pageerror:', e.message.slice(0, 160)))

const fails = []
const ok = (l, c, extra = '') =>
  c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l} ${extra}`))
const body = () => page.innerText('body')

const PASSWORD = 'e2e-real-password-1'

async function signIn(username = 'saurabh', password = PASSWORD) {
  await page.context().clearCookies()
  await page.goto(`${BASE}/login`)
  await page.fill('#username', username)
  await page.fill('#password', password)
  await page.click('button[type=submit]')
  await page.waitForURL(/\/(admin|umpire)/, { timeout: 20000 })
}

console.log('\n1. sign in')
await page.goto(`${BASE}/login`)
await page.fill('#username', 'saurabh')
await page.fill('#password', 'change-me-now')
await page.click('button[type=submit]')
await page.waitForURL(/\/(admin|umpire)/, { timeout: 20000 })
ok('signed in', /\/admin|\/umpire/.test(page.url()))

// A temporary password opens exactly one door.
ok('a temporary password lands on the change-password screen', page.url().includes('/admin/account'))
await page.goto(`${BASE}/admin/quick`)
ok(
  'and it cannot be walked around',
  page.url().includes('/admin/account'),
  page.url(),
)

console.log('\n1b. replace the temporary password')
await page.goto(`${BASE}/admin/account`)
{
  const pw = await page.$$('input[type=password]')
  ok('the change form is there', pw.length >= 2, `saw ${pw.length}`)
  await pw[0].fill('change-me-now')
  await pw[1].fill(PASSWORD)
  if (pw[2]) await pw[2].fill(PASSWORD)
  await page.click('button[type=submit]')
  await page.waitForTimeout(2500)
}
await signIn()
ok('the new password works and the block is gone', !page.url().includes('/admin/account'))

console.log('\n2. quick play')
await page.goto(`${BASE}/admin/quick`)
await page.fill('#name', 'E2E Cup')
await page.fill(
  '#players',
  ['Ana One', 'Ben Two', 'Cara Three', 'Dev Four', 'Eve Five', 'Fin Six', 'Gia Seven', 'Hal Eight'].join('\n'),
)
await page.waitForFunction(() => document.body.innerText.includes('8 players'), null, { timeout: 10000 })
await Promise.all([
  page.waitForURL('**/admin/t/**', { timeout: 30000 }).catch(() => {}),
  page.click('button[type=submit]'),
])
const slug = page.url().split('/admin/t/')[1]
ok('tournament created', !!slug, page.url())
// Team names are stacked one player per line now, so count table rows rather
// than looking for "A / B" in the text.
{
  const rows = await page.$$eval('table tbody tr', (els) => els.length).catch(() => 0)
  const text = await body()
  ok('four teams', rows >= 4 || /4 pairs/.test(text), `rows=${rows}`)
}

console.log('\n3. court board')
await page.goto(`${BASE}/admin/t/${slug}/board`)
let text = await body()
const courtCards = await page.$$('[data-court]')
ok('board lists four courts', courtCards.length === 4, `saw ${courtCards.length}`)
ok('an idle court offers the next match', /Send to Court/.test(text))

const sendBtn = await page.$('button:has-text("Send to Court")')
await sendBtn.click()
await page.waitForTimeout(2500)
text = await body()
ok('a match went live', /LIVE/i.test(text))
ok('conflict detection names a blocked player', /is on Court/i.test(text), text.slice(0, 200))

console.log('\n4. court cards')
await page.goto(`${BASE}/admin/t/${slug}/cards`)
await page.click('button:has-text("Make the cards")')
await page.waitForFunction(() => document.body.innerText.includes('shown once'), null, { timeout: 20000 })
const codes = (await body()).match(/\b[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}\b/g) ?? []
ok('a code per court', codes.length === 4, `got ${codes.length}`)

console.log('\n5. score from the court QR, with no account')
const anon = await browser.newContext({ viewport: { width: 390, height: 844 } })
const court = await anon.newPage()
// A thrown server action shows as a 500 on the wire and a friendly-looking
// message on screen. Watch the wire.
const errors = []
court.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 120)}`))
court.on('response', (r) => {
  if (r.status() >= 500) errors.push(`${r.status()} ${r.url().slice(0, 80)}`)
})
// Find which code belongs to the live court by trying each.
let scored = false
// The winning score is pre-selected once a side is picked, so the middle tap
// is only needed when the target isn't the one we want. Chips carry a spoken
// accessible name ("Hal Eight / Eve Five scored 7"), so they are matched on
// their visible text rather than by role name.
const chip = (p, n) => p.locator('button').filter({ hasText: new RegExp(`^${n}$`) }).first()

const playGame = async (p, winnerLabel, winnerScore, loserScore) => {
  await p.locator('button').filter({ hasText: winnerLabel }).first().click()
  await p.waitForTimeout(500)
  const target = chip(p, winnerScore)
  if ((await target.count()) && (await target.getAttribute('aria-pressed')) !== 'true') {
    await target.click()
    await p.waitForTimeout(400)
  }
  const loser = chip(p, loserScore)
  if (!(await loser.count())) {
    console.log('   DEBUG body:', (await p.innerText('body')).slice(0, 900))
    throw new Error(`no chip for ${loserScore}`)
  }
  await loser.click()
  await p.waitForTimeout(800)
}

for (const code of codes) {
  await court.goto(`${BASE}/c/${code}`)
  const t = await court.innerText('body')
  if (!/Who won game 1/.test(t)) continue

  // Whoever is listed first wins in straight games.
  const sideLabels = await court.$$eval('button[aria-pressed]', (els) =>
    els.map((e) => e.textContent?.trim() ?? '').filter(Boolean),
  )
  const winner = sideLabels[0]
  await playGame(court, winner, 11, 7)
  await playGame(court, winner, 11, 9)
  scored = true
  break
}

ok('the QR opens the scoreboard with no login', scored)

if (scored) {
  const t = await court.innerText('body')
  ok(
    'it asks which side is sending it',
    /putting this in|submitting|Hold your own name/i.test(t),
    t.slice(0, 300),
  )
  // Submitting-side and commitment are one control: a hold button per team.
  const holds = await court.$$('button:has-text("Hold")')
  ok('there is something to hold', holds.length > 0, t.slice(0, 300))
  if (holds.length) {
    await holds[0].focus()
    await court.keyboard.press('Enter')
    await court.waitForTimeout(3000)
  }
  const after = await court.innerText('body')
  ok(
    'the score lands and asks the other pair',
    /Hand the phone|That’s right|That's right/i.test(after),
    after.slice(0, 400),
  )
  // Assert the RESULT, not the wording. A server action that throws renders a
  // plausible-looking screen; the only proof a score was recorded is that the
  // public page is showing it.
  await page.goto(`${BASE}/t/${slug}`, { waitUntil: 'networkidle' })
  const published = await page.evaluate(() => document.body.textContent ?? '')
  ok('and the score is actually recorded', /11–7|11-7/.test(published), published.slice(0, 400))
  ok('with no server error on the court screen', errors.length === 0, errors.join(' | '))
}

console.log('\n6. it reaches the table and the public page')
await page.goto(`${BASE}/admin/t/${slug}`)
text = await body()
ok('the table counts a played match', /\b1\b/.test(text) && !/Pld[\s\S]{0,80}0\s+0\s+0[\s\S]{0,40}0\s+0\s+0[\s\S]{0,40}0\s+0\s+0[\s\S]{0,40}0\s+0\s+0/.test(text))
// The rule lives in a disclosure now — said once, where someone losing an
// argument will look — so read the DOM, not just what is on screen.
ok(
  'the tiebreak rule is printed',
  /total points scored/.test(await page.evaluate(() => document.body.textContent ?? '')),
)

await page.goto(`${BASE}/t/${slug}`)
text = await body()
ok('the public page shows the tournament', /E2E Cup/.test(text))
ok('find my match is the first thing', /Find my match/.test(text))
ok('a result is published', /Results/.test(text))

console.log('\n7. results desk')
await page.goto(`${BASE}/admin/t/${slug}/results`)
text = await body()
ok('the results desk lists what is outstanding', /No score yet/.test(text))

await anon.close()
await browser.close()
console.log(fails.length ? `\n${fails.length} FAILING\n` : '\nall end-to-end checks passed\n')
process.exit(fails.length ? 1 : 0)
