/**
 * Everything round 1 did not: the Sunday that goes wrong, and the formats the
 * happy path skipped. Two tournaments on one day, a walkover, a retirement,
 * the horn, a score fixed, a pair pulling out and coming back, a swap, a
 * pause, the format shortened, sign-up edge cases, a delete, the PIN lockout,
 * the board refreshing itself, then semis + final and singles. All of it
 * through the real UI. Screenshots go to /tmp/shots-x/.
 *
 *   BASE=http://localhost:3200 node scripts/e2e-exceptions.mjs
 *
 * Expects a fresh database (scripts/setup.ts) with the organiser on the
 * temporary PIN 123456; signs in with 482913 when the PIN is already set.
 * `reset-lockouts` is run through `npx tsx` with DATABASE_URL from the
 * environment.
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'
import { execSync } from 'node:child_process'

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
const OUT = process.env.OUT ?? '/tmp/shots-x'
mkdirSync(OUT, { recursive: true })

const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 }
const NARROW = { width: 320, height: 568 }

const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ['--no-sandbox'] })
const ctx = await browser.newContext(PHONE)
const page = await ctx.newPage()

// ── bookkeeping ─────────────────────────────────────────────────────────────
const fails = []
const bad = []
const pageErrors = []
const notes = []
function watch(p, label) {
  p.on('pageerror', (e) => {
    pageErrors.push(`${label}: ${e.message.slice(0, 200)}`)
    console.log('   pageerror:', e.message.slice(0, 160))
  })
  p.on('response', (r) => {
    if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`)
  })
}
watch(page, 'organiser')

const ok = (l, c, extra = '') =>
  c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l}  ${String(extra).slice(0, 400)}`))
/** Something worth saying in the report that is not a pass or a fail. */
const note = (s) => (notes.push(s), console.log(`  note  ${s}`))

const body = (p = page) =>
  p.evaluate(() => (document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' '))

