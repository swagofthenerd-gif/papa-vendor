/**
 * The bottom sheet's three ways out, through a real browser (W10).
 *
 *   - a pull on the grip past a third of the sheet dismisses it;
 *   - a short pull springs back and the sheet stays;
 *   - the X and Escape play the exit and then the sheet is gone.
 *
 * The unit tests cannot reach this: the drag is pointer events against
 * a measured height, and the exit is an animationend the owner waits for.
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

/** A pull on the grip: down, a few moves, up — the way a thumb does it. */
async function pull(page, dy) {
  const grip = page.locator('.sheet-grip')
  const box = await grip.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 6; i++) await page.mouse.move(x, y + (dy * i) / 6)
  await page.mouse.up()
}

test('the sheet: pull to dismiss, short pull springs back, X and Escape', async (t) => {
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

  const open = async () => {
    await page.getByRole('button', { name: 'New job' }).click()
    const sheet = page.locator('[role="dialog"]')
    await sheet.waitFor()
    await page.waitForTimeout(250) // the arrival, over
    return sheet
  }

  try {
    await page.goto(`${base}#/`)
    await page.waitForSelector('.app-main', { timeout: 20_000 })

    await t.test('a long pull on the grip closes the sheet', async () => {
      const sheet = await open()
      const h = (await page.locator('.sheet').boundingBox()).height
      await pull(page, h * 0.6)
      await sheet.waitFor({ state: 'detached', timeout: 2000 })
    })

    await t.test('a short pull springs back and the sheet stays', async () => {
      const sheet = await open()
      await pull(page, 30)
      await page.waitForTimeout(400)
      assert.equal(await sheet.count(), 1, 'still open')
      assert.equal(
        await page.locator('.sheet').evaluate((el) => el.style.transform),
        '', 'back at rest',
      )
    })

    await t.test('the X plays the exit, then the sheet is gone', async () => {
      const sheet = page.locator('[role="dialog"]')
      await sheet.getByRole('button', { name: 'Close', exact: true }).click()
      assert.ok(await sheet.evaluate((el) => el.classList.contains('is-closing')), 'the exit is playing')
      await sheet.waitFor({ state: 'detached', timeout: 2000 })
    })

    await t.test('Escape closes it too', async () => {
      const sheet = await open()
      await page.keyboard.press('Escape')
      await sheet.waitFor({ state: 'detached', timeout: 2000 })
    })

    assert.deepEqual(errors, [], 'no page errors')
  } finally {
    await browser.close()
    server.close()
  }
})
