import { chromium } from 'playwright-core'
const BASE='http://localhost:3200'
const b = await chromium.launch({ executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args:['--no-sandbox']})
const p = await (await b.newContext()).newPage()
p.on('pageerror', e=>console.log('pageerror:', e.message.slice(0,200)))
// sign in and get codes
await p.goto(`${BASE}/login`); await p.fill('#username','saurabh'); await p.fill('#password','change-me-now')
await p.click('button[type=submit]'); await p.waitForURL('**/admin**')
await p.goto(`${BASE}/admin`)
const href = await p.$eval('a[href^="/admin/t/"]', a=>a.getAttribute('href'))
const slug = href.split('/admin/t/')[1]
await p.goto(`${BASE}/admin/t/${slug}/cards`)
await p.click('button:has-text("Make the cards")')
await p.waitForFunction(()=>document.body.innerText.includes('shown once'),null,{timeout:20000})
const codes = (await p.innerText('body')).match(/\b[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}\b/g) ?? []
console.log('codes', codes)
const anon = await (await b.newContext()).newPage()
for (const c of codes.slice(0,2)) {
  await anon.goto(`${BASE}/c/${c}`)
  console.log('---', c, '->', anon.url())
  console.log((await anon.innerText('body')).slice(0,220).replace(/\n+/g,' | '))
}
await b.close()