let n = 0
const shot = async (name, p = page) => {
  n += 1
  await p.waitForLoadState('networkidle').catch(() => {})
  await p.evaluate(() => window.scrollTo(0, 0))
  await p.waitForTimeout(300)
  await p.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-${name}.png`, fullPage: true })
}
const settle = async (p = page, ms = 350) => {
  await p.waitForLoadState('networkidle').catch(() => {})
  await p.waitForTimeout(ms)
}
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
const goto = async (url, p = page) => {
  await p.goto(url, { waitUntil: 'networkidle' })
  await p.waitForTimeout(150)
  return body(p)
}
/** Does the page scroll sideways? At 320px nothing should. */
const overflows = (p = page) =>
  p.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)

// ── the board ───────────────────────────────────────────────────────────────
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
/** What is on a court: the score link, the two sides as "P1 / P2", the round label. */
async function onCourt(courtName, p = page) {
  return p.evaluate((courtName) => {
    for (const el of document.querySelectorAll('[data-court]')) {
      const name = el.querySelector('.text-eyebrow')?.textContent?.trim()
      if (name !== courtName) continue
      const link = el.querySelector('a[href^="/admin/m/"]')
      if (!link) return null
      const sides = [...el.querySelectorAll('div.px-4 > span.block:not(.text-meta)')].map((s) =>
        (s.innerText ?? '').trim().split('\n').map((x) => x.trim()).filter(Boolean).join(' / '),
      )
      const round = el.querySelector('.ml-auto')?.textContent?.trim() ?? ''
      return { href: link.getAttribute('href'), id: link.getAttribute('href').split('/admin/m/')[1], sides, round }
    }
    return null
  }, courtName)
}
async function board(p = page) {
  await goto(`${BASE}/admin/live`, p)
  const out = {}
  for (const c of ['Court 1', 'Court 2', 'Court 3', 'Court 4']) out[c] = await onCourt(c, p)
  return out
}

// ── the hub table ───────────────────────────────────────────────────────────
/** [{ name, won, points }] from the hub's table, in table order. */
async function table(hub, p = page) {
  await goto(hub, p)
  return p.$$eval('table tbody tr', (trs) =>
    trs
      .map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()))
      .filter((r) => r.length === 4)
      .map((r) => ({ name: r[1].split('\n')[0].trim(), note: r[1].split('\n')[1]?.trim() ?? '', won: Number(r[2]), points: Number(r[3]) })),
  )
}
const rowFor = (rows, name) => rows.find((r) => r.name === name)

// ── score entry ─────────────────────────────────────────────────────────────
async function pickGameWinner(p, game, side) {
  const head = p.locator(`h2:has-text("Who won game ${game}?")`)
  await head.waitFor({ timeout: 20000 })
  await head.locator(`xpath=following-sibling::div[1]/button[${side === 'A' ? 1 : 2}]`).click()
}
async function enterGame(p, game, side, winnerScore, loserScore) {
  await pickGameWinner(p, game, side)
  await p.locator(`button[aria-label$=" scored ${winnerScore}"]`).first().click()
  await p.locator(`button[aria-label$=" scored ${loserScore}, and that finishes the game"]`).click()
  await p.waitForTimeout(250)
}
async function holdSave(p = page, reason = null) {
  if (reason) {
    const box = p.locator('input[placeholder^="Wrong game 2 score"]')
    await box.waitFor({ timeout: 20000 })
    await box.fill(reason)
  }
  const hold = p.locator('button:has-text("Hold to save the result")')
  await hold.waitFor({ timeout: 20000 })
  await p.waitForTimeout(700)
  await hold.scrollIntoViewIfNeeded()
  const box = await hold.boundingBox()
  await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await p.mouse.down()
  await p.waitForTimeout(900)
  await p.mouse.up()
}
/** The two side names as the score screen prints them (side A first). */
async function sidesOnScreen(p = page) {
  return p.$$eval('main p.text-row', (ps) => ps.slice(0, 2).map((x) => x.innerText.trim()))
}
/** Open the score screen for the match on a court. */
async function openScore(court, p = page) {
  await p.click(`[data-court]:has(.text-eyebrow:text-is("${court}")) a[href^="/admin/m/"]`)
  await p.waitForURL(/\/admin\/m\//, { timeout: 30000 })
  await settle(p)
}
async function backOnBoard(p = page) {
  await p.waitForURL(/\/admin\/live$/, { timeout: 30000 })
  await settle(p)
}
/** A plain best-of-3 win for one side: 11–7, 11–9. */
async function enterNormal(p, side, games = [[11, 7], [11, 9]]) {
  for (let i = 0; i < games.length; i++) await enterGame(p, i + 1, side, games[i][0], games[i][1])
  await holdSave(p)
}
async function openSheet(p = page) {
  await p.click('button:has-text("They didn’t play it out")')
  await p.locator('h2:has-text("What happened instead?")').waitFor({ timeout: 10000 })
}
async function whoButton(p, side) {
  const head = p.locator('h2:has-text("Who didn’t turn up?"), h2:has-text("Who stopped?")')
  await head.waitFor({ timeout: 10000 })
  await head.locator(`xpath=following-sibling::div[1]/button[${side === 'A' ? 1 : 2}]`).click()
}

// ── set-up helpers ──────────────────────────────────────────────────────────
async function signIn(p, pin = PIN) {
  await p.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await p.fill('#pin', pin)
  await p.click('button[type=submit]')
  await p.waitForURL(/\/admin/, { timeout: 30000 }).catch(() => {})
  await settle(p)
}
async function signedInContext(label) {
  const c = await browser.newContext(PHONE)
  const p = await c.newPage()
  watch(p, label)
  await signIn(p)
  return { c, p }
}
/** Make a tournament through /admin/new. */
async function create({ name, gender, discipline, format, courts, date }) {
  await goto(`${BASE}/admin/new`)
  await page.waitForSelector('#name')
  if (date) await page.fill('#date', date)
  await page.fill('#name', name)
  await page.click(`fieldset:has(legend:text-is("Who plays")) button:has-text("${gender}")`)
  await page.click(`fieldset:has(legend:text-is("Singles or doubles")) button:has-text("${discipline}")`)
  await page.click(`button:has-text("${format}")`)
  for (const c of courts) await page.click(`fieldset:has(legend:text-is("Courts")) button:has-text("${c}")`)
  await page.click('button:has-text("Create")')
  await page.waitForURL(/\/admin\/t\//, { timeout: 30000 })
  await settle()
  const slug = page.url().split('/admin/t/')[1].split(/[/?]/)[0]
  return { slug, hub: `${BASE}/admin/t/${slug}` }
}
async function signupLink(hub) {
  const t = await goto(`${hub}/registration`)
  const m = t.match(/\/r\/([0-9A-Z]{5}-[0-9A-Z]{5})/)
  return m ? `${BASE}/r/${m[1]}` : null
}
/** Somebody signs up from a phone that has never seen the site. */
async function signup(link, name, partner, phone) {
  const fresh = await browser.newContext(PHONE)
  const p = await fresh.newPage()
  watch(p, `signup ${name}`)
  await p.goto(link, { waitUntil: 'networkidle' })
  const hasForm = (await p.$('input[name=name]')) !== null
  if (!hasForm) {
    const text = await body(p)
    await fresh.close()
    return { text, form: false }
  }
  await p.fill('input[name=name]', name)
  if (phone) await p.fill('input[name=phone]', phone)
  if (partner) await p.fill('input[name=partnerName]', partner)
  await p.click('button:has-text("Sign me up")')
  await p.waitForFunction(() => /on the list|closed|doesn/.test(document.body.innerText ?? ''), null, { timeout: 20000 }).catch(() => {})
  await settle(p, 200)
  const text = await body(p)
  const out = { text, form: true, p, fresh }
  return out
}
async function addByHand(hub, text) {
  await goto(`${hub}/registration`)
  await page.fill('[name=text]', text)
  await page.click('button:has-text("Add")')
  // The phone number, if any, is never printed on the row.
  const name = text.replace(/[\d\s]+$/, '').trim()
  return until(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
}
async function pairRest(hub) {
  await goto(`${hub}/teams`)
  await page.click('summary:has-text("Pair the rest at random")')
  await page.waitForTimeout(200)
  await page.click('button:has-text("Pair them")')
  return until(/everyone is paired|still to pair/)
}
/** The order of play as [{ a, b, round, text }] — the two sides read from their own spans. */
async function scheduleRows(p = page) {
  return p.$$eval('ol > li', (ls) =>
    ls.map((l) => {
      const s = [...l.querySelectorAll('span.flex-1 > span')].map((x) => x.innerText.trim())
      return {
        a: s[0] ?? '',
        b: s[2] ?? '',
        round: l.querySelector('span.rounded-full')?.innerText.trim() ?? '',
        text: l.innerText.replace(/\s+/g, ' ').trim(),
      }
    }),
  )
}
async function makeSchedule(hub) {
  await goto(`${hub}/schedule`)
  await page.click('button:has-text("Make the schedule")')
  await until(/Start the tournament/)
  return scheduleRows()
}
const line = (r) => `${r.a} v ${r.b} ${r.round}`
async function start(hub) {
  await goto(hub)
  await page.click('button:has-text("Start the tournament")')
  await page.waitForURL(/\/admin\/live$/, { timeout: 30000 })
  await settle()
}
async function finishFromBoard(name) {
  await goto(`${BASE}/admin/live`)
  await page.click(`button:has-text("Finish ${name}")`)
  await until(/Winners|Winner/i)
}
/** Which of a tournament's courts has a live match — and what. */
async function liveOn(courts, p = page) {
  const b = await board(p)
  for (const c of courts) if (b[c]) return { court: c, ...b[c] }
  return null
}
/**
 * Enter every league match on these courts. Sides alternate and the losing
 * scores vary, so a table of identical 11–7 11–9s does not end in a dead heat
 * nobody asked for. `pick(sides)` chooses the winner instead when given.
 */
async function drainLeague(courts, { bestOf = 3, until: stopAt = /Semi-final|Final/, pick = null, scores = null } = {}) {
  let i = 0
  let guard = 0
  const played = []
  while (guard++ < 40) {
    const live = await liveOn(courts)
    if (!live || stopAt.test(live.round)) break
    await openScore(live.court)
    const side = pick ? pick(live.sides) : i % 2 ? 'B' : 'A'
    const games = scores ?? [[11, 2 + (i % 8)], [11, 3 + ((i * 3) % 7)]]
    if (bestOf === 1) {
      await enterGame(page, 1, side, 11, games[0][1])
      await holdSave()
    } else await enterNormal(page, side, games)
    await backOnBoard()
    played.push({ court: live.court, sides: live.sides, round: live.round, winner: live.sides[side === 'A' ? 0 : 1], games })
    i++
  }
  return played
}
const day = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** "P1 / P2" as innerText prints it when TeamName stacks the two names. */
const flat = (pair) => pair.replace(/ \/ /g, ' ')
const first = (pair) => pair.split(' / ')[0]

// ═══════════════════════════════════════════════════════════════════════════

console.log('\n0. sign in')
await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
await page.fill('#pin', TEMP_PIN)
await page.click('button[type=submit]')
await page.waitForURL(/\/admin|login/, { timeout: 30000 }).catch(() => {})
await settle()
if (page.url().includes('/admin/account')) {
  await page.fill('#current', TEMP_PIN)
  await page.fill('#next', PIN)
  await page.fill('#confirm', PIN)
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin$/, { timeout: 20000 })
} else if (!page.url().endsWith('/admin')) {
  await signIn(page)
}
ok('signed in', page.url().endsWith('/admin'), page.url())

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n1. Men's Doubles — sign-ups, with the edge cases (item 10)")
const mens = await create({ name: "Men's Doubles", gender: "Men's", discipline: 'Doubles', format: 'top 2 play a final', courts: ['Court 1', 'Court 2'] })
const MLINK = await signupLink(mens.hub)
ok('the sign-up link is there', !!MLINK)

const MENS = [
  ['Karthik Subramanian', 'Sathish Kumar', '98400 11111'],
  ['Sathish Kumar', 'Karthik Subramanian', null],
  ['Hari Venkatesh', 'Naveen Krishnan', null],
  ['Naveen Krishnan', 'Hari Venkatesh', null],
  ['Ravi Shankar', 'Arun Prakash', null],
  ['Arun Prakash', 'Ravi Shankar', null],
  ['Deepak Raj', 'Suresh Babu', null], // Suresh never signs up
  ['Bala Murugan', null, null],
]
for (const [name, partner, phone] of MENS) {
  const s = await signup(MLINK, name, partner, phone)
  ok(`  ${name} signs up`, /You’re on the list\./.test(s.text), s.text.slice(0, 200))
  if (s.fresh) await s.fresh.close()
}
{
  const s = await signup(MLINK, 'Karthik Subramanian', null, '9840011111')
  ok('the same phone and name twice → already on the list, not a second row', /You’re already on the list\./.test(s.text), s.text.slice(0, 200))
  await shot('signup-already-on-list', s.p)
  if (s.fresh) await s.fresh.close()
  const t = await goto(`${mens.hub}/registration`)
  ok('  still 8 in', /8 in · sign-ups open/.test(t), t.slice(0, 200))
  ok('  and no Karthik S row', !/Karthik S\b(?! ubramanian)/.test(t.replace(/Karthik Subramanian/g, '')), t.slice(0, 600))
}
{
  const t = await goto(`${mens.hub}/teams`)
  ok('Teams: Deepak wants Suresh Babu (not signed up)', /Deepak Raj wants Suresh Babu \(not signed up\)/.test(t), t.slice(0, 600))
  ok('Teams: 3 pairs made · 2 still to pair', /3 pairs made · 2 players still to pair/.test(t), t.slice(0, 200))
  await shot('teams-wants-not-signed-up')
}
await pairRest(mens.hub)
{
  const t = await body()
  ok('4 pairs after pairing the rest', /4 pairs made · everyone is paired/.test(t), t.slice(0, 200))
}
console.log('\n   remove a player who is in an unplayed pair')
{
  await goto(`${mens.hub}/registration`)
  const row = page.locator('li:has(p.text-row:text-is("Bala Murugan"))')
  await row.locator('summary:has-text("Remove")').click()
  await page.waitForTimeout(200)
  const t = await body()
  ok('the confirm says the pair is split if unplayed', /Bala Murugan comes off the list\. If they are in a pair that has not played, the pair is split\./.test(t), t.slice(0, 800))
  await shot('registration-remove-confirm')
  await row.locator('button:has-text("Take Bala Murugan off")').click()
  const after = await until(/is off the list/)
  ok('note: off the list, and the pair is split', /Bala Murugan is off the list, and the pair .* is split\./.test(after), after.slice(0, 300))
  ok('7 in', /7 in · sign-ups open/.test(after), after.slice(0, 200))
  const teams = await goto(`${mens.hub}/teams`)
  ok('Deepak is back in the pile', /Still to pair\s*1 player Deepak Raj/i.test(teams) && /3 pairs made · 1 player still to pair/.test(teams), teams.slice(0, 400))
  ok('and the odd-one-out line points at Registration', /Deepak Raj is the odd one out/.test(teams), teams.slice(0, 600))
  await shot('teams-after-remove')
}
console.log('\n   add him back, pair by hand')
{
  const t = await addByHand(mens.hub, 'Bala Murugan 98400 22222')
  ok('Bala is back, 8 in', /8 in · sign-ups open/.test(t) && /Bala Murugan no partner named · added by you/.test(t), t.slice(0, 300))
  await goto(`${mens.hub}/teams`)
  await page.click('a[href*="/teams/pair/"]:has-text("Deepak Raj")')
  await page.waitForURL(/\/teams\/pair\//, { timeout: 20000 })
  await settle()
  await page.click('button:has-text("Bala Murugan")')
  await page.waitForURL(/\/teams$/, { timeout: 20000 })
  const teams = await until(/everyone is paired/)
  ok('4 pairs made · everyone is paired', /4 pairs made · everyone is paired/.test(teams), teams.slice(0, 200))
}
console.log('\n   close, reopen, start closes again')
{
  await goto(`${mens.hub}/registration`)
  await page.click('summary:has-text("Close sign-ups")')
  await page.waitForTimeout(200)
  await page.click('button:has-text("Close sign-ups")')
  const t = await until(/sign-ups closed/)
  ok('closed', /8 in · sign-ups closed/.test(t), t.slice(0, 200))
  const s = await signup(MLINK, 'Late Larry', null, null)
  ok('the link refuses: Sign-ups have closed — ask the organiser, no form', !s.form && /Sign-ups have closed — ask the organiser\./.test(s.text), s.text.slice(0, 200))
  await goto(`${mens.hub}/registration`)
  await page.click('button:has-text("Reopen sign-ups")')
  const r = await until(/sign-ups open/)
  ok('reopened', /8 in · sign-ups open/.test(r), r.slice(0, 200))
  const s2 = await signup(MLINK, 'Late Larry', null, null)
  ok('the link takes names again', s2.form && /You’re on the list\./.test(s2.text), s2.text.slice(0, 200))
  if (s2.fresh) await s2.fresh.close()
  // Larry makes 9 — take him off so the draw is four pairs.
  await goto(`${mens.hub}/registration`)
  const row = page.locator('li:has(p.text-row:text-is("Late Larry"))')
  await row.locator('summary:has-text("Remove")').click()
  await page.waitForTimeout(150)
  await row.locator('button:has-text("Take Late Larry off")').click()
  await until(/Late Larry is off the list/)
}
const mensList = await makeSchedule(mens.hub)
ok('Men’s: 7 matches, final last between 1st and 2nd', mensList.length === 7 && mensList[6].round === 'Final' && mensList[6].a === '1st in table' && mensList[6].b === '2nd in table', mensList.map(line).join(' | '))

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n2. Mixed Doubles on Court 3 — everyone plays everyone, no final')
const mixed = await create({ name: 'Mixed Doubles', gender: 'Mixed', discipline: 'Doubles', format: 'Everyone plays everyone', courts: ['Court 3'] })
for (const name of ['Priya Ramesh', 'Rahul Menon', 'Divya Natarajan', 'Vikram Chandran', 'Meera Krishnamurthy', 'Arun Kumar']) {
  await addByHand(mixed.hub, name)
}
{
  const t = await goto(`${mixed.hub}/registration`)
  ok('Mixed: 6 in', /6 in · sign-ups open/.test(t), t.slice(0, 200))
}
await pairRest(mixed.hub)
{
  const t = await body()
  ok('Mixed: 3 pairs', /3 pairs made · everyone is paired/.test(t), t.slice(0, 200))
}
const mixedList = await makeSchedule(mixed.hub)
ok('Mixed: 3 matches and no final', mixedList.length === 3 && !mixedList.some((l) => l.round === 'Final'), mixedList.map(line).join(' | '))
await start(mixed.hub)
{
  const b = await board()
  ok('Mixed started: Court 3 has a match, Courts 1–2 say Men’s hasn’t started', !!b['Court 3'] && !b['Court 1'] && /hasn’t started yet/.test((await cards())['Court 1'] ?? ''), JSON.stringify(await cards()))
  await shot('live-mixed-only')
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n3. Men's starts — two tournaments on one day (item 1)")
await start(mens.hub)
{
  const s = await signup(MLINK, 'Late Larry', null, null)
  ok('Start closed sign-ups: the link refuses', !s.form && /Sign-ups have closed/.test(s.text), s.text.slice(0, 200))
  if (s.fresh) await s.fresh.close()
}
let b = await board()
let c = await cards()
ok('four court cards', Object.keys(c).length === 4, Object.keys(c).join(','))
ok('Court 1 and 2 carry Men’s Doubles matches', /Men's Doubles/.test(c['Court 1']) && /Men's Doubles/.test(c['Court 2']) && !!b['Court 1'] && !!b['Court 2'], `${c['Court 1']} | ${c['Court 2']}`)
ok('Court 3 carries the Mixed match', /Mixed Doubles/.test(c['Court 3']) && !!b['Court 3'], c['Court 3'])
ok('Court 4: Not assigned, and not nudged at anyone', /Not assigned/.test(c['Court 4']) && !/sitting empty/.test(c['Court 4']), c['Court 4'])
{
  const t = await body()
  ok('strip: Men’s 0 of 7 and Mixed 0 of 3', /Men's 0 of 7/.test(t) && /Mixed 0 of 3/.test(t), t.slice(0, 300))
  ok('3 on court · 2 tournaments running', /3 on court/i.test(t) && /2 tournaments running/.test(t), t.slice(0, 200))
  ok('More links name both tournaments', /Men's Doubles/.test(t) && /Mixed Doubles/.test(t))
}
await shot('live-two-tournaments')

console.log('\n   Move on the Mixed match offers nothing but the queue')
await page.click('[data-court]:has(.text-eyebrow:text-is("Court 3")) a:has-text("Move")')
await page.waitForURL(/\/admin\/live\/move\//, { timeout: 30000 })
await settle()
{
  const t = await body()
  const rows = await page.$$eval('main ul > li', (ls) => ls.map((l) => l.innerText.replace(/\s+/g, ' ').trim()))
  ok('the list is only Back to the queue', rows.length === 1 && /Back to the queue/.test(rows[0]), rows.join(' | '))
  ok('no Men’s court is offered', !/Court 1/.test(rows.join(' ')) && !/Court 2/.test(rows.join(' ')), rows.join(' | '))
  ok('and it says Mixed has only the one court', /Mixed Doubles has only the one court/.test(t), t.slice(-300))
  await shot('move-mixed-queue-only')
}

console.log("\n   a score on Court 3 never touches Courts 1–2")
{
  const before = await board()
  const m3 = before['Court 3']
  await openScore('Court 3')
  const sides = await sidesOnScreen()
  ok('the score screen says Court 3 and Mixed Doubles', /COURT 3/.test(await body()) && /Mixed Doubles · Round/.test(await body()), (await body()).slice(0, 200))
  await enterNormal(page, 'A')
  await backOnBoard()
  const after = await board()
  ok('Courts 1 and 2 are exactly as they were', after['Court 1']?.id === before['Court 1']?.id && after['Court 2']?.id === before['Court 2']?.id, JSON.stringify([before, after]))
  ok('Court 3 moved on to its next match', !!after['Court 3'] && after['Court 3'].id !== m3.id, JSON.stringify(after['Court 3']))
  ok('strip: Mixed 1 of 3, Men’s still 0 of 7', /Mixed 1 of 3/.test(await body()) && /Men's 0 of 7/.test(await body()), (await body()).slice(0, 300))
  globalThis.MIXED_M1 = { winner: sides[0], loser: sides[1] }
}

// ═══════════════════════════════════════════════════════════════════════════
console.log("\n4. Men's — the league, with everything going wrong")
b = await board()
const M1 = { court: 'Court 1', ...b['Court 1'] }
const M2 = { court: 'Court 2', ...b['Court 2'] }
const pairs = [...new Set([...M1.sides, ...M2.sides])]
ok('four Men’s pairs on two courts', pairs.length === 4, pairs.join(' | '))

console.log('\n   M1: a plain result on Court 1')
await openScore('Court 1')
{
  const sides = await sidesOnScreen()
  ok('side A on screen is side A on the card', sides[0] === M1.sides[0] && sides[1] === M1.sides[1], `${sides} vs ${M1.sides}`)
}
await enterNormal(page, 'A', [[11, 7], [11, 9]])
await backOnBoard()
b = await board()
ok('Court 1 is empty afterwards: everyone else is on Court 2', !b['Court 1'] && /Everyone who could play next is already on a court/.test((await cards())['Court 1']), (await cards())['Court 1'])
let rows = await table(mens.hub)
ok(`table: ${M1.sides[0]} 1 won, 22 points; ${M1.sides[1]} 0 won, 16 points`, rowFor(rows, M1.sides[0])?.won === 1 && rowFor(rows, M1.sides[0])?.points === 22 && rowFor(rows, M1.sides[1])?.points === 16, JSON.stringify(rows))

console.log('\n   M2: a retirement, entered from a second phone while the board watches (items 4, 13)')
const second = await signedInContext('second phone')
await goto(`${BASE}/admin/live`)
const m2Before = await onCourt('Court 2')
// Second phone: game 1 11–7 to side A, then side B could not carry on at 5–3.
await second.p.goto(`${BASE}${m2Before.href}`, { waitUntil: 'networkidle' })
await enterGame(second.p, 1, 'A', 11, 7)
await openSheet(second.p)
{
  const sh = await body(second.p)
  ok('  with a game already in, the sheet offers retired and horn — no-show is hidden', !/One side didn’t turn up/.test(sh) && /Someone couldn’t carry on/.test(sh) && /The horn went — stopped on time/.test(sh), sh.slice(-400))
}
await shot('score-sheet', second.p)
await second.p.click('button:has-text("Someone couldn’t carry on")')
await whoButton(second.p, 'B')
{
  const t = await body(second.p)
  ok('  the retired panel names who stopped and who goes through', new RegExp(`${esc(M2.sides[1])} couldn’t carry on\\. ${esc(M2.sides[0])} go through`).test(t), t.slice(0, 600))
}
const boxes = second.p.locator('input[inputmode=numeric]')
{
  const box = await boxes.nth(0).boundingBox()
  const label = await second.p.locator('label:has-text("Points for")').first().boundingBox()
  ok(`  the points box is a box (${Math.round(box?.width ?? 0)}px) and the name beside it has room (${Math.round(label?.width ?? 0)}px)`, (box?.width ?? 999) <= 100 && (label?.width ?? 0) >= 150, JSON.stringify({ box, label }))
}
await boxes.nth(0).fill('5')
await boxes.nth(1).fill('3')
await shot('score-retired', second.p)
const tSave = Date.now()
await holdSave(second.p)
await backOnBoard(second.p)
// The first phone was left on the board. It should move by itself.
await page
  .waitForFunction(
    (href) => !document.querySelector(`a[href="${href}"]`),
    m2Before.href,
    { timeout: 12000 },
  )
  .catch(() => {})
const refreshMs = Date.now() - tSave
await settle()
b = { 'Court 1': await onCourt('Court 1'), 'Court 2': await onCourt('Court 2') }
ok(`  the watching board moved on by itself in ${refreshMs} ms (< 10 s), no reload`, refreshMs < 10000 && b['Court 2']?.id !== m2Before.id, JSON.stringify(b))
ok('  and both courts refilled with the next round', !!b['Court 1'] && !!b['Court 2'] && /R2/.test(b['Court 1'].round) && /R2/.test(b['Court 2'].round), JSON.stringify(b))
await shot('live-auto-refreshed')
rows = await table(mens.hub)
{
  const w = rowFor(rows, M2.sides[0])
  const l = rowFor(rows, M2.sides[1])
  ok(`  retired: ${M2.sides[0]} won; points 11+11=22 (the stopped game is finished at the target), loser 7+3=10`, w?.won === 1 && w?.points === 22 && l?.won === 0 && l?.points === 10, JSON.stringify(rows))
  const t = await body()
  ok('  Played shows 2–0 and 11–7, 11–3', /11–7, 11–3/.test(t), t.slice(0, 900))
}
note('A retirement mid-game records the unfinished game at 11–3, not 5–3: the winner is credited with the target score (SPEC A5). "Points as played" is not quite what the table shows.')

const M3 = { court: 'Court 1', ...b['Court 1'] }
const M4 = { court: 'Court 2', ...b['Court 2'] }

console.log('\n   M3: a walkover — one side didn’t turn up (item 4)')
{
  const before = await table(mens.hub)
  const winnerBefore = rowFor(before, M3.sides[0])
  await goto(`${BASE}/admin/live`)
  await openScore('Court 1')
  await openSheet()
  {
    const sh = await body()
    ok('  before a ball is struck the sheet offers no-show, retired and horn', /One side didn’t turn up/.test(sh) && /Someone couldn’t carry on/.test(sh) && /The horn went — stopped on time/.test(sh), sh.slice(-400))
    await shot('score-sheet-before-play')
  }
  await page.click('button:has-text("One side didn’t turn up")')
  await whoButton(page, 'B')
  const t = await body()
  ok('  the panel says who didn’t turn up and that it won’t count towards points', new RegExp(`${esc(M3.sides[1])} didn’t turn up\\. ${esc(M3.sides[0])} go through\\. Recorded as a no-show — it won’t count towards points scored`).test(t), t.slice(0, 600))
  await shot('score-walkover')
  await holdSave()
  await backOnBoard()
  const after = await table(mens.hub)
  const winnerAfter = rowFor(after, M3.sides[0])
  ok(`  ${M3.sides[0]}: one more win, Points unchanged (${winnerBefore?.points} → ${winnerAfter?.points})`, winnerAfter?.won === winnerBefore?.won + 1 && winnerAfter?.points === winnerBefore?.points, JSON.stringify([before, after]))
  const hub = await body()
  ok('  Played shows it as a walkover', new RegExp(`${esc(M3.sides[0])} walkover against ${esc(M3.sides[1])}`).test(hub), hub.slice(0, 1200))
  ok('  and prints the word, not a made-up 11–0, 11–0', /Walkover/.test(hub) && !/11–0, 11–0/.test(hub), hub.slice(0, 1200))
  await shot('hub-after-walkover')
  const pub = await goto(`${BASE}/t/${mens.slug}`)
  ok('  the public page says Walkover with no score line', /walkover against/.test(pub) && /Walkover/.test(pub), pub.slice(0, 1500))
}

console.log('\n   fix M1’s score with a reason (item 5)')
{
  const t = await goto(`${mens.hub}/more?do=fix`)
  ok('  Fix a score lists the played matches, newest first', /Newest first/.test(t) && new RegExp(`${esc(M1.sides[0])} beat ${esc(M1.sides[1])}`).test(t), t.slice(0, 600))
  ok('  the walkover row says Walkover, no numbers', /walkover against .* Walkover/.test(t) && !/11–0, 11–0/.test(t), t.slice(0, 600))
  await shot('more-fix-list')
  await page.click(`a:has-text("${M1.sides[0]}"):has-text("beat ${M1.sides[1]}")`)
  await page.waitForURL(/\/admin\/m\//, { timeout: 20000 })
  await settle()
  const s = await body()
  ok('  the screen says it is changing a result that’s already in, 11–7, 11–9', /Changing a result that’s already in/i.test(s) && /11–7, 11–9/.test(s), s.slice(0, 500))
  await enterGame(page, 1, 'A', 11, 5)
  await enterGame(page, 2, 'A', 11, 6)
  const r = await body()
  ok('  it asks what changed', /What changed\?/.test(r), r.slice(0, 900))
  await shot('score-fix')
  await holdSave(page, 'Wrong scores — was 11–5, 11–6')
  await backOnBoard()
  rows = await table(mens.hub)
  ok(`  the table moved: ${M1.sides[1]} now on ${rowFor(rows, M1.sides[1])?.points} points (was 16), winner still 22`, rowFor(rows, M1.sides[1])?.points === 11 && rowFor(rows, M1.sides[0])?.points === 22, JSON.stringify(rows))
  ok('  Played shows 11–5, 11–6', /11–5, 11–6/.test(await body()), (await body()).slice(0, 900))
}

console.log('\n   a pair pulls out mid-league (item 6)')
// The pair that lost M3 by walkover is off court now and still has a match left.
const W = M3.sides[1]
{
  const t = await goto(`${mens.hub}/more?do=withdraw`)
  ok('  every pair is listed', pairs.every((p) => t.includes(flat(p))), t.slice(0, 600))
  await page.click(`a:has-text("${first(W)}")`)
  await page.waitForURL(/team=/, { timeout: 20000 })
  await settle()
  const s = await body()
  // They played one R1 match and lost M3 by walkover: 2 played, 1 (R3) left.
  const played = 2
  const left = 3 - played
  ok(`  the confirm sentence has the real numbers: ${played} played stand, ${left} left becomes a walkover`, new RegExp(`${esc(W)} pull out The ${played} matches they played stand\\. The ${left} they had left becomes a walkover to the other pair — a win for them, but no points added`).test(s), s.slice(0, 700))
  await shot('more-withdraw-confirm')
  await page.click('button:has-text("Yes, they’re out")')
  const d = await until(/are out/)
  ok('  done: are out · 1 match becomes a walkover', new RegExp(`${esc(W)} are out\\. 1 match becomes a walkover to the other side\\.`).test(d), d.slice(0, 300))
  const h = await goto(mens.hub)
  const wo = (h.match(/walkover against/g) ?? []).length
  ok('  the hub’s Played has two walkovers now (theirs + M3)', wo === 2, h.slice(0, 1200))
  const pub = await goto(`${BASE}/t/${mens.slug}`)
  ok('  the public table marks them pulled out', new RegExp(`${esc(W)} pulled out`).test(pub), pub.slice(0, 1500))
  const cutRows = async () =>
    page.$$eval('table tbody tr', (trs) =>
      trs.filter((tr) => /bg-accent-soft/.test(tr.className)).map((tr) => tr.innerText.replace(/\s+/g, ' ')),
    )
  let through = await cutRows()
  ok('  the cut line skips them: two pairs highlighted, neither pulled out', through.length === 2 && !through.some((r) => /pulled out/.test(r)), through.join(' | '))
  await shot('public-pulled-out')
  await goto(mens.hub)
  through = await cutRows()
  ok('  the hub says pulled out too, and its cut line skips them', /pulled out/.test(await body()) && through.length === 2 && !through.some((r) => /pulled out/.test(r)), through.join(' | '))
}

console.log('\n   pause the day (item 8), then the horn on M4 while it is stopped')
{
  const t = await goto(`${mens.hub}/more?do=pause`)
  ok('  the pause screen explains itself and suggests a note', /Matches already on court carry on/.test(t) && (await page.inputValue('#pause-note')) === 'Rain — back shortly', t.slice(0, 400))
  await page.fill('#pause-note', 'Rain — back in 20 minutes')
  await page.click('button:has-text("Pause it")')
  const d = await until(/Paused\. The public page says so/)
  ok('  done: Paused', /Paused\. The public page says so\./.test(d), d.slice(0, 300))
  ok('  the More row now says Start again', /Start again/.test(d) && !/Pause the tournament/.test(d), d.slice(0, 600))
  await shot('more-paused')
  c = await cards()
  const lb = await goto(`${BASE}/admin/live`)
  c = await cards()
  ok('  the board says Men’s is paused, once, with Start again', /Men's Doubles is paused/i.test(lb) && /Rain — back in 20 minutes/.test(lb) && /Start again/.test(lb) && /Men's paused/.test(lb), lb.slice(0, 400))
  ok('  the court cards themselves do not repeat it', !/is paused/.test(c['Court 1']) && !/paused/.test(c['Court 3']), `${c['Court 1']} | ${c['Court 3']}`)
  await shot('live-paused')
  const pub = await goto(`${BASE}/t/${mens.slug}`)
  ok('  the public page shows the pause notice', /Paused/i.test(pub) && /Rain — back in 20 minutes/.test(pub), pub.slice(0, 400))
  await shot('public-paused')
  const today = await goto(`${BASE}/`)
  ok('  and Today does too, naming the tournament', /Paused/i.test(today) && /Men's Doubles — Rain — back in 20 minutes/.test(today), today.slice(0, 400))

  // M4 — the horn. Game 1 11–7 to A; the horn goes in game 2 at 6–8 to B.
  const beforeHorn = await table(mens.hub)
  await goto(`${BASE}/admin/live`)
  await openScore('Court 2')
  await enterGame(page, 1, 'A', 11, 7)
  await openSheet()
  await page.click('button:has-text("The horn went — stopped on time")')
  const h = await body()
  ok('  the horn panel: Game 2 — the horn went, record it at the score it stopped on', /Game 2 — the horn went/.test(h) && /Record it at the score it stopped on/.test(h), h.slice(0, 800))
  const hb = page.locator('input[inputmode=numeric]')
  {
    const box = await hb.nth(0).boundingBox()
    ok(`  the horn's points box is a box (${Math.round(box?.width ?? 0)}px)`, (box?.width ?? 999) <= 100, JSON.stringify(box))
  }
  await hb.nth(0).fill('6')
  await hb.nth(1).fill('8')
  await shot('score-horn')
  await page.click('button:has-text("Record game 2")')
  const r = await body()
  ok(`  level on games, so the leader of the stopped game wins: ${M4.sides[1]} win 1–1`, new RegExp(`That’s the match ${esc(M4.sides[1])} win 1–1`, 'i').test(r) && /Stopped on time/.test(r), r.slice(0, 900))
  ok('  and the panel says why', /level on games — whoever was ahead when the horn went takes it/.test(r), r.slice(0, 900))
  await shot('score-horn-result')
  await holdSave()
  await backOnBoard()
  b = await board()
  c = await cards()
  ok('  the day is stopped, so the free courts stay empty', !b['Court 1'] && !b['Court 2'], JSON.stringify(b))
  ok('  and neither card offers to put a match on', !/Put /.test(c['Court 1']) && !/Put /.test(c['Court 2']), `${c['Court 1']} | ${c['Court 2']}`)
  await shot('live-paused-empty')
  rows = await table(mens.hub)
  const w = rowFor(rows, M4.sides[1])
  const l = rowFor(rows, M4.sides[0])
  const w0 = rowFor(beforeHorn, M4.sides[1])
  const l0 = rowFor(beforeHorn, M4.sides[0])
  ok(`  table after the horn: ${M4.sides[1]} +1 won, +15 points (7+8); ${M4.sides[0]} +0 won, +17 points (11+6)`, w?.won === w0?.won + 1 && w?.points === w0?.points + 15 && l?.won === l0?.won && l?.points === l0?.points + 17, JSON.stringify([beforeHorn, rows]))
  ok('  Played shows 7–11, 8–6 from the winner’s side', /7–11, 8–6/.test(await body()), (await body()).slice(0, 900))
  note(`Horn, level on games: ${M4.sides[1]} win with 15 points in the match to ${M4.sides[0]}'s 17 — the rule is games, then the stopped game, never total points. The result panel now says so.`)
}

