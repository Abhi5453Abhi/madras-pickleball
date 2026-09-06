/**
 * The organiser's whole day, through the real UI and nothing else: sign in,
 * make a tournament, six people sign up through the link and two are added by
 * hand, a duplicate is settled, sign-ups close, the pairs are made, the
 * schedule is made, the tournament starts, every score goes in through the
 * score screen, the final appears by itself, the tournament is finished, and
 * the public pages show the record. Screenshots go to /tmp/shots-e2e/.
 *
 *   BASE=http://localhost:3200 node scripts/e2e.mjs
 *
 * Expects a fresh database (scripts/setup.ts) with the organiser on the
 * temporary PIN 123456; signs in with 482913 instead when the PIN has already
 * been changed. No seed scripts, no SQL.
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3200'
const TEMP_PIN = '123456'
const PIN = '482913'
const EXE = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
]
  .filter(Boolean)
  .find((p) => existsSync(p))
const OUT = process.env.OUT ?? '/tmp/shots-e2e'
mkdirSync(OUT, { recursive: true })

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }
const DESKTOP = { width: 1280, height: 800 }

const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ['--no-sandbox'] })
const ctx = await browser.newContext(PHONE)
const page = await ctx.newPage()

// ── bookkeeping ─────────────────────────────────────────────────────────────
const fails = []
const bad = []
const pageErrors = []
/** Server time for every document request: url → ms to first byte, ms to end. */
const timings = []
/** Wall-clock time of each timed step, as the organiser would feel it. */
const stepTimes = []
function watch(p, label) {
  p.on('pageerror', (e) => {
    pageErrors.push(`${label}: ${e.message.slice(0, 200)}`)
    console.log('   pageerror:', e.message.slice(0, 160))
  })
  p.on('response', (r) => {
    if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`)
    const req = r.request()
    if (req.resourceType() !== 'document') return
    const t = req.timing()
    if (t && t.responseStart >= 0) {
      timings.push({
        url: r.url().replace(BASE, ''),
        ttfb: Math.round(t.responseStart),
        total: t.responseEnd >= 0 ? Math.round(t.responseEnd) : null,
        method: req.method(),
      })
    }
  })
}
watch(page, 'organiser')

const ok = (l, c, extra = '') =>
  c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l}  ${String(extra).slice(0, 300)}`))

// innerText of <main>, whitespace collapsed: the RSC payload in <script> tags
// repeats every name on the page, and textContent would count them twice.
const body = (p = page) =>
  p.evaluate(() => (document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' '))

let n = 0
const shot = async (name, p = page) => {
  n += 1
  await p.waitForLoadState('networkidle').catch(() => {})
  // A full-page capture prints the sticky header wherever the page happens to
  // be scrolled to; from the top it sits where it belongs.
  await p.evaluate(() => window.scrollTo(0, 0))
  await p.waitForTimeout(350)
  await p.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-${name}.png`, fullPage: true })
}
/** The same screen at a laptop width, then back to the phone. */
const desktopShot = async (name, p = page) => {
  await p.setViewportSize(DESKTOP)
  await p.waitForTimeout(250)
  n += 1
  await p.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-${name}-desktop.png`, fullPage: true })
  await p.setViewportSize(PHONE.viewport)
  await p.waitForTimeout(250)
}
const settle = async (p = page, ms = 400) => {
  await p.waitForLoadState('networkidle').catch(() => {})
  await p.waitForTimeout(ms)
}
/** Wait until the page says something, then hand back all of it. */
const until = async (re, p = page, ms = 20000) => {
  await p
    .waitForFunction(
      ([src, flags]) =>
        new RegExp(src, flags).test((document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' ')),
      [re.source, re.flags],
      { timeout: ms },
    )
    .catch(() => console.log(`   (waited ${ms} ms for /${re.source}/${re.flags} and did not see it)`))
  await settle(p)
  return body(p)
}
/** A wall-clock timer for one step. */
const timed = async (label, fn) => {
  const t0 = Date.now()
  const r = await fn()
  const ms = Date.now() - t0
  stepTimes.push({ label, ms })
  if (ms > 1500) console.log(`   slow  ${label}: ${ms} ms`)
  return r
}

