/**
 * Quoting, through a real browser (0024 on the phone, Wave 6b).
 *
 * The one path no unit test reaches whole: a pasted kit list → dates →
 * Price it → the challan with its UNPRICED stamp → the rate typed inline
 * → Book it → the booking sheet prefilled with the same lines AND dates
 * → the booking page's Quote section carrying the same total. Then the
 * owner's override on a booking, behind the hold, with the card rate
 * struck through.
 *
 * Not part of `npm test` (needs a browser and a built bundle):
 *
 *   npm run build:app && npm run test:e2e
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '../../dist')

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.map': 'application/json', '.svg': 'image/svg+xml',
}

async function serveDist() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost')
    const file = join(DIST, url.pathname === '/' ? 'index.html' : url.pathname)
    try {
      const body = await readFile(file)
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' })
      res.end(body)
    } catch {
      res.writeHead(404).end('not found')
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: server.address().port }
}

/** Local 'YYYY-MM-DDTHH:MM' for a datetime-local field. */
function localInput(d) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

test('the kit list becomes a priced quote, then a booking', async (t) => {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('No build found. Run `npm run build:app` first.')
  }

  const { server, port } = await serveDist()
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 375, height: 812 } })
  const page = await context.newPage()
  const base = `http://127.0.0.1:${port}/index.html`

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  // Ten days, next month, 10:00 → 10:00: the golden 10-day window
  // (1 week (3) + 3 = 6 billable days), well clear of the seeded bookings.
  const start = new Date(); start.setMonth(start.getMonth() + 2); start.setDate(1); start.setHours(10, 0, 0, 0)
  const end = new Date(start); end.setDate(end.getDate() + 10)

  try {
    await t.test('the reply card takes the dates and prices the list', async () => {
      await page.goto(`${base}#/desk`)
      await page.waitForSelector('.paste-box', { timeout: 20_000 })
      await page.fill('.paste-box', '2x Sony FX9\n4x XLR cable 5m\n1x Sachdeva tripod')
      await page.getByRole('button', { name: 'Check availability' }).click()
      await page.waitForSelector('#enquiry-start')
      await page.fill('#enquiry-start', localInput(start))
      await page.fill('#enquiry-end', localInput(end))
      await page.getByRole('button', { name: 'Price it' }).click()
      const sheet = page.locator('.quote-sheet')
      await sheet.waitFor()
      const text = await sheet.innerText()
      // FX9 ×2 × 6 days × Rs 25,000 = Rs 300,000; XLR ×4 × 6 × Rs 300 = Rs 7,200.
      assert.match(text, /Rs 300,000/)
      assert.match(text, /Rs 7,200/)
      assert.match(text, /UNPRICED — TELL ME THE RATE/i, 'the tripod wears the stamp')
      assert.match(text, /Rs 307,200/)
      assert.match(text, /\+1 unpriced/)
      assert.match(text, /INDICATIVE/i)
    })

    await t.test('the rate typed inline prices the line, and the trace explains the days', async () => {
      await page.fill('input[aria-label="Day rate for Sachdeva Tripod, rupees"]', '1500')
      await page.getByRole('button', { name: 'Set the rate' }).click()
      const sheet = page.locator('.quote-sheet')
      await page.waitForFunction(() => !document.querySelector('.quote-line.is-unpriced'))
      const text = await sheet.innerText()
      assert.match(text, /Rs 9,000/, '1 × 6 × Rs 1,500')
      assert.match(text, /Rs 316,200/)
      assert.doesNotMatch(text, /unpriced/)
      await page.locator('.quote-trace summary').click()
      assert.match(await page.locator('.quote-steps').innerText(), /6 billable days: 10 days = 1 week \(3\) \+ 3/)
    })

    await t.test('Book it carries the lines and the dates; the booking page carries the total', async () => {
      await page.getByRole('button', { name: 'Book it' }).click()
      await page.waitForSelector('#new-booking-start')
      assert.equal(await page.inputValue('#new-booking-start'), localInput(start))
      assert.equal(await page.inputValue('#new-booking-end'), localInput(end))
      assert.match(await page.locator('[role="dialog"]').innerText(), /3 lines from the kit list/)
      await page.getByRole('button', { name: 'Hamza Saeed', exact: true }).click()
      await page.getByRole('button', { name: 'Pencil it in' }).click()
      await page.waitForSelector('.quote-section')
      const section = await page.locator('.quote-section').innerText()
      assert.match(section, /6 billable days/)
      assert.match(section, /Rs 316,200/)
      assert.match(section, /INDICATIVE/i, 'a pencil is not a bill')
      assert.match(section, /VERIFIED — LIGHTER DEPOSIT/i, 'Hamza is the fast lane')
    })

    await t.test('the override is behind a hold, needs a reason, and strikes the card rate through', async () => {
      await page.getByRole('button', { name: 'Price it' }).click()
      const sheet = page.locator('.quote-sheet')
      await sheet.waitFor()
      assert.equal(await sheet.getByRole('button', { name: 'Override a rate', exact: true }).count(), 0,
        'no per-line override door before the hold — only the hold itself')
      const hold = sheet.getByRole('button', { name: /Override a rate — press and hold/ })
      await hold.scrollIntoViewIfNeeded()
      const box = await hold.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(900)
      await page.mouse.up()
      await page.locator('.quote-line').first().getByRole('button', { name: 'Override a rate', exact: true }).click()
      await page.fill('input[id^="ov-rate-"]', '20000')
      await page.getByRole('button', { name: 'Use this rate' }).click()
      assert.match(await sheet.innerText(), /An override needs a reason\./)
      await page.fill('input[id^="ov-reason-"]', 'Long-standing client, agreed on the phone')
      await page.getByRole('button', { name: 'Use this rate' }).click()
      await page.waitForSelector('.quote-strike')
      const line = await page.locator('.quote-line').first().innerText()
      assert.match(line, /Rs 25,000/, 'the card rate, struck through')
      assert.match(line, /Rs 20,000/, 'the owner\'s number')
      assert.match(line, /Rs 240,000/, '2 × 6 × Rs 20,000')
      assert.match(line, /Override: Long-standing client/)
      assert.match(await sheet.innerText(), /Rs 256,200/)
    })

    assert.deepEqual(errors, [], 'no page errors')
  } finally {
    await browser.close()
    server.close()
  }
})
