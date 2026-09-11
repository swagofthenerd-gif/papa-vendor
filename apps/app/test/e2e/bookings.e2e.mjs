/**
 * The promise calendar, through a real browser (0022, Wave 5).
 *
 * Three seams no unit test reaches:
 *   - the calendar actually draws the seeded month with its two marks;
 *   - a day's tap lists the booking and the row opens its page;
 *   - the Confirm sheet's preview names the unit, the confirm binds it ON
 *     SCREEN, and the collision preview on Extend names who is waiting.
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

test('the promise calendar, end to end', async (t) => {
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

  try {
    await t.test('the calendar draws the seeded month with both marks', async () => {
      await page.goto(`${base}#/calendar`)
      await page.waitForSelector('.cal-grid', { timeout: 20_000 })
      assert.ok(await page.locator('.cal-day .cal-mark-confirmed').count() > 0, 'confirmed marks')
      assert.ok(await page.locator('.cal-day .cal-mark-pencil').count() > 0, 'the live pencil marks')
      // The Desk tab is the one lit — the calendar is a client-facing page.
      assert.equal(await page.locator('.nav-tab.is-active').innerText(), 'Desk')
    })

    await t.test('tapping the pencil\'s day lists it, and the row opens the booking', async () => {
      // B#3 starts in 3 days — its day cell wears a pencil mark.
      const cell = page.locator('.cal-day:has(.cal-mark-pencil)').first()
      await cell.click()
      const row = page.locator('.booking-line').first()
      assert.match(await row.innerText(), /#3/)
      assert.match(await row.innerText(), /PENCIL/i)
      await row.click()
      await page.waitForSelector('.booking-head')
      assert.match(await page.locator('.topbar-title').innerText(), /Booking #3/)
      assert.match(await page.locator('.booking-head').innerText(), /left/i, 'the countdown is live')
    })

    await t.test('the Confirm sheet previews the units, then binds them on screen', async () => {
      await page.getByRole('button', { name: 'Confirm' }).click()
      const sheet = page.locator('[role="dialog"]')
      await sheet.waitFor()
      assert.match(await sheet.innerText(), /here now/, 'the three-layer answer per line')
      assert.match(await sheet.innerText(), /Will take C300-01/, 'the allocation preview names the unit')
      await page.getByRole('button', { name: /Confirm — bind the units/ }).click()
      await sheet.waitFor({ state: 'detached' })
      const head = await page.locator('.booking-head').innerText()
      assert.match(head, /CONFIRMED/i)
      assert.match(await page.locator('.line-list').first().innerText(), /C300-01/, 'the bound unit is on the line')
    })

    await t.test('Extend previews who is waiting, and refuses until settled', async () => {
      await page.goto(`${base}#/booking/bk-1`)
      await page.waitForSelector('.booking-head')
      await page.getByRole('button', { name: 'Extend' }).click()
      await page.waitForSelector('#extend-end')
      // The default (+1 day) is clean.
      assert.match(await page.locator('[role="dialog"]').innerText(), /No one is waiting/)
      // Past B#5 (today + 30d): the card names it.
      const past = new Date(); past.setDate(past.getDate() + 31); past.setHours(18, 0, 0, 0)
      await page.fill('#extend-end', localInput(past))
      await page.waitForSelector('.collision-card')
      const card = await page.locator('.collision-card').innerText()
      assert.match(card, /FX9-02/)
      assert.match(card, /#5 · Bilal Hussain/)
      assert.ok(await page.getByRole('button', { name: /settle each card first/ }).isDisabled())
      // Substitute: the picker offers the free body; tapping it clears the card.
      await page.getByRole('button', { name: 'Substitute' }).click()
      await page.getByRole('button', { name: /FX9-01/ }).click()
      await page.waitForSelector('.collision-card', { state: 'detached' })
      await page.locator('[role="dialog"]').getByRole('button', { name: 'Extend', exact: true }).click()
      await page.waitForSelector('[role="dialog"]', { state: 'detached' })
      assert.match(await page.locator('.fact-grid').innerText(), /Oct|Nov|Dec|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep/)
    })

    assert.deepEqual(errors, [], 'no page errors')
  } finally {
    await browser.close()
    server.close()
  }
})
