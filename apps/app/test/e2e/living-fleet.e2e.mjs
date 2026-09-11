/**
 * The living fleet, through a real browser (0021, Wave 3).
 *
 * Three seams no unit test reaches:
 *   - the Sehat surface actually renders on the Gear screen from the
 *     seeded numbers (a read that computes but never mounts is invisible);
 *   - the Serviced flow resets the line ON SCREEN, not just in SQLite;
 *   - the awaaz note records THROUGH MediaRecorder (Chromium has it, with
 *     a fake mic), and degrades to NOTHING — no button, no error — when
 *     MediaRecorder is absent, which is the silent-degrade contract.
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

test('the living fleet, end to end', async (t) => {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('No build found. Run `npm run build:app` first.')
  }

  const { server, port } = await serveDist()
  const browser = await chromium.launch({
    args: [
      // A fake mic, auto-granted — the awaaz note records real (silent)
      // audio through the real MediaRecorder.
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
    ],
  })
  const context = await browser.newContext({ permissions: ['microphone'] })
  const page = await context.newPage()
  const base = `http://127.0.0.1:${port}/index.html`

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  try {
    await t.test('the Gear screen surfaces Sehat from the seeded numbers', async () => {
      await page.goto(`${base}#/gear`)
      await page.waitForSelector('.sehat-group', { timeout: 20_000 })

      // The three seeded stories: FX9-01 over its service threshold, and
      // the two dead units with the honestly split value.
      const section = await page.locator('.section:has(.sehat-group)').first().innerText()
      assert.match(section, /Sehat/)
      assert.match(section, /Service due/)
      assert.match(section, /FX9-01/)
      assert.match(section, /120 rental days · due at 100/)
      assert.match(section, /Idle 90\+ days · Rs 4,500,000 \+1 unpriced/)
      assert.match(section, /XEEN-01/)
      assert.match(section, /SDV-03/)
    })

    await t.test('a Sehat row is a door to the asset page', async () => {
      await page.locator('.sehat-group .line-tap', { hasText: 'FX9-01' }).first().click()
      await page.waitForSelector('.asset-head', { timeout: 10_000 })
      const line = await page.locator('.section:has-text("Sehat")').first().innerText()
      assert.match(line, /120 rental days since service · due at 100/)
      assert.match(line, /Needs a look — past its service point/)
      assert.match(line, /24 of 30 cycles/, 'the cycle line rides the same section')
    })

    await t.test('the Serviced flow resets the line on screen', async () => {
      await page.getByRole('button', { name: 'Serviced' }).click()
      await page.waitForSelector('.sheet')
      await page.locator('#serviced-note').fill('Annual service')
      await page.locator('#serviced-cost').fill('12000')
      await page.getByRole('button', { name: 'Confirm — serviced' }).click()

      await page.waitForSelector('.sheet', { state: 'detached' })
      const line = await page.locator('.section:has-text("Sehat")').first().innerText()
      assert.match(line, /0 rental days since service · due at 100/)
      assert.doesNotMatch(line, /Needs a look — past its service point/)
    })

    await t.test('an awaaz note records through the real MediaRecorder', async () => {
      const btn = page.getByRole('button', { name: /Record an awaaz note/ }).first()
      const box = await btn.boundingBox()
      assert.ok(box, 'the recorder renders where MediaRecorder exists')

      // The walkie-talkie hold: down, speak (the fake mic hums), up.
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await page.waitForTimeout(900)
      await page.mouse.up()

      // The row is the assertion: the note plays back inline.
      await page.waitForSelector('.awaaz-list audio', { timeout: 10_000 })
      const meta = await page.locator('.awaaz-meta').first().innerText()
      assert.match(meta, /this phone’s clock/)
    })

    await t.test('where MediaRecorder is absent the recorder is absent — silently', async () => {
      const bare = await context.newPage()
      const bareErrors = []
      bare.on('pageerror', (e) => bareErrors.push(String(e)))
      await bare.addInitScript(() => {
        // Simulate the browser Phase D5 degrades on. Belt and braces: some
        // builds refuse the delete, so the property is also blanked.
        try { delete window.MediaRecorder } catch { /* not configurable */ }
        window.MediaRecorder = undefined
      })
      await bare.goto(`${base}#/asset/asset-fx9-2`)
      await bare.waitForSelector('.asset-head', { timeout: 20_000 })
      assert.equal(
        await bare.getByRole('button', { name: /Record an awaaz note/ }).count(),
        0,
        'no dead button, no mystery — just absence',
      )
      assert.deepEqual(bareErrors, [], 'and no errors from the missing API')
      await bare.close()
    })

    assert.deepEqual(errors, [], 'no uncaught errors on any screen')
  } finally {
    await browser.close()
    server.close()
  }
})