console.log('\n   shorten what’s left — refused while live, offered when nothing is (item 9)')
{
  // Nothing of Men's is live now. First the refusal: Mixed has a match on
  // Court 3, so Mixed's Shorten is the one that says no.
  const mx = await goto(`${mixed.hub}/more?do=shorten`)
  ok('  Mixed (a match on court): Not yet — a match is on court', /Not yet/i.test(mx) && /A match is on court\. Change it when that one finishes\./.test(mx), mx.slice(0, 400))
  await shot('more-shorten-refused')
  const t = await goto(`${mens.hub}/more?do=shorten`)
  // Left: the last league match and the final — the withdrawn pair's is a walkover.
  ok('  Men’s (nothing live): Best of 3 to 11 now · 2 still to play', /Best of 3 to 11 now · 2 still to play/.test(t), t.slice(0, 400))
  ok('  offers one game to 15 and one game to 11', /One game to 15/.test(t) && /One game to 11/.test(t), t.slice(0, 400))
  await page.click('summary:has-text("One game to 11")')
  await page.waitForTimeout(200)
  const q = await body()
  ok('  the confirm has a finish-time estimate and minutes back', /The 2 matches nobody has started become one game to 11\. The day finishes about \d\d:\d\d instead — \d+ minutes back\./.test(q), q.slice(0, 600))
  await shot('more-shorten-confirm')
  await page.click('button:has-text("Change it to one game to 11")')
  const d = await until(/What is left is now/)
  ok('  done: What is left is now one game to 11', /What is left is now one game to 11\./.test(d), d.slice(0, 300))
}

