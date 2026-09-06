/**
 * Walks Registration in a real browser: the organiser's link, three people
 * signing up through it (two naming each other), one added by hand, a
 * possible duplicate settled both ways, a removal, closing and reopening.
 * Screenshots go to /tmp/shots-reg/.
 *
 *   BASE=http://localhost:3401 node scripts/stage2-reg.mjs
 */
import { chromium } from 'playwright-core'
import { existsSync, mkdirSync } from 'node:fs'

const BASE = process.env.BASE ?? 'http://localhost:3401'
const EXE = [
  process.env.CHROME,
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/opt/pw-browsers/chromium',
  '/usr/bin/chromium',
].filter(Boolean).find((p) => existsSync(p))
const OUT = process.env.OUT ?? '/tmp/shots-reg'
mkdirSync(OUT, { recursive: true })

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
  c ? console.log(`  ok    ${l}`) : (fails.push(l), console.log(`  FAIL  ${l} ${extra}`))
// Without the scripts: after a server action the page updates in place, and
// the flight payload from the first render is still in the document.
const body = (p = page) =>
  p.evaluate(() => {
    const clone = document.body.cloneNode(true)
    clone.querySelectorAll('script').forEach((s) => s.remove())
    return clone.textContent ?? ''
  })
let n = 0
const shot = async (name, p = page) => {
  n += 1
  await p.waitForLoadState('networkidle').catch(() => {})
  await p.waitForTimeout(400)
  await p.screenshot({ path: `${OUT}/reg-${String(n).padStart(2, '0')}-${name}.png`, fullPage: true })
}
const settle = async () => {
  await page.waitForLoadState('networkidle').catch(() => {})
  await page.waitForTimeout(500)
}
/** Wait for the organiser's page to say something, then hand back all of it. */
const until = async (re, ms = 20000) => {
  await page
    .waitForFunction(
      (src) => {
        const clone = document.body.cloneNode(true)
        clone.querySelectorAll('script').forEach((s) => s.remove())
        return new RegExp(src).test(clone.textContent ?? '')
      },
      re.source,
      { timeout: ms },
    )
    .catch(() => {})
  await settle()
  return body()
}

console.log('\n1. sign in')
await page.goto(`${BASE}/login`)
await page.fill('#pin', '123456')
await page.click('button[type=submit]')
await page.waitForURL(/\/admin|not it/, { timeout: 30000 }).catch(() => {})
await page.waitForTimeout(500)
if (page.url().includes('/admin/account')) {
  await page.fill('#current', '123456')
  await page.fill('#next', '482913')
  await page.fill('#confirm', '482913')
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin$/, { timeout: 20000 })
} else if (!page.url().endsWith('/admin')) {
  // A database that has been through this before.
  await page.fill('#pin', '482913')
  await page.click('button[type=submit]')
  await page.waitForURL(/\/admin$/, { timeout: 20000 })
}
ok('signed in', page.url().endsWith('/admin'))

