/**
 * End-to-end smoke test against a running dev server.
 *   npm run dev            # in one shell
 *   node scripts/smoke.mjs # in another
 */
let chromium
try {
  ;({ chromium } = await import('playwright'))
} catch {
  console.error('Playwright is not installed. Run:  npm run smoke:setup')
  process.exit(1)
}

const BASE = process.env.BASE ?? 'http://localhost:3100'
// CHROME is only needed where a preinstalled browser must be pointed at explicitly.
const EXE = process.env.CHROME
const browser = await chromium.launch({
  ...(EXE ? { executablePath: EXE } : {}),
  args: ['--no-sandbox'],
})
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } })
const page = await ctx.newPage()

const fails = []
const ok = (label, cond, extra = '') =>
  cond ? console.log(`  ok    ${label}`) : (fails.push(label), console.log(`  FAIL  ${label} ${extra}`))

console.log('\npublic')
await page.goto(`${BASE}/`)
ok('home page renders without a login', (await page.content()).includes('Nothing on right now'))

console.log('\nguards')
await page.goto(`${BASE}/admin`)
ok('signed-out /admin redirects to login', page.url().includes('/login'), page.url())

console.log('\nsign in')
await page.goto(`${BASE}/login`)
await page.fill('#username', 'saurabh')
await page.fill('#password', 'definitely-wrong')
await page.click('button[type=submit]')
await page.waitForFunction(
  () => (document.querySelector('[role=alert]')?.textContent ?? '').trim().length > 0,
  null,
  { timeout: 15000 },
)
const rejectMsg = (await page.textContent('[role=alert]')) ?? ''
ok('wrong password is rejected', /match|attempts/i.test(rejectMsg), `got: ${JSON.stringify(rejectMsg)}`)

// React clears the form after a failed action, so start the real attempt fresh.
await page.goto(`${BASE}/login`)
await page.fill('#username', 'saurabh')
await page.fill('#password', 'change-me-now')
await page.click('button[type=submit]')
await page.waitForURL('**/admin/**', { timeout: 20000 })
ok('correct password signs in', page.url().includes('/admin'))
ok('temporary password forces a change', (await page.content()).includes('temporary'))

await page.goto(`${BASE}/admin`)
ok('dashboard reachable when signed in', (await page.content()).includes('Nothing on yet'))
await page.screenshot({ path: '/tmp/shot-admin.png' })

console.log('\nsign out')
await page.click('text=Sign out')
await page.waitForURL('**/login**', { timeout: 20000 })
await page.goto(`${BASE}/admin`)
ok('session is really gone', page.url().includes('/login'), page.url())

await browser.close()
console.log(fails.length ? `\n${fails.length} failing\n` : '\nall smoke checks passed\n')
process.exit(fails.length ? 1 : 0)