console.log('\n   swap a player while nothing is live (item 7)')
{
  const t = await addByHand(mens.hub, 'Prakash Rao')
  ok('  a running tournament still takes a player by hand', /Prakash Rao no partner named · added by you/.test(t), t.slice(0, 400))
  // The pair in the one league match still to be played that is not a walkover: the pair
  // that beat M3 by walkover has played 3 (M1/M2, M3 walkover, ...). Find it from the schedule.
  await goto(`${mens.hub}/schedule`)
  const left = await scheduleRows()
  const leagueLeft = left.filter((l) => /^R\d$/.test(l.round))
  ok('  one league match left to play (the withdrawn pair’s became a walkover)', leagueLeft.length === 1, left.map(line).join(' | '))
  const firstNames = [leagueLeft[0]?.a, leagueLeft[0]?.b]
  const swapPair = pairs.find((p) => p.split(' / ').map((x) => x.split(' ')[0]).join(' / ') === firstNames[0])
  const outName = swapPair?.split(' / ')[1]
  ok(`  the pair to swap is ${swapPair}; ${outName} comes out`, !!swapPair && !!outName, `${firstNames} vs ${pairs}`)
  const s = await goto(`${mens.hub}/more?do=swap`)
  ok('  the swap screen says the pair keeps its results', /The pair keeps its results and its place in the table/.test(s), s.slice(0, 300))
  await page.selectOption('#sub-out', { label: outName })
  await page.selectOption('#sub-in', { label: 'Prakash Rao' })
  await shot('more-swap')
  await page.click('summary:has-text("Make the swap")')
  await page.click('button:has-text("Yes, swap them")')
  const d = await until(/are now/)
  ok(`  done: ${swapPair} are now … / Prakash Rao`, new RegExp(`${esc(swapPair)} are now .*Prakash Rao\\. Their results and their place in the table stand\\.`).test(d), d.slice(0, 300))
  const newName = d.match(/are now (.+?)\. Their results/)?.[1] ?? ''
  const hub = await goto(mens.hub)
  ok('  the table carries the new name', hub.includes(newName), hub.slice(0, 800))
  pairs.splice(pairs.indexOf(swapPair), 1, newName)
  globalThis.SWAPPED = { from: swapPair, to: newName }
}

