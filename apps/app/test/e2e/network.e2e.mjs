/**
 * The network, through a real browser (0025, W7b).
 *
 * The seams no unit test reaches:
 *   - the Settings list actually renders the partner houses and opens one;
 *   - the sub-hire-in sheet writes a BORROWED unit that the partner page
 *     and the unit's own page both name ON SCREEN;
 *   - the lend-out sheet lands a 'Sub-hire → X' job on the Today board
 *     wearing the SUB-HIRE stamp, and the crew picker puts a chip on it;
 *   - the thermal door in the BUILT bundle (no dev download, no transport)
 *     says 'No printer connected' instead of pretending.
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

test('the partner network, end to end', async (t) => {
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
  // Hash navigation keeps the in-memory store, so the writes below carry
  // from screen to screen the way they do on a phone.
  const nav = async (hash, sel) => {
    await page.evaluate((h) => { window.location.hash = h }, `#/${hash}`)
    await page.waitForSelector(sel, { timeout: 20_000 })
  }

  try {
    await t.test('Settings lists the seeded partner houses and a row opens the page', async () => {
      await page.goto(`${base}#/settings`)
      await page.waitForSelector('.partner-list', { timeout: 20_000 })
      const list = await page.locator('.partner-list').innerText()
      assert.match(list, /Kamran Rentals/)
      assert.match(list, /Zeeshan Cine Hire/)
      await page.locator('.partner-list .line-tap', { hasText: 'Kamran Rentals' }).click()
      await page.waitForSelector('.partner-head')
      assert.match(await page.locator('.topbar-title').innerText(), /Kamran Rentals/)
      // A partner house is a counterparty on both books: the Khata tab lights.
      assert.equal(await page.locator('.nav-tab.is-active').innerText(), 'Khata')
    })

    await t.test('a sub-hire in with a serial makes a BORROWED unit the pages name', async () => {
      await page.getByRole('button', { name: 'Record a sub-hire in' }).click()
      await page.waitForSelector('#sub-hire-product')
      await page.fill('#sub-hire-product', 'fx9')
      await page.getByRole('button', { name: /Sony FX9/ }).click()
      await page.fill('#sub-hire-serial', 'FX9-SN-7781')
      await page.fill('#sub-hire-cost', '30000')
      await page.getByRole('button', { name: 'Record the sub-hire' }).click()
      await page.waitForSelector('.sub-hire-code')
      assert.equal(await page.locator('.sub-hire-code').innerText(), 'FX9-03')
      await page.locator('[role="dialog"] .btn-primary', { hasText: 'Close' }).click()
      await page.waitForSelector('.sub-hire-line')
      const open = await page.locator('.sub-hire-line').first().innerText()
      assert.match(open, /BORROWED/i)
      assert.match(open, /Sony FX9/)
      assert.match(open, /Rs 30,000/)
      assert.match(await page.locator('.section', { hasText: 'Money' }).innerText(), /We owe Rs 30,000 across 1 sub-hire/)
      // The unit's own page says whose it is.
      await page.getByRole('button', { name: /Unit FX9-03/ }).click()
      // The partner page wears .asset-head too; the fact grid is the unit's.
      await page.waitForSelector('.fact-grid')
      assert.match(await page.locator('.asset-head').innerText(), /Borrowed from Kamran Rentals/)
      assert.match(await page.locator('.fact-grid').innerText(), /FX9-SN-7781/)
    })

    await t.test('a lend-out lands a SUB-HIRE job on Today, and the crew picker puts a chip on it', async () => {
      await nav('partner/partner-kamran', '.partner-head')
      await page.getByRole('button', { name: 'Lend to a partner' }).click()
      await page.waitForSelector('#lend-product')
      await page.fill('#lend-product', 'komodo')
      await page.getByRole('button', { name: /RED Komodo/ }).click()
      await page.getByRole('button', { name: 'KMD-01' }).click()
      await page.fill('#lend-charge', '18000')
      await page.getByRole('button', { name: 'Lend it' }).click()
      await page.waitForSelector('.stat-strip')
      const card = page.locator('.job-block', { hasText: 'Sub-hire' })
      assert.match(await card.innerText(), /Sub-hire → Kamran Rent/)
      assert.match(await card.innerText(), /SUB-HIRE/i)
      // The wedding truck's seeded crew is on its card already.
      const wedding = page.locator('.job-block', { hasText: 'Wedding' })
      assert.match(await wedding.locator('.crew-row').innerText(), /Usman/)
      assert.match(await wedding.locator('.crew-row').innerText(), /Saqib/)
      // Add Danish to the sub-hire truck.
      await card.getByRole('button', { name: 'Add crew' }).click()
      await page.waitForSelector('[role="dialog"]')
      await page.getByRole('button', { name: /Danish/ }).click()
      await page.waitForSelector('[role="dialog"]', { state: 'detached' })
      assert.match(await card.locator('.crew-row').innerText(), /Danish/)
    })

    await t.test('the built bundle has no printer: the thermal door says so', async () => {
      await nav('scan/job-wedding?mode=out', '.scan-screen')
      await page.waitForTimeout(500)
      await nav('session/job-wedding', '.session-actions')
      await page.getByRole('button', { name: 'Thermal print' }).click()
      await page.waitForSelector('.notice')
      assert.match(await page.locator('.notice').first().innerText(), /No printer connected/)
    })

    assert.deepEqual(errors, [], 'no uncaught errors on any screen')
  } finally {
    await browser.close()
    server.close()
  }
})
