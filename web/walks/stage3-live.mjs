/**
 * Walks the live board in a real browser: two tournaments started, the
 * matches going on by themselves, a score entered, a match moved, a court
 * added from the board, an overrun, a pause, and the board updating on its
 * own from a second phone. Screenshots go to /tmp/shots-live/.
 *
 *   BASE=http://localhost:3403 node scripts/stage3-live.mjs
 *
 * Expects a fresh database seeded with scripts/seed-live.ts (two tournaments
 * on today, not started) and the organiser on the temporary PIN 123456. Set
 * PIN=482913 to skip the first-sign-in change when the PIN is already set.
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

const BASE = process.env.BASE ?? 'http://localhost:3403'
const DB = process.env.DATABASE_URL ?? 'postgres://postgres@localhost:5433/mpb_live'
const NEW_PIN = '482913'
const EXE = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
const OUT = process.env.OUT ?? '/tmp/shots-live'
mkdirSync(OUT, { recursive: true })

const psql = (sql) =>
  execSync(`psql "${DB}" -At -c "${sql.replace(/"/g, '\\"')}"`, { encoding: 'utf8' }).trim()

const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ['--no-sandbox'] })
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
const page = await ctx.newPage()

// The page fetches its data after it paints; wait until nothing is in flight
// (the app writes the count onto <html data-pending>) before reading it. Look
// after a frame, never at once: a client-side navigation changes the URL
// before React has rendered the screen it leads to, so data-pending still
// reads "0" from the screen being left.
const settle = async (p = page) => {
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {})
  await p
    .waitForFunction(() => document.documentElement.dataset.pending === '0', null, { timeout: 20000 })
    .catch(() => {})
}
page.on('pageerror', (e) => console.log('   pageerror:', e.message.slice(0, 160)))
const bad = []
page.on('response', (r) => {
  if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`)
})

const fails = []
const ok = (l, c, extra = '') =>
  c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l} ${extra}`))
const body = async (p = page) => { await settle(p); return p.evaluate(() => document.body.textContent ?? '') }
let n = 0
const shot = async (name, p = page) => {
  n += 1
  await p.waitForLoadState('networkidle').catch(() => {})
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${OUT}/live-${String(n).padStart(2, '0')}-${name}.png`, fullPage: true })
}

/** The text of each court card, keyed by court name. */
async function cards(p = page) {
  // Settle first: a click that lands back on the board is a client-side
  // navigation, so `networkidle` is already true before the new screen has
  // asked for its data.
  await settle(p)
  return p.evaluate(() => {
    const out = {}
    for (const el of document.querySelectorAll('[data-court]')) {
      const name = el.querySelector('.text-eyebrow')?.textContent?.trim() ?? '?'
      out[name] = el.textContent ?? ''
    }
    return out
  })
}

/** The two team names on a court card, or null when nothing is on it. */
async function onCourt(courtName, p = page) {
  await settle(p)
  return p.evaluate((courtName) => {
    for (const el of document.querySelectorAll('[data-court]')) {
      const name = el.querySelector('.text-eyebrow')?.textContent?.trim()
      if (name !== courtName) continue
      const link = el.querySelector('a[href^="/admin/m/"]')
      if (!link) return null
      const names = [...el.querySelectorAll('.text-row')].map((x) => x.textContent?.trim()).filter(Boolean)
      return { href: link.getAttribute('href'), names: names.join(' / ') }
    }
    return null
  }, courtName)
}

/**
 * A form action that redirects back to the page it is on resolves
 * `waitForURL` at once, before the action has run. Wait for the answer to
 * arrive instead: poll until `cond` holds, up to ten seconds.
 */
async function until(cond, p = page) {
  for (let i = 0; i < 40; i++) {
    if (await cond()) return true
    await p.waitForTimeout(250)
  }
  return false
}

async function signIn(p) {
  await p.goto(`${BASE}/login`)
  const pin = process.env.PIN ?? '123456'
  await p.fill('#pin', pin)
  await p.click('button[type=submit]')
  await p.waitForURL(/\/admin/, { timeout: 30000 })
  if (p.url().includes('/admin/account')) {
    await p.fill('#current', pin)
    await p.fill('#next', NEW_PIN)
    await p.fill('#confirm', NEW_PIN)
    await p.click('button[type=submit]')
    await p.waitForURL(/\/admin$/, { timeout: 30000 })
  }
}