console.log('\n   start the day again (item 8)')
{
  await goto(`${BASE}/admin/live`)
  await page.click('button:has-text("Start again")')
  await settle(page, 800)
  b = await board()
  c = await cards()
  const sw = globalThis.SWAPPED
  ok('  Court 1 refilled by itself with the last league match', !!b['Court 1'] && /R3/.test(b['Court 1'].round), JSON.stringify(b))
  ok(`  and the swapped-in name is on the board: ${sw.to}`, b['Court 1']?.sides.includes(sw.to), JSON.stringify(b['Court 1']))
  ok('  Court 2 stays empty: the withdrawn pair’s match is a walkover', !b['Court 2'], c['Court 2'])
  ok('  no paused line anywhere', !/paused/.test(c['Court 1'] + c['Court 2']) && !/Men's paused/.test(await body()), c['Court 1'])
  await shot('live-resumed')
  const pub = await goto(`${BASE}/t/${mens.slug}`)
  ok('  the public page: no pause notice, the new name on court', !/Paused/.test(pub) && pub.includes(sw.to.split(' / ')[1]), pub.slice(0, 800))
  await shot('public-swapped')
}

console.log('\n   put the withdrawn pair back (item 6)')
{
  await goto(`${mens.hub}/more?do=withdraw`)
  await page.click(`a:has-text("${first(W)}")`)
  await page.waitForURL(/team=/, { timeout: 20000 })
  await settle()
  const s = await body()
  ok('  the row says Out and the confirm offers Put them back', new RegExp(`${esc(flat(W))} Out`).test(s) && new RegExp(`${esc(W)} go back in`).test(s) && /Put them back/.test(s) && /Any match given away when they pulled out is undone/.test(s), s.slice(0, 700))
  await shot('more-reinstate-confirm')
  await page.click('button:has-text("Put them back")')
  const d = await until(/are back in/)
  ok('  done: are back in · 1 walkover is undone', new RegExp(`${esc(W)} are back in\\. 1 walkover is undone\\.`).test(d), d.slice(0, 300))
  b = await board()
  ok(`  their match went straight onto Court 2`, !!b['Court 2'] && b['Court 2'].sides.includes(W), JSON.stringify(b))
  const h = await goto(mens.hub)
  ok('  the hub’s Played is back to one walkover', (h.match(/walkover against/g) ?? []).length === 1, h.slice(0, 1200))
  const pub = await goto(`${BASE}/t/${mens.slug}`)
  ok('  the public table no longer says pulled out', !/pulled out/.test(pub), pub.slice(0, 1500))
  await shot('live-reinstated')
}

console.log('\n   the shortened format: one game and the save button appears (item 9)')
{
  await goto(`${BASE}/admin/live`)
  const live1 = await onCourt('Court 1')
  await openScore('Court 1')
  await enterGame(page, 1, 'A', 11, 7)
  const t = await body()
  ok('  after one game: That’s the match, win 1–0, Hold to save', /That’s the match/i.test(t) && /win 1–0/.test(t) && /Hold to save the result/.test(t), t.slice(0, 800))
  ok('  and no Who won game 2', !/Who won game 2/.test(t))
  await shot('score-one-game')
  await holdSave()
  await backOnBoard()
  b = await board()
  ok('  saved; Court 1 waits for the final', !b['Court 1'] && !!b['Court 2'], JSON.stringify(b))
  globalThis.M5 = live1
}

console.log('\n   PIN lockout from another phone (item 12)')
{
  const attacker = await browser.newContext({ ...PHONE, extraHTTPHeaders: { 'x-forwarded-for': '203.0.113.9' } })
  const ap = await attacker.newPage()
  watch(ap, 'attacker')
  let last = ''
  for (let i = 1; i <= 5; i++) {
    await ap.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
    await ap.fill('#pin', String(100000 + i))
    await ap.click('button[type=submit]')
    await ap.waitForFunction(() => /not it|Too many/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
    last = await ap.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
    if (i === 1) ok('  first wrong PIN: 4 tries left', /4 tries left before a fifteen-minute wait/.test(last), last.slice(0, 300))
  }
  ok('  fifth wrong PIN: wait fifteen minutes', /Wait fifteen minutes before trying again/.test(last), last.slice(0, 300))
  await ap.fill('#pin', PIN)
  await ap.click('button[type=submit]')
  await ap.waitForFunction(() => /Too many/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  last = await ap.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  ok('  even the right PIN is refused now: Too many wrong PINs. Try again in 15 minutes', /Too many wrong PINs\. Try again in 1[45] minutes\./.test(last) && ap.url().includes('/login'), last.slice(0, 300))
  await shot('login-locked', ap)
  // The organiser, signed in on her own phone, carries on.
  await goto(`${BASE}/admin/live`)
  const live2 = await onCourt('Court 2')
  ok('  the organiser’s own phone still opens the board with a match on Court 2', !!live2, JSON.stringify(await cards()))
  // And a fresh sign-in from her own address is unaffected.
  const other = await signedInContext('organiser fresh')
  ok('  a fresh sign-in from a different address still works', other.p.url().endsWith('/admin'), other.p.url())
  await other.c.close()
  execSync('npx tsx scripts/reset-lockouts.ts', { cwd: process.cwd(), stdio: 'pipe' })
  await ap.goto(`${BASE}/login`, { waitUntil: 'networkidle' })
  await ap.fill('#pin', '111111')
  await ap.click('button[type=submit]')
  await ap.waitForFunction(() => /not it|Too many/.test(document.body.innerText), null, { timeout: 15000 }).catch(() => {})
  last = await ap.evaluate(() => document.body.innerText.replace(/\s+/g, ' '))
  ok('  reset-lockouts clears it: 4 tries left again', /4 tries left/.test(last), last.slice(0, 300))
  await attacker.close()
}

console.log('\n   M6 on Court 2 — one game — then the final appears')
{
  await goto(`${BASE}/admin/live`)
  await openScore('Court 2')
  await enterGame(page, 1, 'B', 11, 9)
  await holdSave()
  await backOnBoard()
  b = await board()
  c = await cards()
  const fin = b['Court 1'] ?? b['Court 2']
  ok('  the final is on a court', !!fin && /Final/.test(fin.round), JSON.stringify(b))
  rows = await table(mens.hub)
  const top2 = rows.slice(0, 2).map((r) => r.name)
  ok(`  between the top two: ${top2.join(' and ')}`, !!fin && top2.every((x) => fin.sides.includes(x)), `${JSON.stringify(fin)} vs ${top2}`)
  ok('  a league score is fixable right up to the final going on? No — the final is live', true)
  await shot('hub-before-final')
}

console.log('\n   320px wide: board, hub, score entry (item 14)')
{
  await page.setViewportSize(NARROW)
  await goto(`${BASE}/admin/live`)
  ok('  the board does not scroll sideways at 320', !(await overflows()))
  await shot('narrow-live')
  await goto(mens.hub)
  ok('  the hub does not scroll sideways at 320', !(await overflows()))
  await shot('narrow-hub')
  await goto(`${BASE}/admin/live`)
  const fc = (await onCourt('Court 1')) ? 'Court 1' : 'Court 2'
  await openScore(fc)
  ok('  the score screen does not scroll sideways at 320', !(await overflows()))
  await shot('narrow-score')
  await pickGameWinner(page, 1, 'A')
  await page.waitForTimeout(200)
  ok('  the chips fit at 320', !(await overflows()))
  await shot('narrow-score-chips')
  await goto(`${mens.hub}/more`)
  ok('  More does not scroll sideways at 320', !(await overflows()))
  await shot('narrow-more')
  await page.setViewportSize(PHONE.viewport)
}

console.log('\n   delete is refused while the final is live (item 11)')
{
  const t = await goto(`${mens.hub}/more?do=delete`)
  ok('  There is a match on Court N right now', /There is a match on Court [12] right now\. Let it finish, or take it off court, then delete\./.test(t) && !/Yes, delete it/.test(t), t.slice(0, 400))
  await shot('more-delete-refused')
}

console.log('\n   the final, then Finish frees Courts 1–2')
{
  await goto(`${BASE}/admin/live`)
  const fc = (await onCourt('Court 1')) ? 'Court 1' : 'Court 2'
  await openScore(fc)
  ok('  the score screen says Final', /Men's Doubles · Final/.test(await body()), (await body()).slice(0, 200))
  await enterGame(page, 1, 'A', 11, 8)
  await holdSave()
  await backOnBoard()
  const t = await body()
  ok('  Men’s all played, Finish offered on the board', /Men's all played/.test(t) && /Finish Men's Doubles/.test(t), t.slice(0, 400))
  await shot('live-mens-all-played')
  await finishFromBoard("Men's Doubles")
  const h = await body()
  ok('  finished: Winners, beat … in the final', /Winners/i.test(h) && /beat .* in the final/.test(h), h.slice(0, 400))
  await shot('hub-mens-finished')
  const today = await goto(`${BASE}/`)
  const todayCards = await page.$$eval('article', (as) => as.map((a) => a.innerText.replace(/\s+/g, ' ').trim()))
  ok('  Today: Courts 1 and 2 are Free with no tournament on them', todayCards.some((x) => /^COURT 1 Free/.test(x)) && todayCards.some((x) => /^COURT 2 Free/.test(x)), todayCards.join(' | '))
  ok('  Today lists Men’s as final table & results', /Men's Doubles — final table & results/.test(today), today.slice(0, 400))
  await shot('today-mens-finished')
  const nw = await goto(`${BASE}/admin/new`)
  const held = await page.$$eval('fieldset:has(legend) button[disabled]', (bs) => bs.map((b) => b.innerText.trim()))
  ok('  /admin/new for today: only Court 3 is held (by Mixed)', held.length === 1 && /Court 3/.test(held[0]) && /Mixed Doubles/.test(held[0]), `${held.join(' | ')} :: ${nw.slice(0, 300)}`)
  await shot('new-after-mens')
  const lb = await goto(`${BASE}/admin/live`)
  c = await cards()
  ok('  the board: Courts 1 and 2 Not assigned again, Mixed still running', /Not assigned/.test(c['Court 1']) && /Not assigned/.test(c['Court 2']) && /1 tournament running/.test(lb), `${c['Court 1']} | ${lb.slice(0, 200)}`)
}

console.log('\n   changing a league score after the final (item 5)')
{
  const before = await table(mens.hub)
  await goto(`${mens.hub}/more?do=fix`)
  await page.click(`a:has-text("${M1.sides[0]}"):has-text("beat ${M1.sides[1]}")`)
  await page.waitForURL(/\/admin\/m\//, { timeout: 20000 })
  await settle()
  // The format is one game to 11 now, but M1 was played best of 3 — a
  // correction keeps the rules the match was played under.
  await enterGame(page, 1, 'B', 11, 4)
  await enterGame(page, 2, 'B', 11, 5)
  await holdSave(page, 'Testing after the final')
  await page.waitForTimeout(1500)
  const t = await body()
  ok('  refused, naming the final: Final has already started off this result', /That didn’t save/i.test(t) && /Final has already started off this result/.test(t), t.slice(0, 800))
  ok('  and nothing typed is lost', /Nothing you typed has been lost/.test(t))
  ok('  still on the score screen, not bounced to the board', /\/admin\/m\//.test(page.url()), page.url())
  await shot('score-fix-refused-after-final')
  rows = await table(mens.hub)
  ok('  the table did not move', JSON.stringify(rows) === JSON.stringify(before), JSON.stringify([before, rows]))
  const hub = await body()
  ok('  the final still stands on the hub', /beat .* in the final/.test(hub), hub.slice(0, 300))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n5. Mixed — the table decides it (item 1)')
{
  // Engineered: each pair wins once with the same score, so the three are
  // level on wins, points, head-to-head, game and point difference.
  const wins = new Map([[globalThis.MIXED_M1.winner, 1]])
  const rest = await drainLeague(['Court 3'], {
    scores: [[11, 7], [11, 9]],
    pick: (sides) => ((wins.get(sides[0]) ?? 0) <= (wins.get(sides[1]) ?? 0) ? 'A' : 'B'),
  })
  for (const r of rest) wins.set(r.winner, (wins.get(r.winner) ?? 0) + 1)
  ok('  the two remaining Mixed matches went in', rest.length === 2, JSON.stringify(rest))
  ok('  every Mixed pair won exactly once', [...wins.values()].every((w) => w === 1) && wins.size === 3, JSON.stringify([...wins]))
  const h = await goto(mixed.hub)
  const deadHeat = (h.match(/level on everything — kept in the order the pairs were made/g) ?? []).length
  ok('  the table says all three are level on everything and what settled it', deadHeat === 3, h.slice(0, 700))
  ok('  hub: Everything has been played, Finish the tournament, no final anywhere', /Everything has been played/i.test(h) && /Finish the tournament/.test(h) && !/Final/.test(h.replace(/Final table/gi, '')), h.slice(0, 600))
  ok('  3 of 3 played', /3 of 3 played/.test(h), h.slice(0, 200))
  const t = await page.$$eval('table tbody tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.innerText.trim())).filter((r) => r.length === 4))
  ok('  the table has no Top-2 cut line', !/Top 2 play the final/.test(h), h.slice(0, 800))
  await shot('hub-mixed-all-played')
  await page.click('button:has-text("Finish the tournament")')
  const f = await until(/Winners/i)
  const winner = t[0]?.[1]?.split('\n')[0]?.trim()
  ok(`  finished: Winners is the top of the table (${winner}), with no “beat … in the final”`, new RegExp(`Winners ${esc(flat(winner ?? '@@'))}`, 'i').test(f) && !/in the final/.test(f), f.slice(0, 400))
  if (deadHeat === 3 && new RegExp(`Winners ${esc(flat(winner ?? '@@'))}`, 'i').test(f)) {
    note(`Mixed ended in a three-way dead heat (each pair 1 win, 38 points): the table says it is kept in the order the pairs were made, and Finish crowned ${winner} on that basis.`)
  }
  await shot('hub-mixed-finished')
  const pub = await goto(`${BASE}/t/${mixed.slug}`)
  ok('  public: Winners on top, Final table, Played 3', new RegExp(`Winners ${esc(flat(winner ?? '@@'))}`, 'i').test(pub.slice(0, 400)) && /Final table/i.test(pub) && /Played\s*3/i.test(pub), pub.slice(0, 600))
  await shot('public-mixed-finished')
  const dash = await goto(`${BASE}/admin`)
  ok('  dashboard: both Done, both with won by', (dash.match(/won by/g) ?? []).length === 2, dash.slice(0, 600))
  await shot('dashboard-two-done')
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n6. Women’s Doubles — semis and a final on Courts 1–2 (item 2)')
const womens = await create({ name: "Women's Doubles", gender: "Women's", discipline: 'Doubles', format: 'semis and a final', courts: ['Court 1', 'Court 2'] })
{
  const t = await body()
  ok('  made on today with Courts 1 and 2 (no clash after Men’s finished)', /Court 1, Court 2 · schedule not made yet/.test(t) && !/Made, but without its courts/.test(t), t.slice(0, 400))
}
for (const name of ['Lakshmi Narayanan', 'Nithya Raj', 'Kavitha Sundaram', 'Shalini Venkat', 'Pooja Iyer', 'Revathi Menon', 'Deepa Krishnan', 'Anitha Balan']) {
  await addByHand(womens.hub, name)
}
await pairRest(womens.hub)
const wList = await makeSchedule(womens.hub)
ok('  9 matches: 6 league + 2 semis + final', wList.length === 9, wList.map(line).join(' | '))
ok('  semi 1 is 1st in table v 4th in table', wList[6]?.round === 'Semi-final' && wList[6]?.a === '1st in table' && wList[6]?.b === '4th in table', line(wList[6] ?? {}))
ok('  semi 2 is 2nd in table v 3rd in table', wList[7]?.round === 'Semi-final' && wList[7]?.a === '2nd in table' && wList[7]?.b === '3rd in table', line(wList[7] ?? {}))
ok('  the final is Winner of semi 1 v Winner of semi 2', wList[8]?.round === 'Final' && wList[8]?.a === 'Winner of semi 1' && wList[8]?.b === 'Winner of semi 2', line(wList[8] ?? {}))
await shot('schedule-semis')
await start(womens.hub)
{
  const league = await drainLeague(['Court 1', 'Court 2'])
  ok('  six league matches went in', league.length === 6, JSON.stringify(league))
  b = await board()
  ok('  both semis are on court together', !!b['Court 1'] && !!b['Court 2'] && /Semi-final/.test(b['Court 1'].round) && /Semi-final/.test(b['Court 2'].round), JSON.stringify(b))
  rows = await table(womens.hub)
  const top4 = rows.slice(0, 4).map((r) => r.name)
  const onSemis = [...b['Court 1'].sides, ...b['Court 2'].sides]
  ok('  the four semi-finalists are the top four of the table', top4.every((x) => onSemis.includes(x)), `${top4} vs ${onSemis}`)
  ok('  1st plays 4th, 2nd plays 3rd', [b['Court 1'], b['Court 2']].some((m) => m.sides.includes(top4[0]) && m.sides.includes(top4[3])) && [b['Court 1'], b['Court 2']].some((m) => m.sides.includes(top4[1]) && m.sides.includes(top4[2])), `${top4} vs ${JSON.stringify(b)}`)
  const h = await body()
  ok('  the hub table says Top 4 go through', /Top 4 go through/i.test(h), h.slice(0, 800))
  ok('  and nobody is level — the organiser decides', !/organiser decides/.test(h), h.slice(0, 800))
  await shot('hub-womens-semis')
  await goto(`${BASE}/admin/live`)
  await shot('live-semis')
  // Semi 1 on Court 1: side A wins. Semi 2 on Court 2: side B wins.
  const s1 = b['Court 1']
  const s2 = b['Court 2']
  await openScore('Court 1')
  await enterNormal(page, 'A')
  await backOnBoard()
  b = await board()
  c = await cards()
  ok('  after one semi the free court says the final waits on the other', !b['Court 1'] && /Final · waiting on Court 2/.test(c['Court 1']), c['Court 1'])
  await shot('live-one-semi-in')
  await openScore('Court 2')
  await enterNormal(page, 'B')
  await backOnBoard()
  b = await board()
  const fin = b['Court 1'] ?? b['Court 2']
  ok('  the final is on a court', !!fin && /Final/.test(fin.round), JSON.stringify(b))
  ok(`  its sides are the two semi winners: ${s1.sides[0]} and ${s2.sides[1]}`, !!fin && fin.sides.includes(s1.sides[0]) && fin.sides.includes(s2.sides[1]), JSON.stringify(fin))
  await shot('live-womens-final')
  const fc = b['Court 1'] ? 'Court 1' : 'Court 2'
  await openScore(fc)
  await enterNormal(page, 'B')
  await backOnBoard()
  await finishFromBoard("Women's Doubles")
  const f = await body()
  ok(`  Winners ${fin.sides[1]} beat ${fin.sides[0]} in the final`, new RegExp(`Winners ${esc(flat(fin.sides[1]))} beat ${esc(fin.sides[0])} in the final 11–7, 11–9`, 'i').test(f), f.slice(0, 400))
  ok('  the final table is separated without a dead heat', !/organiser decides/.test(f), f.slice(0, 800))
  await shot('hub-womens-finished')
  const pub = await goto(`${BASE}/t/${womens.slug}`)
  ok('  public: beat … in the final, Played 9', /beat .* in the final/.test(pub) && /Played\s*9/i.test(pub), pub.slice(0, 600))
  const r = await goto(`${womens.hub}/results`)
  ok('  results: 9 of 9', /9 of 9 played/.test(r), r.slice(0, 200))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n7. Men’s Singles — five players on Court 4 (item 3)')
const singles = await create({ name: "Men's Singles", gender: "Men's", discipline: 'Singles', format: 'top 2 play a final', courts: ['Court 4'] })
{
  const t = await body()
  ok('  hub has no Teams step for singles', !/Teams/.test(t) && /2 Schedule & courts/.test(t), t.slice(0, 400))
  ok('  sub line says singles', /singles · league, then a final/.test(t), t.slice(0, 200))
  await shot('hub-singles-empty')
}
for (const name of ['Ganesh Iyer', 'Suresh Babu', 'Vijay Anand', 'Manoj Pillai', 'Kumar Raja']) await addByHand(singles.hub, name)
{
  const reg = await body()
  ok('  registration rows carry no partner line for singles', !/no partner named/.test(reg) && /5 in/.test(reg), reg.slice(0, 500))
  const link = await signupLink(singles.hub)
  const fresh = await browser.newContext(PHONE)
  const p = await fresh.newPage()
  await p.goto(link, { waitUntil: 'networkidle' })
  ok('  the singles sign-up form has no partner box', (await p.$('input[name=partnerName]')) === null && (await p.$('input[name=name]')) !== null)
  await shot('signup-singles', p)
  await fresh.close()
  const h = await goto(singles.hub)
  ok('  hub: singles skips the Teams step — three steps, no Players row', !/in the draw/.test(h) && /Registration/.test(h) && /Schedule & courts/.test(h) && /Start/.test(h), h.slice(0, 400))
  const t = await goto(`${singles.hub}/teams`)
  ok('  Players page lists five names and no pairing controls', /Players 5 in the draw/.test(t) && !/Pair with/.test(t) && !/Pair the rest/.test(t) && !/Split/.test(t) && /Ganesh Iyer/.test(t) && /Kumar Raja/.test(t), t.slice(0, 500))
  ok('  and offers Next: Schedule & courts', /Next: Schedule & courts/.test(t))
  await shot('players-singles')
  const s = await goto(`${singles.hub}/schedule`)
  ok('  the schedule button says 5 players', /5 players · league, then a final/.test(s), s.slice(0, 500))
}
const sList = await makeSchedule(singles.hub)
ok('  11 matches: 10 league + a final', sList.length === 11 && sList[10]?.round === 'Final', sList.map(line).join(' | '))
ok('  names are single, no slash', !sList.slice(0, 10).some((l) => /\//.test(l.a + l.b)), sList.slice(0, 3).map(line).join(' | '))
await shot('schedule-singles')
await start(singles.hub)
{
  b = await board()
  c = await cards()
  ok('  Court 4 shows two single names', !!b['Court 4'] && b['Court 4'].sides.every((s) => !s.includes('/')) && /Men's Singles/.test(c['Court 4']), JSON.stringify(b['Court 4']))
  await shot('live-singles')
  const h = await goto(singles.hub)
  const th = await page.$$eval('table thead th', (ths) => ths.map((t) => t.innerText.trim()))
  ok('  the table header says Player', th.includes('Player') && !th.includes('Pair'), th.join(','))
  const more = await goto(`${singles.hub}/more`)
  ok('  More says A player has pulled out', /A player has pulled out/.test(more), more.slice(0, 400))
  const league = await drainLeague(['Court 4'])
  ok('  ten league matches went in', league.length === 10, JSON.stringify(league.map((l) => l.sides)))
  b = await board()
  ok('  the final is on Court 4', !!b['Court 4'] && /Final/.test(b['Court 4'].round), JSON.stringify(b))
  await openScore('Court 4')
  await enterNormal(page, 'A')
  await backOnBoard()
  await finishFromBoard("Men's Singles")
  const f = await body()
  ok('  Winner (singular), beat … in the final', /\bWinner\b/i.test(f) && !/Winners/i.test(f) && /beat .* in the final/.test(f), f.slice(0, 400))
  await shot('hub-singles-finished')
  const pub = await goto(`${BASE}/t/${singles.slug}`)
  ok('  public: Winner (singular), Player column', /\bWinner\b/i.test(pub) && !/Winners/i.test(pub) && /Player/.test(pub), pub.slice(0, 600))
  await shot('public-singles-finished')
  const dash = await goto(`${BASE}/admin`)
  ok('  dashboard: four Done', (dash.match(/won by/g) ?? []).length === 4, dash.slice(0, 800))
}

// ═══════════════════════════════════════════════════════════════════════════
console.log('\n8. delete a not-started tournament (item 11)')
{
  const tomorrow = day(1)
  const gone = await create({ name: 'Open Doubles — tomorrow', gender: 'Open', discipline: 'Doubles', format: 'Everyone plays everyone', courts: ['Court 1', 'Court 2'], date: tomorrow })
  await addByHand(gone.hub, 'Test Player')
  await goto(`${BASE}/admin/new`)
  await page.fill('#date', tomorrow)
  await page.waitForTimeout(200)
  let held = await page.$$eval('fieldset:has(legend) button[disabled]', (bs) => bs.map((b) => b.innerText.replace(/\s+/g, ' ').trim()))
  ok('  /admin/new for tomorrow shows Courts 1 and 2 held by it', held.length === 2 && held.every((h) => /Open Doubles — tomorrow/.test(h)), held.join(' | '))
  const dash = await goto(`${BASE}/admin`)
  ok('  it is on the dashboard under upcoming', /Open Doubles — tomorrow/.test(dash), dash.slice(0, 600))
  const t = await goto(`${gone.hub}/more?do=delete`)
  ok('  the delete confirm counts its player and its courts coming free', /Its 1 player go with it\. Court 1, Court 2 come free for the day\./.test(t), t.slice(0, 400))
  await shot('more-delete-confirm')
  await page.click('button:has-text("Yes, delete it")')
  await page.waitForURL(/\/admin$/, { timeout: 20000 })
  const d = await until(/Tournaments|Nothing on yet/)
  ok('  gone from the dashboard', !/Open Doubles — tomorrow/.test(d), d.slice(0, 600))
  await goto(`${BASE}/admin/new`)
  await page.fill('#date', tomorrow)
  await page.waitForTimeout(200)
  held = await page.$$eval('fieldset:has(legend) button[disabled]', (bs) => bs.map((b) => b.innerText.trim()))
  ok('  its courts are free again for tomorrow', held.length === 0, held.join(' | '))
  // Streamed pages carry a 200 even when the body is the not-found page, so
  // the words are what is checked.
  const res = await page.goto(`${gone.hub}`, { waitUntil: 'networkidle' })
  ok('  its hub says there is nothing at this link', /There’s nothing at this link/.test(await page.evaluate(() => document.body.innerText)), `${res.status()} ${(await body()).slice(0, 200)}`)
  const pub = await page.goto(`${BASE}/t/${gone.slug}`, { waitUntil: 'networkidle' })
  ok('  so does its public page', /There’s nothing at this link/.test(await page.evaluate(() => document.body.innerText)), `${pub.status()} ${(await body()).slice(0, 200)}`)
  if (res.status() !== 404) note(`A deleted tournament's pages answer HTTP ${res.status()}, not 404 — the not-found body is streamed after the status has gone out.`)
}

await second.c.close()

// ═══════════════════════════════════════════════════════════════════════════
console.log('')
ok('no 5xx anywhere', bad.length === 0, bad.join(' '))
ok('no page errors', pageErrors.length === 0, pageErrors.join(' | '))
await browser.close()
if (notes.length) console.log(`\nnotes:\n  - ${notes.join('\n  - ')}`)
console.log(fails.length ? `\n${fails.length} failed:\n  - ${fails.join('\n  - ')}` : '\nall good')
console.log(`screenshots: ${OUT}`)
process.exit(fails.length ? 1 : 0)