/** The court cards on the live board, keyed by court name. */
async function cards(p = page) {
  return p.evaluate(() => {
    const out = {}
    for (const el of document.querySelectorAll('[data-court]')) {
      const name = el.querySelector('.text-eyebrow')?.textContent?.trim() ?? '?'
      out[name] = (el.innerText ?? '').replace(/\s+/g, ' ')
    }
    return out
  })
}
/** The match on a court: the score link and the two pair names — or null. */
async function onCourt(courtName, p = page) {
  return p.evaluate((courtName) => {
    for (const el of document.querySelectorAll('[data-court]')) {
      const name = el.querySelector('.text-eyebrow')?.textContent?.trim()
      if (name !== courtName) continue
      const link = el.querySelector('a[href^="/admin/m/"]')
      if (!link) return null
      const names = [...el.querySelectorAll('.text-row')].map((x) => x.textContent?.trim()).filter(Boolean)
      const round = el.querySelector('.ml-auto')?.textContent?.trim() ?? ''
      return { href: link.getAttribute('href'), names, round, button: link.textContent?.trim() }
    }
    return null
  }, courtName)
}

/**
 * Enter 11–7, 11–9 to side A the way a thumb does it: tap the winner, tap 11,
 * tap the other side's score, twice, then hold the save button down.
 */
async function enterScore(p = page) {
  for (const game of [1, 2]) {
    const head = p.locator(`h2:has-text("Who won game ${game}?")`)
    await head.waitFor({ timeout: 20000 })
    await head.locator('xpath=following-sibling::div[1]/button[1]').click()
    await p.locator('button[aria-label$=" scored 11"]').first().click()
    await p.locator(`button[aria-label$=" scored ${game === 1 ? 7 : 9}, and that finishes the game"]`).click()
    await p.waitForTimeout(250)
  }
  const hold = p.locator('button:has-text("Hold to save the result")')
  await hold.waitFor({ timeout: 20000 })
  // The screen scrolls the button into view on its own; wait for that to end
  // so the pointer does not slide off it mid-hold.
  await p.waitForTimeout(700)
  await hold.scrollIntoViewIfNeeded()
  const box = await hold.boundingBox()
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  const pressedAt = Date.now()
  await p.mouse.down()
  await p.waitForTimeout(900)
  await p.mouse.up()
  // The hold completes 600 ms in; what is measured is save → board from there.
  return pressedAt + 600
}

// ═══════════════════════════════════════════════════════════════════════════

console.log('\n1. sign in with the temporary PIN, and choose a real one')
await timed('login page', () => page.goto(`${BASE}/login`, { waitUntil: 'networkidle' }))
await shot('login')
await page.fill('#pin', TEMP_PIN)
await page.click('button[type=submit]')
await page.waitForURL(/\/admin|login/, { timeout: 30000 }).catch(() => {})
await settle()
if (page.url().includes('/admin/account')) {
  ok('the temporary PIN lands on the choose-your-PIN screen', true)
  await shot('first-pin')
  await page.fill('#current', TEMP_PIN)
  await page.fill('#next', PIN)
  await page.fill('#confirm', PIN)
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin$/, { timeout: 20000 })
} else if (!page.url().endsWith('/admin')) {
  // A database that has been through this before.
  await page.fill('#pin', PIN)
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin$/, { timeout: 20000 })
}
ok('signed in, on the dashboard', page.url().endsWith('/admin'), page.url())
await settle()
ok('an empty dashboard says so', /Nothing on yet/.test(await body()))
await shot('dashboard-empty')