/** Enter 11–7, 11–9 to side A on the score screen at `href`. */
async function enterScore(p, href) {
  await p.goto(`${BASE}${href}`, { waitUntil: 'networkidle' })
  for (const game of [1, 2]) {
    const head = p.locator(`h2:has-text("Who won game ${game}?")`)
    await head.waitFor({ timeout: 20000 })
    // The first SideButton under the question is side A.
    await head.locator('xpath=following-sibling::div[1]/button[1]').click()
    await p.locator('button[aria-label$=" scored 11"]').first().click()
    await p.locator(`button[aria-label$=" scored ${game === 1 ? 7 : 9}, and that finishes the game"]`).click()
    await p.waitForTimeout(300)
  }
  const hold = p.locator('button:has-text("Hold to save the result")')
  await hold.waitFor({ timeout: 20000 })
  await hold.focus()
  await p.keyboard.press('Enter')
  await p.waitForTimeout(150)
  await p.keyboard.press('Enter')
}

// ─────────────────────────────────────────────────────────────────────────

console.log('\n1. sign in')
await signIn(page)
ok('signed in and on the dashboard', page.url().endsWith('/admin'))

console.log('\n2. find the two tournaments')
await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' })
const links = await page.$$eval('a[href^="/admin/t/"]', (as) =>
  as.map((a) => ({ href: a.getAttribute('href'), text: a.textContent ?? '' })),
)
const mens = links.find((l) => /Men's Doubles/.test(l.text))?.href.split('/admin/t/')[1]
const mixed = links.find((l) => /Mixed Doubles/.test(l.text))?.href.split('/admin/t/')[1]
ok('both seeded tournaments are on the dashboard', !!mens && !!mixed, JSON.stringify(links))
await shot('dashboard')

console.log('\n3. the board before anything has started')
await page.goto(`${BASE}/admin/live`, { waitUntil: 'networkidle' })
let c = await cards()
ok('four court cards', Object.keys(c).length === 4, Object.keys(c).join(','))
ok('nothing running yet', /nothing running/.test(await body()))
ok('Courts 1–3 say their tournament has not started', /hasn’t started yet/.test(c['Court 1'] ?? '') && /hasn’t started yet/.test(c['Court 3'] ?? ''))
ok('Court 4 is not assigned', /Not assigned/.test(c['Court 4'] ?? ''))
await shot('board-before-start')

console.log("\n4. start Men's — its two courts fill by themselves")
await page.goto(`${BASE}/admin/t/${mens}`, { waitUntil: 'networkidle' })
await page.click('button:has-text("Start the tournament")')
await page.waitForURL(/\/admin\/live$/, { timeout: 30000 })
ok('Start lands on the live board', page.url().endsWith('/admin/live'))
await page.waitForLoadState('networkidle')
c = await cards()
const c1 = await onCourt('Court 1')
const c2 = await onCourt('Court 2')
ok('Court 1 has a match on it straight away', !!c1, c['Court 1'])
ok('Court 2 has a match on it straight away', !!c2, c['Court 2'])
ok('and they are different matches', !!c1 && !!c2 && c1.href !== c2.href)
ok('both show what comes next', /Next here:/.test(c['Court 1'] ?? '') && /Next here:/.test(c['Court 2'] ?? ''))
ok('the pill counts two on court', /2 on court/.test(await body()))
ok("the strip has Men's 0 of 16 with a finish estimate", /Men's 0 of 16 · about \d\d:\d\d/.test(await body()), (await body()).slice(0, 300))
ok("Court 4 offers itself to Men's", /Men's has \d+ to play and a court sitting empty/.test(c['Court 4'] ?? '') && /Add Court 4 to Men's Doubles/.test(c['Court 4'] ?? ''), c['Court 4'])
ok('Court 3 still says Mixed has not started', /hasn’t started yet/.test(c['Court 3'] ?? ''))
await shot('board-mens-started')

console.log('\n5. start Mixed — Court 3 fills')
await page.goto(`${BASE}/admin/t/${mixed}`, { waitUntil: 'networkidle' })
await page.click('button:has-text("Start the tournament")')
await page.waitForURL(/\/admin\/live$/, { timeout: 30000 })
await page.waitForLoadState('networkidle')
c = await cards()
const c3 = await onCourt('Court 3')
ok('Court 3 has a match on it', !!c3, c['Court 3'])
ok('three on court', /3 on court/.test(await body()))
ok('2 tournaments running', /2 tournaments running/.test(await body()))
ok('strip shows both', /Mixed 0 of 7/.test(await body()))
await shot('board-both-running')

console.log('\n6. the old per-tournament board redirects')
await page.goto(`${BASE}/admin/t/${mens}/board`)
// The redirect streams in after the layout's header, so it lands a beat later.
await page.waitForURL(/\/admin\/live$/, { timeout: 30000 }).catch(() => {})
ok('/admin/t/[slug]/board → /admin/live', page.url().endsWith('/admin/live'))
await page.waitForLoadState('networkidle')

console.log('\n7. a score on Court 1 — the next match goes on by itself')
const before1 = await onCourt('Court 1')
await page.goto(`${BASE}${before1.href}`, { waitUntil: 'networkidle' })
ok('the score screen links back to the live board', await page.$('a[href="/admin/live"]') !== null)
await shot('score-entry')
await enterScore(page, before1.href)
await page.waitForURL(/\/admin\/live$/, { timeout: 30000 })
const t0 = Date.now()
await page.waitForLoadState('networkidle')
const after1 = await onCourt('Court 1')
ok('saving goes straight back to the board', page.url().endsWith('/admin/live'))
ok('Court 1 has the next match on it, on its own', !!after1 && after1.href !== before1.href, JSON.stringify({ before1, after1 }))
ok('and it was there within a second of landing', Date.now() - t0 < 1500)
ok("the strip says Men's 1 of 16", /Men's 1 of 16/.test(await body()))
await shot('board-after-score')

console.log("\n8. move Court 2's match")
const before2 = await onCourt('Court 2')
await page.click('[data-court]:has(.text-eyebrow:text-is("Court 2")) a:has-text("Move")')
await page.waitForURL(/\/admin\/live\/move\//, { timeout: 30000 })
let t = await body()
ok('the move screen names the match', /Move this match/.test(t))
ok('Court 1 is listed, busy and greyed', /Court 1.*busy — .*(on for \d+ min|just started)/.test(t), t.slice(0, 400))
ok('Court 3 — the other tournament — is not on the list at all', !/Court 3/.test(t))
ok('Court 4 — nobody’s — is not on the list either', !/Court 4/.test(t))
ok('Back to the queue is offered', /Back to the queue/.test(t))
const pickable = await page.$$eval('form button', (bs) => bs.map((b) => b.textContent?.trim() ?? ''))
ok('the only pick is the queue', pickable.length === 1 && /Back to the queue/.test(pickable[0]), JSON.stringify(pickable))
await shot('move')
await page.click('button:has-text("Back to the queue")')
await page.waitForURL(/\/admin\/live$/, { timeout: 30000 })
await page.waitForLoadState('networkidle')
const after2 = await onCourt('Court 2')
c = await cards()
ok('Court 2 has a different match on it now — the next in order flowed on', !!after2 && after2.href !== before2.href, JSON.stringify({ before2, after2 }))
const movedNames = before2.names.split(' / ').map((s) => s.split(' ')[0])
ok('the match that came off is next somewhere', new RegExp(`Next here: .*${movedNames[0]}`).test(c['Court 1'] + c['Court 2']), (c['Court 1'] ?? '') + (c['Court 2'] ?? ''))
await shot('board-after-move')

console.log("\n9. add Court 4 to Men's from the board")
await page.click('button:has-text("Add Court 4 to Men\'s Doubles")')
await until(async () => !!(await onCourt('Court 4')))
const c4 = await onCourt('Court 4')
ok('Court 4 has a match on it', !!c4, (await cards())['Court 4'])
ok('four on court', /4 on court/.test(await body()))
await shot('board-court-4-added')

console.log('\n10. the Move list for a Men\'s match now has three Men\'s courts, never Court 3')
const c1now = await onCourt('Court 1')
await page.goto(`${BASE}/admin/live/move/${c1now.href.split('/admin/m/')[1]}`, { waitUntil: 'networkidle' })
t = await body()
ok('Court 2 and Court 4 are listed', /Court 2/.test(t) && /Court 4/.test(t))
ok('Court 3 is not', !/Court 3/.test(t))

console.log('\n11. a match sitting 55 minutes shows the overrun line')
const staleId = c1now.href.split('/admin/m/')[1]
psql(`update matches set started_at = now() - interval '55 minutes' where id = '${staleId}'`)
await page.goto(`${BASE}/admin/live`, { waitUntil: 'networkidle' })
c = await cards()
ok('the warning is on Court 1', /On for 5\d min and no score — did they finish\?/.test(c['Court 1'] ?? ''), c['Court 1'])
ok('and the button says Enter it for them', /Enter it for them/.test(c['Court 1'] ?? ''))
await shot('board-overrun')
psql(`update matches set started_at = now() where id = '${staleId}'`)

console.log('\n12. a paused tournament says so on its court, with the way out')
// paused_at is what the old schema called break_starts_at.
psql(`update tournaments set pause_note = 'rain', paused_at = now() where slug = '${mixed}'`)
// Take the Mixed match off court so the paused card is the empty one from the mockup.
const mixedLive = await onCourt('Court 3')
await page.goto(`${BASE}/admin/live/move/${mixedLive.href.split('/admin/m/')[1]}`, { waitUntil: 'networkidle' })
await page.click('button:has-text("Back to the queue")')
await page.waitForURL(/\/admin\/live$/, { timeout: 30000 })
await page.waitForLoadState('networkidle')
c = await cards()
ok('the board says Mixed is paused — rain', /Mixed Doubles.* is paused/i.test(await body()) && /rain/.test(await body()), (await body()).slice(0, 400))
ok('nothing went on while paused', !(await onCourt('Court 3')))
ok('it still says what is next', /Next here:/.test(c['Court 3'] ?? ''))
ok('the strip says Mixed paused', /Mixed paused/.test(await body()))
await shot('board-paused')
await page.click('button:has-text("Start again")')
await until(async () => !!(await onCourt('Court 3')))
ok('Start again fills Court 3 again', !!(await onCourt('Court 3')), (await cards())['Court 3'])
ok('and the strip is back to a count', /Mixed 0 of 7/.test(await body()))

console.log('\n13. the board updates on its own from a second phone')
const ctx2 = await browser.newContext({ viewport: { width: 390, height: 844 } })
const phone2 = await ctx2.newPage()
process.env.PIN = NEW_PIN
await signIn(phone2)
await page.goto(`${BASE}/admin/live`, { waitUntil: 'networkidle' })
const watched = await onCourt('Court 3')
await enterScore(phone2, watched.href)
await phone2.waitForURL(/\/admin\/live$/, { timeout: 30000 })
let changed = null
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(1000)
  const now = await onCourt('Court 3')
  if (!now || now.href !== watched.href) {
    changed = { after: (i + 1), now }
    break
  }
}
ok('the first phone saw Court 3 change without being touched', !!changed, 'still ' + JSON.stringify(watched))
if (changed) console.log(`        (took about ${changed.after}s)`)
ok('and the strip moved to Mixed 1 of 7', /Mixed 1 of 7/.test(await body()))
await shot('board-auto-refreshed')
await ctx2.close()

console.log('\n14. desktop width')
await page.setViewportSize({ width: 1024, height: 900 })
await page.goto(`${BASE}/admin/live`, { waitUntil: 'networkidle' })
await shot('board-desktop')

console.log('\n')
ok('no server errors during the walk', bad.length === 0, bad.join('\n'))
await browser.close()
console.log(fails.length ? `\n${fails.length} failed:\n  - ${fails.join('\n  - ')}` : '\nall passed')
process.exit(fails.length ? 1 : 0)