console.log('\n2. a doubles tournament')
await page.goto(`${BASE}/admin/new`)
await page.waitForSelector('#name')
await page.click('button:has-text("Court 1")')
await page.click('button:has-text("Create")')
await page.waitForURL(/\/admin\/t\//, { timeout: 20000 })
const slug = page.url().split('/admin/t/')[1].split(/[/?]/)[0]
ok('made', !!slug)
const REG = `${BASE}/admin/t/${slug}/registration`

console.log('\n3. registration — the link is there straight away')
await page.goto(REG)
await settle()
let t = await body()
ok('header and sub line', /Registration/.test(t) && /0 in · sign-ups open/.test(t), t.slice(0, 200))
const m = t.match(/\/r\/([0-9A-Z]{5}-[0-9A-Z]{5})/)
ok('a link is shown without a "make the link" step', !!m, t.slice(0, 300))
const LINK = `${BASE}/r/${m?.[1]}`
ok('copy and WhatsApp', /Copy/.test(t) && /Send on WhatsApp/.test(t))
ok('nobody on the list yet', /Nobody on the list yet/.test(t))
const wa = await page.getAttribute('a:has-text("Send on WhatsApp")', 'href')
ok('WhatsApp link carries the URL', wa?.startsWith('https://wa.me/?text=') && decodeURIComponent(wa).includes(`/r/${m?.[1]}`), wa)
await shot('organiser-empty')

/** Sign somebody up from a browser that has never seen the site. */
async function signup(name, partner, phone, expect = /You’re on the list\./) {
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const p = await fresh.newPage()
  p.on('response', (r) => {
    if (r.status() >= 500) bad.push(`${r.status()} ${r.url()}`)
  })
  await p.goto(LINK)
  await p.waitForSelector('input[name=name]')
  const cookies = await fresh.cookies()
  ok(`  the form set no cookie for ${name}`, cookies.length === 0, JSON.stringify(cookies))
  await p.fill('input[name=name]', name)
  if (phone) await p.fill('input[name=phone]', phone)
  if (partner) await p.fill('input[name=partnerName]', partner)
  await p.click('button:has-text("Sign me up")')
  await p.waitForFunction(() => /on the list|closed|doesn/.test(document.body.textContent ?? ''), null, { timeout: 20000 }).catch(() => {})
  const text = await body(p)
  ok(`  ${name} → ${expect}`, expect.test(text), text.slice(0, 300))
  return { p, fresh, text }
}

console.log('\n4. three people through the link')
{
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const p = await fresh.newPage()
  await p.goto(LINK)
  await p.waitForSelector('input[name=name]')
  t = await body(p)
  ok('the form: name, phone, partner, Sign me up', /Your name/.test(t) && /only the organiser sees it/.test(t) && /Playing with someone\?/.test(t) && /If you leave this blank the organiser pairs you up\./.test(t) && /Sign me up/.test(t))
  await p.fill('input[name=name]', 'Deepak Raj')
  await shot('form', p)
  await fresh.close()
}
const a = await signup('Karthik Subramanian', 'Sathish Kumar')
await shot('form-done', a.p)
ok('the success card wording', /The organiser sorts the pairs before the day\. Ask your partner to sign up too and put your name down\./.test(a.text))
await a.fresh.close()
const b = await signup('Sathish Kumar', 'Karthik Subramanian', '98400 11111')
const c = await signup('Hari Venkatesh', 'Naveen Krishnan')

await page.goto(REG)
await settle()
t = await body()
ok('3 in', /3 in · sign-ups open/.test(t))
ok('Karthik wants Sathish · via link', /Karthik Subramanianwants Sathish Kumar · via link/.test(t))
ok('Sathish wants Karthik · via link', /Sathish Kumarwants Karthik Subramanian · via link/.test(t))
ok('Hari wants Naveen (not on the list) · via link', /Hari Venkateshwants Naveen Krishnan · via link/.test(t))
await shot('organiser-three')

console.log('\n5. one added by hand, with a phone')
await page.fill('[name=text]', 'Arun Prakash 98400 12345')
await page.click('button:has-text("Add")')
t = await until(/Arun Prakash/)
ok('Arun Prakash · no partner named · added by you', /Arun Prakashno partner named · added by you/.test(t), t.slice(0, 400))
ok('the box is empty again', (await page.inputValue('[name=text]')) === '')
await page.fill('[name=text]', 'arun prakash')
await page.click('button:has-text("Add")')
t = await until(/already on the list/)
ok('typing him again is refused', /Arun Prakash is already on the list\./.test(t))
await page.goto(REG)

const d = await signup('Ravi Shankar', 'Arun Prakash')
await d.fresh.close()
await page.goto(REG)
await settle()
t = await body()
ok('Ravi Shankar wants Arun Prakash (resolved to the roster)', /Ravi Shankarwants Arun Prakash · via link/.test(t))
await shot('organiser-five')

console.log('\n6. the same phone is the same person')
const e = await signup('A Prakash', null, '9840012345', /You’re already on the list\./)
await e.fresh.close()
console.log('\n7. the same browser sending the same name again')
await c.p.goto(LINK)
await c.p.fill('input[name=name]', 'Hari Venkatesh')
await c.p.click('button:has-text("Sign me up")')
await c.p.waitForFunction(() => /on the list/.test(document.body.textContent ?? ''), null, { timeout: 20000 }).catch(() => {})
ok('is told they are already on the list', /You’re already on the list\./.test(await body(c.p)))
await c.fresh.close()
await b.fresh.close()

console.log('\n8. Ravi S looks like Ravi Shankar')
const f = await signup('Ravi S', null)
await f.fresh.close()
await page.goto(REG)
await settle()
t = await body()
ok('6 in, with a flag', /6 in/.test(t) && /Same as Ravi Shankar\?/.test(t), t.slice(0, 500))
ok('a flagged row reads "via link" only', /Ravi Svia link/.test(t))
ok('Same person / Different on the row', /Same person/.test(t) && /Different/.test(t))
await shot('organiser-duplicate')
await page.goto(`${BASE}/admin/t/${slug}`)
await settle()
t = await body()
ok('the hub says "1 possible duplicate"', /6 players in · link is open · 1 possible duplicate/.test(t), t.slice(0, 400))
await shot('hub-duplicate')

await page.goto(REG)
await settle()
await page.click('button:has-text("Same person")')
t = await until(/one person on the list now/)
ok('merged: says so', /Ravi S and Ravi Shankar are one person on the list now\./.test(t), t.slice(0, 400))
ok('5 in, no flag, Ravi Shankar still wants Arun', /5 in/.test(t) && !/Same as/.test(t) && /Ravi Shankarwants Arun Prakash/.test(t), t.slice(0, 900))
await shot('organiser-merged')

console.log('\n9. Karthik S is a different Karthik')
const g = await signup('Karthik S', null)
await g.fresh.close()
await page.goto(REG)
await settle()
t = await body()
ok('flagged against Karthik Subramanian', /Same as Karthik Subramanian\?/.test(t))
await page.click('button:has-text("Different")')
t = await until(/Karthik Sno partner named · via link/)
ok('both stay, flag gone', /6 in/.test(t) && !/Same as/.test(t) && /Karthik Sno partner named · via link/.test(t), t.slice(0, 900))

console.log('\n10. remove somebody')
await page.click('details:has(input[value]) summary:has-text("Remove") >> nth=0')
await page.waitForTimeout(300)
await shot('organiser-remove-confirm')
await page.click('button:has-text("Take Karthik Subramanian off")')
t = await until(/is off the list/)
ok('Karthik Subramanian is off the list', /Karthik Subramanian is off the list[.,]/.test(t) && /5 in/.test(t), t.slice(0, 300))
ok('Sathish still says who he wants', /Sathish Kumarwants Karthik Subramanian · via link/.test(t))

console.log('\n11. close sign-ups')
await page.click('summary:has-text("Close sign-ups")')
await page.waitForTimeout(300)
await page.click('button:has-text("Close sign-ups")')
t = await until(/sign-ups closed/)
ok('sub line says closed', /5 in · sign-ups closed/.test(t), t.slice(0, 300))
ok('the closed card', /Sign-ups closed/.test(t) && /The link no longer accepts anyone/.test(t) && /Reopen sign-ups/.test(t))
ok('no Copy button, no Close button', (await page.$('button:has-text("Copy")')) === null && (await page.$('summary:has-text("Close sign-ups")')) === null)
ok('the add-by-hand box is still there', (await page.getAttribute('[name=text]', 'placeholder'))?.startsWith('Add a player'))
await shot('organiser-closed')
await page.goto(`${BASE}/admin/t/${slug}`)
await settle()
ok('the hub says sign-ups closed', /sign-ups closed/.test(await body()))
{
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 })
  const p = await fresh.newPage()
  await p.goto(LINK)
  await p.waitForLoadState('networkidle')
  const text = await body(p)
  ok('the public link says closed, with no fields', /Sign-ups have closed — ask the organiser\./.test(text) && (await p.$('input[name=name]')) === null)
  await shot('form-closed', p)
  await fresh.close()
}
await page.goto(REG)
await settle()
await page.fill('[name=text]', 'Naveen Krishnan')
await page.click('button:has-text("Add")')
t = await until(/Naveen Krishnanno partner named/)
ok('adding by hand still works while closed', /6 in · sign-ups closed/.test(t) && /Naveen Krishnanno partner named · added by you/.test(t), t.slice(0, 400))

console.log('\n12. reopen')
await page.click('button:has-text("Reopen sign-ups")')
t = await until(/sign-ups open/)
ok('open again with the same link', /6 in · sign-ups open/.test(t) && t.includes(`/r/${m?.[1]}`))
const h2 = await signup('Meera Nair', 'Naveen Krishnan')
await h2.fresh.close()
await page.goto(REG)
await settle()
t = await body()
ok('and the link takes names again', /7 in/.test(t) && /Meera Nairwants Naveen Krishnan · via link/.test(t))
await shot('organiser-reopened')

ok('no 5xx anywhere', bad.length === 0, bad.join(' '))
await browser.close()
console.log(fails.length ? `\n${fails.length} failed:\n  ${fails.join('\n  ')}` : '\nall good')
process.exit(fails.length ? 1 : 0)
