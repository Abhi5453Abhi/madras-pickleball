/**
 * Walks the Teams screen in a real browser: mutual pairs made on load, the
 * partner picker, split, pair the rest at random (with an odd one out), the
 * screen going read-only once the schedule exists, and singles as a plain
 * list. Screenshots go to /tmp/shots-teams/.
 *
 *   BASE=http://localhost:3402 node scripts/stage2-teams.mjs
 *
 * Seeds its own tournaments through scripts/seed-teams.ts unless SLUGS is
 * given as "doubles,singles,odd". Signs in with 482913, or with the temporary
 * PIN on a fresh database and picks 482913 then.
 */
import { chromium } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3402'
const EXE = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
]
  .filter(Boolean)
  .find((p) => existsSync(p))
const OUT = process.env.OUT ?? '/tmp/shots-teams'
mkdirSync(OUT, { recursive: true })

let slugs
if (process.env.SLUGS) {
  const [doubles, singles, odd] = process.env.SLUGS.split(',')
  slugs = { doubles, singles, odd }
} else {
  const out = execFileSync('npx', ['tsx', 'scripts/seed-teams.ts'], {
    env: { ...process.env, NODE_OPTIONS: '--conditions=react-server' },
    encoding: 'utf8',
  })
  slugs = Object.fromEntries(
    out
      .trim()
      .split('\n')
      .map((l) => l.split(' '))
      .filter(([k]) => ['doubles', 'singles', 'odd'].includes(k)),
  )
}
console.log('seeded', slugs)

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
  c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l} ${String(extra).slice(0, 300)}`))
// innerText, not textContent: the RSC payload is a <script> whose text repeats
// the whole page, which doubles every count. Whitespace collapsed to one space.
const body = () =>
  page.evaluate(() => (document.querySelector('main') ?? document.body).innerText.replace(/\s+/g, ' '))
let n = 0
const shot = async (name) => {
  n += 1
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(400)
  await page.screenshot({ path: `${OUT}/teams-${String(n).padStart(2, '0')}-${name}.png`, fullPage: true })
}
const settle = async () => {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(300)
}

const D = `${BASE}/admin/t/${slugs.doubles}`
const S = `${BASE}/admin/t/${slugs.singles}`
const O = `${BASE}/admin/t/${slugs.odd}`

console.log('\n1. sign in')
await page.goto(`${BASE}/login`)
// The chosen PIN first: a wrong guess counts against the lockout, and the
// temporary PIN is wrong on every run but the first.
await page.fill('#pin', '482913')
await page.click('button[type=submit]')
await page.waitForTimeout(1500)
if (/not it/.test(await body())) {
  await page.fill('#pin', '123456')
  await page.click('button[type=submit]')
}
await page.waitForURL(/\/admin/, { timeout: 20000 })
await settle()
if (page.url().includes('/admin/account')) {
  await page.fill('#current', '123456')
  await page.fill('#next', '482913')
  await page.fill('#confirm', '482913')
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin$/, { timeout: 20000 })
}
ok('signed in', /\/admin$/.test(page.url()), page.url())

console.log('\n2. the hub before anything is paired')
await page.goto(D)
await settle()
let t = await body()
ok('registration says 12 in', /12 players in/.test(t), t.slice(0, 300))
await shot('hub-before')

console.log('\n3. teams: mutual pairs are made on load')
await page.goto(`${D}/teams`)
await settle()
t = await body()
ok('sub says 2 pairs made · 8 still to pair', /2 pairs made · 8 players still to pair/.test(t), t.slice(0, 400))
ok('Karthik and Sathish named each other', /Karthik Subramanian Sathish Kumar named each other/.test(t))
ok('Hari and Naveen named each other', /Hari Venkatesh Naveen Krishnan named each other/.test(t))
ok('two mutual ticks', (t.match(/✓ mutual/g) ?? []).length === 2)
ok('Pairs · 2 of 6', /PAIRS ?2 of 6/i.test(t))
ok('Still to pair · 8 players', /STILL TO PAIR ?8 players/i.test(t))
ok('Arun named nobody and can pair', /Arun Prakash named nobody Pair with…/.test(t))
ok('Manoj: Suresh named Ganesh', /Manoj Pillai wants Suresh Babu Suresh named Ganesh/.test(t))
ok('Suresh: Ganesh named Manoj', /Suresh Babu wants Ganesh Iyer Ganesh named Manoj/.test(t))
ok('Ganesh: Manoj named Suresh', /Ganesh Iyer wants Manoj Pillai Manoj named Suresh/.test(t))
ok('Ravi wants someone not signed up', /Ravi Shankar wants Priya \(not signed up\) Pair with…/.test(t))
ok('the random button is there', /Pair the rest at random/.test(t))
ok('no next-step link yet', !/Next: Schedule/.test(t))
await shot('teams-half')

console.log('\n4. the hub agrees')
await page.goto(D)
await settle()
t = await body()
ok('teams step: 2 of 6 pairs made · 8 still to pair', /2 of 6 pairs made · 8 players still to pair/.test(t), t.slice(0, 400))

console.log('\n5. pair Arun by hand')
await page.goto(`${D}/teams`)
await settle()
await page.click('a:has-text("Arun Prakash")')
await page.waitForURL(/\/teams\/pair\//, { timeout: 20000 })
await settle()
t = await body()
ok('picker is titled for Arun', /Pair Arun Prakash with/.test(t))
const freeNames = await page.$$eval('form button[type=submit]', (bs) => bs.map((b) => b.textContent))
ok('lists the seven free people', freeNames.length === 7, freeNames.join('|'))
ok('not the paired ones', !/Karthik|Sathish|Hari|Naveen/.test(t))
ok('not Arun himself', !freeNames.some((s) => /Arun/.test(s)))
ok('Manoj wants Suresh', /Manoj Pillai wants Suresh/.test(t))
ok('the note about splitting is there', /split and re-made any time before the schedule is made/.test(t))
await shot('picker')
await page.click('button:has-text("Ganesh Iyer")')
await page.waitForURL(/\/teams$/, { timeout: 20000 })
await settle()
t = await body()
ok('back on Teams with 3 pairs · 6 to pair', /3 pairs made · 6 players still to pair/.test(t), t.slice(0, 300))
ok('Arun / Ganesh paired by you', /Arun Prakash Ganesh Iyer paired by you/.test(t))
ok('Suresh now sees Ganesh is paired', /Suresh Babu wants Ganesh Iyer Ganesh is paired already/.test(t))
ok('the split control is there', /Split/.test(t))
await shot('teams-after-pair')

console.log('\n6. only the pile links to the picker')
const pairLinks = await page.evaluate(() =>
  [...document.querySelectorAll('a[href*="/teams/pair/"]')].map((a) => a.getAttribute('href')),
)
ok('six people left, six picker links', pairLinks.length === 6, pairLinks.length)

console.log('\n7. split Arun and Ganesh')
await page.click('summary:has-text("Arun Prakash")')
await page.waitForTimeout(200)
await shot('split-open')
await page.click('details[open] button:has-text("Split them")')
await page.waitForTimeout(1500)
await settle()
t = await body()
ok('both are back in the pile', /2 pairs made · 8 players still to pair/.test(t), t.slice(0, 300))
ok('mutual pairs survived', (t.match(/✓ mutual/g) ?? []).length === 2)

console.log('\n8. pair the rest at random')
await page.click('summary:has-text("Pair the rest at random")')
await page.waitForTimeout(200)
t = await body()
ok('asks first', /Pair the 8 people left at random\?/.test(t))
await shot('random-confirm')
await page.click('button:has-text("Pair them")')
await page.waitForTimeout(1500)
await settle()
t = await body()
ok('everyone is paired', /6 pairs made · everyone is paired/.test(t), t.slice(0, 300))
ok('no pile left', !/Still to pair/.test(t))
ok('Pairs · 6 of 6', /PAIRS ?6 of 6/i.test(t))
ok('four paired by you', (t.match(/paired by you/g) ?? []).length === 4)
ok('next step offered', /Next: Schedule & courts/.test(t))
await shot('teams-done')

console.log('\n9. the hub says done')
await page.goto(D)
await settle()
t = await body()
ok('teams step: 6 of 6 pairs made', /6 of 6 pairs made/.test(t) && !/still to pair/.test(t), t.slice(0, 400))

console.log('\n10. the same button twice gives the same pairs')
await page.goto(`${D}/teams`)
await settle()
// A pair as the sorted pair of names, so the order the shuffle put them in
// does not count as a difference.
const pairSet = () =>
  page.$$eval('details > summary', (ss) =>
    ss
      .map((s) => s.innerText.split('\n').map((x) => x.trim()).filter((x) => x && !/paired by you|Split/.test(x)))
      .map((names) => names.sort().join(' + '))
      .sort(),
  )
const pairsBefore = await pairSet()
await page.click('summary:has-text("paired by you")')
await page.waitForTimeout(200)
await page.click('details[open] button:has-text("Split them")')
await page.waitForTimeout(1500)
await settle()
await page.click('summary:has-text("Pair the rest at random")')
await page.waitForTimeout(200)
await page.click('button:has-text("Pair them")')
await page.waitForTimeout(1500)
await settle()
t = await body()
ok('everyone is paired again', /6 pairs made · everyone is paired/.test(t))
const pairsAfter = await pairSet()
ok('the split pair came back the same', pairsBefore.length === 4 && pairsBefore.join('|') === pairsAfter.join('|'), `${pairsBefore.join('|')} vs ${pairsAfter.join('|')}`)

console.log('\n11. make the schedule, and Teams goes read-only')
await page.goto(`${D}/schedule`)
await settle()
await page.click('button:has-text("Make the schedule")')
await page.waitForTimeout(2500)
await settle()
t = await body()
ok('schedule has matches', /\d+ matches/.test(t), t.slice(0, 300))
await shot('schedule-made')
await page.goto(`${D}/teams`)
await settle()
t = await body()
ok('the locked note shows', /The schedule is made\. Changing pairs is under More\./.test(t))
ok('no split', !/Split/.test(t))
ok('no random button', !/Pair the rest at random/.test(t))
ok('pairs still listed', /6 pairs made/.test(t))
await shot('teams-locked')
await page.goto(`${D}/teams/pair/${pairLinks[0]?.split('/').pop() ?? 'ply_x'}`)
await settle()
ok('the picker bounces back to Teams', /\/teams$/.test(page.url()), page.url())

console.log('\n12. an odd pile leaves one out and says who')
await page.goto(`${O}/teams`)
await settle()
t = await body()
ok('5 to pair', /0 pairs made · 5 players still to pair/.test(t), t.slice(0, 300))
await page.click('summary:has-text("Pair the rest at random")')
await page.waitForTimeout(200)
t = await body()
ok('warns about the odd number', /5 is an odd number, so one person will be left out/.test(t))
await page.click('button:has-text("Pair them")')
await page.waitForTimeout(1500)
await settle()
t = await body()
ok('2 pairs · 1 to pair', /2 pairs made · 1 player still to pair/.test(t), t.slice(0, 300))
ok('names the odd one out', /is the odd one out — add or remove a player/.test(t))
ok('no random button for one person', !/Pair the rest at random/.test(t))
await shot('teams-odd')

console.log('\n13. singles: the schedule can be made without ever opening Players')
await page.goto(`${S}/schedule`)
await settle()
t = await body()
const disabled = await page.$eval('button:has-text("Make the schedule")', (b) => b.disabled)
ok('the button is live and counts 6 players', !disabled && /6 players · everyone plays everyone/.test(t), t.slice(0, 300))
await page.click('button:has-text("Make the schedule")')
await page.waitForTimeout(2500)
await settle()
t = await body()
ok('singles schedule made (15 matches for 6)', /15 matches/.test(t), t.slice(0, 300))
await shot('singles-schedule')
await page.goto(`${S}/teams`)
await settle()
t = await body()
ok('titled Players', /Players 6 in the draw/.test(t), t.slice(0, 300))
ok('names listed', /Anita Rao/.test(t) && /Priya Raman/.test(t))
ok('no pairing controls', !/Pair with|Split|random|schedule is made/.test(t))
await shot('singles-players')
await page.goto(S)
await settle()
t = await body()
ok('hub: Players step reads 6 in the draw', /Players — done 6 in the draw/.test(t), t.slice(0, 400))

console.log('\n14. nobody registered')
await page.goto(`${BASE}/admin/new`)
await settle()
await page.click('button:has-text("Court 1")').catch(() => {})
await page.click('button:has-text("Create")')
await page.waitForURL(/\/admin\/t\//, { timeout: 20000 })
const fresh = page.url().split('/admin/t/')[1].split(/[/?]/)[0]
await page.goto(`${BASE}/admin/t/${fresh}/teams`)
await settle()
t = await body()
ok('empty state points at Registration', /Nobody has signed up yet/.test(t) && /Registration/.test(t))
await shot('teams-empty')

ok('no 5xx anywhere', bad.length === 0, bad.join(' '))
await browser.close()
console.log(fails.length ? `\n${fails.length} failed:\n  ${fails.join('\n  ')}` : '\nall good')
process.exit(fails.length ? 1 : 0)
