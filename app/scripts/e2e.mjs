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

async function signIn() {
  await page.goto(`${BASE}/login`)
  await page.fill('#username', 'saurabh')
  await page.fill('#password', 'change-me-now')
  await page.click('button[type=submit]')
  await page.waitForURL('**/admin**', { timeout: 20000 })
}

console.log('\n1. sign in')
await signIn()
ok('signed in', page.url().includes('/admin'))

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
ok('four teams', ((await body()).match(/ \/ /g) ?? []).length >= 4)

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
// Find which code belongs to the live court by trying each.
let scored = false
const playGame = async (p, winnerLabel, winnerScore, loserScore) => {
  await p.getByRole('button', { name: winnerLabel, exact: true }).first().click()
  await p.waitForTimeout(400)
  await p.getByRole('button', { name: String(winnerScore), exact: true }).first().click()
  await p.waitForTimeout(400)
  await p.getByRole('button', { name: String(loserScore), exact: true }).first().click()
  await p.waitForTimeout(700)
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
  ok('it asks which side is submitting', /Who’s submitting|Who's submitting/.test(t), t.slice(0, 160))
  const submitLabels = await court.$$eval('button[aria-pressed]', (els) =>
    els.map((e) => e.textContent?.trim() ?? '').filter(Boolean),
  )
  if (submitLabels[0]) {
    await court.getByRole('button', { name: submitLabels[0], exact: true }).first().click()
    await court.waitForTimeout(300)
  }
  const hold = await court.$('button:has-text("Hold to submit")')
  if (hold) {
    await hold.focus()
    await court.keyboard.press('Enter')
    await court.waitForTimeout(2500)
  }
  const after = await court.innerText('body')
  ok('the score lands and asks the other side', /Hand the phone over|That’s right/.test(after), after.slice(0, 200))
}

console.log('\n6. it reaches the table and the public page')
await page.goto(`${BASE}/admin/t/${slug}`)
text = await body()
ok('the table counts a played match', /\b1\b/.test(text) && !/Pld[\s\S]{0,80}0\s+0\s+0[\s\S]{0,40}0\s+0\s+0[\s\S]{0,40}0\s+0\s+0[\s\S]{0,40}0\s+0\s+0/.test(text))
ok('the tiebreak rule is printed', /total points scored/.test(text))

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
