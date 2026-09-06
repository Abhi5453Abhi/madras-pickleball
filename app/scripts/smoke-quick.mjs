/** End-to-end: sign in, run Quick Play, check the draw that comes out. */
import { chromium } from 'playwright'

const BASE = process.env.BASE ?? 'http://localhost:3200'
const EXE = process.env.CHROME
const browser = await chromium.launch({ ...(EXE ? { executablePath: EXE } : {}), args: ['--no-sandbox'] })
const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage()
page.on('pageerror', (e) => console.log('  pageerror:', e.message.slice(0, 200)))

const fails = []
const ok = (l, c, extra = '') => (c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l} ${extra}`)))

await page.goto(`${BASE}/login`)
await page.fill('#username', 'saurabh')
await page.fill('#password', 'change-me-now')
await page.click('button[type=submit]')
await page.waitForURL('**/admin**', { timeout: 20000 })

console.log('\nquick play')
await page.goto(`${BASE}/admin/quick`)
await page.fill('#name', 'Sunday Social — test')
await page.click('text=Doubles >> nth=0')
await page.fill(
  '#players',
  ['1. Ravi Kumar ✅', '2) Priya S 9840012345', '- Karthik', '• Meera Nair', '5. Arun', '6. Deepa', '7. Suresh', '8. Kiran'].join('\n'),
)
await page.waitForFunction(() => document.body.innerText.includes('8 players'), null, { timeout: 8000 })
ok('live count matches the parsed list', (await page.content()).includes('8 players · 4 teams'))

await Promise.all([
  page.waitForURL('**/admin/t/**', { timeout: 30000 }).catch(() => {}),
  page.click('button[type=submit]'),
])
ok('quick play creates a tournament', page.url().includes('/admin/t/'), page.url())

const body = await page.innerText('body')
ok('it is live', /Live/i.test(body))
ok('four teams appear in the table', (body.match(/ \/ /g) ?? []).length >= 4)
ok('six league matches were created', /7 matches|6 matches/.test(body), body.split('\n').slice(0, 6).join(' | '))
ok('a final is waiting on the table', body.includes('To be decided'))
ok('the tiebreak rule is printed', body.includes('total points scored'))
await page.screenshot({ path: '/tmp/shot-tournament.png', fullPage: true })

await browser.close()
console.log(fails.length ? `\n${fails.length} failing\n` : '\nall checks passed\n')
process.exit(fails.length ? 1 : 0)