console.log("\n2. make Men's Doubles on Courts 1 and 2")
await page.click('a:has-text("Make a tournament")')
await page.waitForURL(/\/admin\/new/, { timeout: 20000 })
await page.waitForSelector('#name')
await page.fill('#name', "Men's Doubles")
await page.click('button:has-text("Men\'s")')
await page.click('button:has-text("Doubles")')
await page.click('button:has-text("then the top 2 play a final")')
await page.click('button:has-text("Court 1")')
await page.click('button:has-text("Court 2")')
ok('the note counts two courts', /2 courts picked/.test(await body()))
await shot('new-filled')
await page.click('button:has-text("Create")')
await page.waitForURL(/\/admin\/t\//, { timeout: 30000 })
const slug = page.url().split('/admin/t/')[1].split(/[/?]/)[0]
ok('lands on the tournament page', !!slug, page.url())
await settle()
let t = await body()
ok('the four steps are there', /Registration/.test(t) && /Teams/.test(t) && /Schedule & courts/.test(t) && /Start/.test(t))
ok('registration is the current step, link open', /0 players in · link is open/.test(t), t.slice(0, 300))
ok('schedule step names the courts', /Court 1, Court 2 · schedule not made yet/.test(t))
await shot('hub-setup-empty')
await desktopShot('hub-setup-empty')
const HUB = `${BASE}/admin/t/${slug}`
const REG = `${HUB}/registration`

console.log('\n3. registration')
await timed('registration page', () => page.goto(REG, { waitUntil: 'networkidle' }))
t = await body()
ok('registration header: 0 in · sign-ups open', /Registration 0 in · sign-ups open/.test(t), t.slice(0, 200))
const linkMatch = t.match(/\/r\/([0-9A-Z]{5}-[0-9A-Z]{5})/)
ok('the sign-up link is on the page', !!linkMatch, t.slice(0, 300))
const LINK = `${BASE}/r/${linkMatch?.[1]}`
await shot('registration-empty')

/** Somebody signs up from a phone that has never seen the site. */
async function signup(name, partner, phone) {
  const fresh = await browser.newContext(PHONE)
  const p = await fresh.newPage()
  watch(p, `signup ${name}`)
  const res = await p.goto(LINK, { waitUntil: 'networkidle' })
  const setCookie = res.headers()['set-cookie']
  await p.waitForSelector('input[name=name]', { timeout: 20000 })
  await p.fill('input[name=name]', name)
  if (phone) await p.fill('input[name=phone]', phone)
  if (partner) await p.fill('input[name=partnerName]', partner)
  await p.click('button:has-text("Sign me up")')
  await p.waitForFunction(() => /on the list|closed|doesn/.test(document.body.innerText ?? ''), null, { timeout: 20000 }).catch(() => {})
  await settle(p, 200)
  const text = await body(p)
  const cookies = await fresh.cookies()
  ok(`  ${name} is on the list, with no cookie`, /You’re on the list\./.test(text) && cookies.length === 0 && !setCookie, `${text.slice(0, 200)} cookies=${cookies.length} set-cookie=${setCookie}`)
  return { p, fresh, text }
}

{
  // What the first player sees, before anyone is on the list.
  const fresh = await browser.newContext(PHONE)
  const p = await fresh.newPage()
  watch(p, 'signup form')
  await timed('sign-up form', () => p.goto(LINK, { waitUntil: 'networkidle' }))
  const text = await p.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  ok('the form names the tournament and asks name, phone, partner', /Men's Doubles/.test(text) && /Your name/.test(text) && /Playing with someone\?/.test(text) && /Sign me up/.test(text), text.slice(0, 300))
  ok('the footer does not promise the name waits for the schedule', /Your name goes on the public page\. Your phone number never does\./.test(text), text.slice(-200))
  await p.fill('input[name=name]', 'Karthik Subramanian')
  await shot('signup-form', p)
  await fresh.close()
}
const s1 = await signup('Karthik Subramanian', 'Sathish Kumar')
await shot('signup-done', s1.p)
await s1.fresh.close()
for (const [name, partner] of [
  ['Sathish Kumar', 'Karthik Subramanian'],
  ['Ravi Shankar', 'Arun Prakash'],
  ['Arun Prakash', null],
  ['Hari Venkatesh', 'Naveen Krishnan'],
  ['Naveen Krishnan', 'Hari Venkatesh'],
]) {
  const s = await signup(name, partner)
  await s.fresh.close()
}

await page.goto(REG, { waitUntil: 'networkidle' })
t = await body()
ok('6 in through the link', /6 in · sign-ups open/.test(t), t.slice(0, 200))
ok('Ravi wants Arun, resolved to the roster', /Ravi Shankar wants Arun Prakash · via link/.test(t))
ok('Arun named nobody', /Arun Prakash no partner named · via link/.test(t))
await shot('registration-six')

console.log('\n   two added by hand')
await page.fill('[name=text]', 'Deepak Raj 98400 12345')
await page.click('button:has-text("Add")')
t = await until(/Deepak Raj/)
ok('Deepak Raj is on the list · added by you', /Deepak Raj no partner named · added by you/.test(t), t.slice(0, 400))
ok('and the phone number is not shown on the row', !/98400/.test(t))
await page.fill('[name=text]', 'Bala Murugan')
await page.click('button:has-text("Add")')
t = await until(/Bala Murugan/)
ok('Bala Murugan too — 8 in', /8 in · sign-ups open/.test(t) && /Bala Murugan no partner named · added by you/.test(t), t.slice(0, 200))
await shot('registration-eight')

console.log('\n   Ravi S signs up — looks like Ravi Shankar')
{
  const s = await signup('Ravi S', null)
  await s.fresh.close()
}
await page.goto(REG, { waitUntil: 'networkidle' })
t = await body()
ok('the row is flagged', /9 in/.test(t) && /Same as Ravi Shankar\?/.test(t), t.slice(0, 300))
ok('with Same person / Different', /Same person/.test(t) && /Different/.test(t))
await shot('registration-duplicate')
await page.goto(HUB, { waitUntil: 'networkidle' })
t = await body()
ok('the hub counts the possible duplicate', /9 players in · link is open · 1 possible duplicate/.test(t), t.slice(0, 300))
await page.goto(REG, { waitUntil: 'networkidle' })
await page.click('button:has-text("Same person")')
t = await timed('Same person', () => until(/one person on the list now/))
ok('merged, back to 8', /Ravi S and Ravi Shankar are one person on the list now\./.test(t) && /8 in/.test(t) && !/Same as/.test(t), t.slice(0, 300))
await shot('registration-merged')

console.log('\n   close sign-ups')
await page.click('summary:has-text("Close sign-ups")')
await page.waitForTimeout(250)
await shot('registration-close-confirm')
await page.click('button:has-text("Close sign-ups")')
t = await timed('Close sign-ups', () => until(/sign-ups closed/))
ok('sign-ups closed, 8 in', /8 in · sign-ups closed/.test(t) && /Reopen sign-ups/.test(t), t.slice(0, 300))
await shot('registration-closed')
{
  const fresh = await browser.newContext(PHONE)
  const p = await fresh.newPage()
  watch(p, 'closed link')
  const res = await p.goto(LINK, { waitUntil: 'networkidle' })
  const text = await body(p)
  ok('the link says sign-ups have closed, no fields, no cookie', /Sign-ups have closed — ask the organiser\./.test(text) && (await p.$('input[name=name]')) === null && !res.headers()['set-cookie'], text.slice(0, 200))
  await shot('signup-closed', p)
  await fresh.close()
}
await page.goto(HUB, { waitUntil: 'networkidle' })
t = await body()
ok('hub: Registration says 8 players in · sign-ups closed', /8 players in · sign-ups closed/.test(t), t.slice(0, 300))
ok('hub: Teams is the current step with 2 mutual pairs', /2 of 4 pairs made · 4 players still to pair/.test(t), t.slice(0, 400))
await shot('hub-after-registration')

console.log('\n4. teams')
await timed('teams page', () => page.goto(`${HUB}/teams`, { waitUntil: 'networkidle' }))
t = await body()
ok('2 pairs made · 4 still to pair', /2 pairs made · 4 players still to pair/.test(t), t.slice(0, 300))
ok('Karthik / Sathish named each other', /Karthik Subramanian Sathish Kumar named each other/.test(t))
ok('Hari / Naveen named each other', /Hari Venkatesh Naveen Krishnan named each other/.test(t))
ok('Ravi wants Arun, and the row says Arun named nobody', /Ravi Shankar wants Arun Prakash · Arun named nobody/.test(t), t.slice(0, 400))
ok('and the row still opens the picker', (await page.$('a[href*="/teams/pair/"]:has-text("Ravi Shankar")')) !== null)
await shot('teams-start')
await page.click('a:has-text("Ravi Shankar")')
await page.waitForURL(/\/teams\/pair\//, { timeout: 20000 })
await settle()
t = await body()
ok('picker: Pair Ravi Shankar with, Ravi asked for Arun', /Pair Ravi Shankar with/.test(t) && /Ravi asked for Arun Prakash/.test(t), t.slice(0, 300))
ok('lists the three free people', /Arun Prakash/.test(t) && /Deepak Raj/.test(t) && /Bala Murugan/.test(t) && !/Karthik/.test(t))
await shot('teams-picker')
await page.click('button:has-text("Arun Prakash")')
await page.waitForURL(/\/teams$/, { timeout: 20000 })
await settle()
t = await body()
ok('3 pairs made · 2 still to pair', /3 pairs made · 2 players still to pair/.test(t), t.slice(0, 300))
ok('Ravi / Arun paired by you', /Ravi Shankar Arun Prakash paired by you/.test(t))
await page.click('summary:has-text("Pair the rest at random")')
await page.waitForTimeout(250)
t = await body()
ok('asks first, naming the number', /Pair the 2 people left at random\?/.test(t))
await shot('teams-random-confirm')
await page.click('button:has-text("Pair them")')
t = await timed('Pair the rest at random', () => until(/everyone is paired/))
ok('4 pairs made · everyone is paired', /4 pairs made · everyone is paired/.test(t), t.slice(0, 300))
ok('Deepak / Bala are a pair', /Deepak Raj Bala Murugan paired by you|Bala Murugan Deepak Raj paired by you/.test(t))
ok('next step offered', /Next: Schedule & courts/.test(t))
await shot('teams-done')
await page.goto(HUB, { waitUntil: 'networkidle' })
t = await body()
ok('hub: Teams says 4 of 4 pairs made', /4 of 4 pairs made/.test(t) && !/still to pair/.test(t), t.slice(0, 400))
ok('hub: Schedule is now the current step', /Schedule & courts — next Court 1, Court 2 · schedule not made yet/.test(t), t.slice(0, 400))
await shot('hub-after-teams')

console.log('\n5. schedule & courts')
await timed('schedule page', () => page.goto(`${HUB}/schedule`, { waitUntil: 'networkidle' }))
t = await body()
ok('Court 1, Court 2 · schedule not made yet', /Court 1, Court 2 · schedule not made yet/.test(t), t.slice(0, 200))
ok('the button says what it will make, in the hub’s words', /4 pairs · league, then a final\./.test(t), t.slice(0, 400))
await shot('schedule-empty')
await page.click('button:has-text("Make the schedule")')
t = await timed('Make the schedule', () => until(/Start the tournament/))
const listed = await page.$$eval('ol > li', (ls) => ls.map((l) => l.innerText.replace(/\s+/g, ' ')))
ok('7 matches listed: 6 league + a final', listed.length === 7 && /7 matches/.test(t), `${listed.length}: ${listed.join(' | ')}`)
ok('the final is last, between 1st and 2nd', /Final/.test(listed[6] ?? '') && /1st in table/.test(listed[6] ?? ''), listed[6])
ok('rounds are tagged R1–R3', listed.filter((l) => /R\d$/.test(l.trim())).length === 6, listed.join(' | '))
ok('Start is offered with what it does', /Closes sign-ups and opens the live board/.test(t))
await shot('schedule-made')
await desktopShot('schedule-made')
await page.goto(HUB, { waitUntil: 'networkidle' })
t = await body()
ok('hub: all three steps done, Start is current', /Court 1, Court 2 · 7 matches/.test(t) && /Everything is ready/.test(t) && /Start the tournament/.test(t), t.slice(0, 400))
await shot('hub-ready')

console.log('\n   start')
await page.click('button:has-text("Start the tournament")')
await timed('Start the tournament', () => page.waitForURL(/\/admin\/live$/, { timeout: 30000 }))
ok('Start lands on the live board', page.url().endsWith('/admin/live'))
await settle()

console.log('\n6. the live board')
let c = await cards()
ok('four court cards', Object.keys(c).length === 4, Object.keys(c).join(','))
let c1 = await onCourt('Court 1')
let c2 = await onCourt('Court 2')
ok('Court 1 has a match on it', !!c1, c['Court 1'])
ok('Court 2 has a match on it', !!c2, c['Court 2'])
ok('different matches', !!c1 && !!c2 && c1.href !== c2.href)
ok('Court 3 and 4 say Not assigned', /Not assigned/.test(c['Court 3'] ?? '') && /Not assigned/.test(c['Court 4'] ?? ''), `${c['Court 3']} | ${c['Court 4']}`)
ok('and are not offered to a tournament whose eight players are all on court', !/sitting empty/.test(c['Court 3'] ?? '') && !/Add Court/.test(c['Court 4'] ?? ''), `${c['Court 3']} | ${c['Court 4']}`)
ok('2 on court, 1 tournament running', /2 on court/i.test(await body()) && /1 tournament running/.test(await body()), (await body()).slice(0, 200))
ok("strip: Men's 0 of 7", /Men's 0 of 7/.test(await body()), (await body()).slice(0, 300))
ok('each card says Enter the score and Move', /Enter the score/.test(c['Court 1']) && /Move/.test(c['Court 1']))
await shot('live-start')
await desktopShot('live-start')

console.log("\n   move Court 2's match back to the queue")
const moved = c2
await page.click('[data-court]:has(.text-eyebrow:text-is("Court 2")) a:has-text("Move")')
await page.waitForURL(/\/admin\/live\/move\//, { timeout: 30000 })
await settle()
t = await body()
ok('the move screen names the match and the court', /Move this match/.test(t) && /on Court 2/.test(t), t.slice(0, 300))
ok('Court 1 is shown busy, Courts 3 and 4 not at all', /Court 1 Men's Doubles · busy/.test(t) && !/Court 3/.test(t) && !/Court 4/.test(t), t.slice(0, 400))
await shot('move')
await page.click('button:has-text("Back to the queue")')
await timed('Back to the queue', () => page.waitForURL(/\/admin\/live$/, { timeout: 30000 }))
await settle()
c = await cards()
const c2after = await onCourt('Court 2')
const movedFirst = moved?.names?.[0]?.split(' ')[0] ?? ''
ok('Court 2 is either empty with a reason, or has a different match', (!c2after && /Nothing on court/.test(c['Court 2'] ?? '')) || (!!c2after && c2after.href !== moved.href), c['Court 2'])
ok('the match that came off is named as next somewhere', new RegExp(`(Next here|Put)[^|]*${movedFirst}`).test(c['Court 1'] + ' | ' + c['Court 2']), `${c['Court 1']} | ${c['Court 2']}`)
ok('1 on court now', /1 on court/i.test(await body()), (await body()).slice(0, 200))
ok('no nudge to add a court while the tournament’s own Court 2 stands empty', !/sitting empty/.test(c['Court 3'] ?? ''), c['Court 3'])
await shot('live-after-move')

console.log('\n   every score, through the score screen')
const results = []
let guard = 0
while (guard++ < 12) {
  await page.goto(`${BASE}/admin/live`, { waitUntil: 'networkidle' })
  const live = (await onCourt('Court 1')) ?? (await onCourt('Court 2'))
  if (!live) break
  const court = (await onCourt('Court 1')) ? 'Court 1' : 'Court 2'
  const isFinal = /Final/.test(live.round)
  if (isFinal) break
  // Tap the button on the board, as a thumb would.
  await page.click(`[data-court]:has(.text-eyebrow:text-is("${court}")) a[href^="/admin/m/"]`)
  await page.waitForURL(/\/admin\/m\//, { timeout: 30000 })
  await settle()
  if (results.length === 0) {
    t = await body()
    ok('the score screen names the court, the pairs and the round', new RegExp(court.toUpperCase()).test(t) && /Men's Doubles · Round/.test(t) && /Who won game 1\?/.test(t), t.slice(0, 300))
    await shot('score-entry-blank')
  }
  const t0 = await enterScore()
  await page.waitForURL(/\/admin\/live$/, { timeout: 30000 })
  const saveMs = Date.now() - t0
  await settle()
  const after = await onCourt(court)
  results.push({ court, names: live.names, round: live.round, saveMs })
  ok(`  ${live.round}: ${live.names.join(' / ')} on ${court} → saved and back on the board (${saveMs} ms)`, page.url().endsWith('/admin/live'))
  if (results.length < 6) {
    const strip = await body()
    ok(`  strip says Men's ${results.length} of 7`, new RegExp(`Men's ${results.length} of 7`).test(strip), strip.slice(0, 200))
    ok(`  ${court} has the next match on it by itself, or a reason`, (!!after && after.href !== live.href) || /Nothing on court/.test((await cards())[court] ?? ''), (await cards())[court])
    {
      const cc = await cards()
      // Only real pairings count: "Final · waiting on Court 1's result" may fairly sit on both.
      const nexts = ['Court 1', 'Court 2'].map((k) => (cc[k] ?? '').match(/Next here: ([^·]+?)(?: ·|$)/)?.[1]?.trim()).filter((x) => x && / v /.test(x))
      ok('  no two cards name the same match as next', new Set(nexts).size === nexts.length, nexts.join(' | '))
    }
  }
  if (results.length === 1) await shot('live-after-first-score')
  if (results.length === 3) {
    await shot('live-midway')
    await desktopShot('live-midway')
    await page.goto(HUB, { waitUntil: 'networkidle' })
    t = await body()
    ok('hub while running: played count, Live board button, table', /3 of 7 played · Court 1, Court 2/.test(t) && /Live board/.test(t) && /Top 2 play the final/i.test(t), t.slice(0, 300))
    await shot('hub-running')
    await desktopShot('hub-running')
    {
      const fresh = await browser.newContext(PHONE)
      const p = await fresh.newPage()
      watch(p, 'public running')
      const res = await timed('public page', () => p.goto(`${BASE}/t/${slug}`, { waitUntil: 'networkidle' }))
      const text = await body(p)
      ok('public page while running: on court now, up next, table, played, no cookie', /On court now/i.test(text) && /Table/i.test(text) && /Top 2 play the final/i.test(text) && /Played ?3/i.test(text) && !res.headers()['set-cookie'], text.slice(0, 300))
      await shot('public-running', p)
      await desktopShot('public-running', p)
      await fresh.close()
    }
  }
}
ok('six league matches were scored', results.length === 6, JSON.stringify(results))
await shot('live-after-league')

console.log('\n   the final appears by itself')
await page.goto(HUB, { waitUntil: 'networkidle' })
const rows = await page.$$eval('table tbody tr', (trs) =>
  trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())).filter((r) => r.length === 4),
)
ok('the table has four pairs', rows.length === 4, JSON.stringify(rows))
// The name cell may carry a second line saying why the row sits there.
const top2 = rows.slice(0, 2).map((r) => r[1].split('\n')[0].trim())
console.log('   top 2:', top2.join(' | '))
await shot('hub-before-final')
await page.goto(`${BASE}/admin/live`, { waitUntil: 'networkidle' })
c = await cards()
const finalCourt = (await onCourt('Court 1')) ? 'Court 1' : (await onCourt('Court 2')) ? 'Court 2' : null
const fin = finalCourt ? await onCourt(finalCourt) : null
ok('the final is on a court', !!fin && /Final/.test(fin.round), JSON.stringify(c))
const finalNames = fin ? fin.names.join(' / ') : ''
ok('between the top two of the table', !!fin && top2.every((name) => finalNames.includes(name)), `${finalNames} vs ${top2.join(' | ')}`)
const otherCourt = finalCourt === 'Court 1' ? 'Court 2' : 'Court 1'
ok('the other court says nothing is left for it', /Nothing left for this court|Nothing on court/.test(c[otherCourt] ?? ''), c[otherCourt])
await shot('live-final')
if (fin) {
  await page.click(`[data-court]:has(.text-eyebrow:text-is("${finalCourt}")) a[href^="/admin/m/"]`)
  await page.waitForURL(/\/admin\/m\//, { timeout: 30000 })
  await settle()
  t = await body()
  ok('the score screen says Final', /Men's Doubles · Final/.test(t), t.slice(0, 200))
  await shot('score-entry-final')
  await enterScore()
  await page.waitForURL(/\/admin\/live$/, { timeout: 30000 })
  await settle()
}
c = await cards()
t = await body()
ok("the board says Men's all played, 0 on court", /Men's all played/.test(t) && /0 on court/i.test(t), t.slice(0, 300))
ok('the courts say every match has been played and point at the page', /Every Men's Doubles match has been played/.test(c['Court 1'] ?? '') && /Finish it with the button at the top/.test(c['Court 1'] ?? ''), c['Court 1'])
await shot('live-all-played')

console.log('\n   finish')
ok('the board offers Finish at the top', /Finish Men's Doubles/.test(t) && /All 7 played/.test(t), t.slice(0, 300))
await page.goto(HUB, { waitUntil: 'networkidle' })
t = await body()
ok('the hub says everything has been played and offers Finish', /Everything has been played/i.test(t) && /Finish the tournament/.test(t), t.slice(0, 400))
ok('7 of 7 played', /7 of 7 played/.test(t))
await shot('hub-all-played')
await page.goto(`${BASE}/admin/live`, { waitUntil: 'networkidle' })
await page.click('button:has-text("Finish Men\'s Doubles")')
t = await timed('Finish the tournament', () => until(/Winners/i))
ok('finished: Winners on top, beat … in the final, final table', /Winners/i.test(t) && /beat .* in the final/.test(t) && /Final table/i.test(t), t.slice(0, 400))
ok('the sub line says finished at a time', /finished \d\d:\d\d/.test(t), t.slice(0, 200))
ok('All 7 results is offered', /All 7 results/.test(t))
await shot('hub-finished')
await desktopShot('hub-finished')

console.log('\n7. what the players see')
{
  const pub = await browser.newContext(PHONE)
  const p = await pub.newPage()
  watch(p, 'public finished')
  let res = await timed('public page (finished)', () => p.goto(`${BASE}/t/${slug}`, { waitUntil: 'networkidle' }))
  ok('/t/<slug> sets no cookie', !res.headers()['set-cookie'] && (await pub.cookies()).length === 0)
  let text = await body(p)
  ok('Winners on top', /^.{0,40}Winners/i.test(text), text.slice(0, 200))
  ok('beat … in the final, with the score', /beat .* in the final 11–7, 11–9/.test(text), text.slice(0, 300))
  ok('Final table', /Final table/i.test(text))
  ok('all 7 played', /Played ?7/i.test(text), text.slice(0, 600))
  ok('no phone number leaks', !/98400|12345/.test(text))
  await shot('public-finished', p)
  await desktopShot('public-finished', p)
  res = await timed('today page', () => p.goto(`${BASE}/`, { waitUntil: 'networkidle' }))
  ok('/ sets no cookie', !res.headers()['set-cookie'] && (await pub.cookies()).length === 0)
  text = await body(p)
  ok("Today lists Men's Doubles as finished", /Men's Doubles — final table & results/.test(text), text.slice(0, 300))
  ok('Courts 1–4 are on it', /Court 1/i.test(text) && /Court 4/i.test(text), text.slice(0, 400))
  await shot('today-finished', p)
  await desktopShot('today-finished', p)
  await pub.close()
}

console.log('\n8. the rest of the organiser’s screens')
await timed('account page', () => page.goto(`${BASE}/admin/account`, { waitUntil: 'networkidle' }))
t = await body()
ok('Change PIN page loads', /PIN/.test(t) && (await page.$('#current')) !== null, t.slice(0, 200))
await shot('account')
await timed('dashboard', () => page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' }))
t = await body()
ok("the dashboard shows Men's Doubles as Done", /Men's Doubles/.test(t) && /Done/i.test(t), t.slice(0, 300))
ok('and who won', /won by/.test(t), t.slice(0, 300))
await shot('dashboard-done')
await desktopShot('dashboard-done')
await page.goto(`${HUB}/results`, { waitUntil: 'networkidle' })
t = await body()
ok('the results list has all 7', /7 of 7 played/.test(t), t.slice(0, 200))
await shot('results')
await page.goto(`${HUB}/more`, { waitUntil: 'networkidle' })
await shot('more')

// ═══════════════════════════════════════════════════════════════════════════
console.log('')
ok('no 5xx anywhere', bad.length === 0, bad.join(' '))
ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
const slow = timings.filter((x) => x.ttfb > 1500)
console.log('\nserver time to first byte per document request (ms):')
for (const x of timings) console.log(`   ${String(x.ttfb).padStart(5)} ${x.method} ${x.url}`)
if (slow.length) console.log(`\n${slow.length} slower than 1.5 s:\n  ${slow.map((x) => `${x.ttfb} ms ${x.url}`).join('\n  ')}`)
console.log('\nsave → back on the board (ms):', results.map((r) => r.saveMs).join(', '))
console.log('steps, wall-clock (ms):', stepTimes.map((x) => `${x.label} ${x.ms}`).join(' · '))
await browser.close()
console.log(fails.length ? `\n${fails.length} failed:\n  - ${fails.join('\n  - ')}` : '\nall good')
console.log(`screenshots: ${OUT}`)
process.exit(fails.length ? 1 : 0)
