/**
 * The scan loop, through a real browser, with a real decode.
 *
 * WHY THIS EXISTS: every check below this one stops at the edge of the camera.
 * The engine is tested against SQLite, the row logic is tested as pure
 * functions — but "a label appears in front of the lens and the right thing
 * happens on screen" was verified by reading the code, and that is exactly the
 * seam where the last three UI bugs lived.
 *
 * Chromium is given a Y4M file as its camera, so this runs on a machine with
 * no webcam. It is deliberately NOT part of `npm test`: it needs a browser and
 * a built bundle, and a unit suite that quietly depends on either is one that
 * stops being run.
 *
 *   npm run build:app && npm run test:e2e
 */
import { chromium } from 'playwright'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, extname, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import assert from 'node:assert/strict'

import { writeQrVideo } from './qr-video.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const DIST = resolve(HERE, '../../dist')

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.map': 'application/json', '.svg': 'image/svg+xml',
}

/** A tag the seeded warehouse has never heard of — a sticker off the printer. */
const FRESH_LABEL = 'v1FRESHLABEL2345678901'

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

async function openApp(videoPath) {
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${videoPath}`,
    ],
  })
  const context = await browser.newContext({ permissions: ['camera'] })
  return { browser, context }
}

test('the scan loop, end to end, through the camera', async (t) => {
  if (!existsSync(join(DIST, 'index.html'))) {
    // Explicit rather than a confusing 404 in a browser log.
    throw new Error('No build found. Run `npm run build:app` first.')
  }

  const dir = mkdtempSync(join(tmpdir(), 'papa-e2e-'))
  const videoPath = join(dir, 'label.y4m')
  writeQrVideo(videoPath, FRESH_LABEL)

  const { server, port } = await serveDist()
  const { browser, context } = await openApp(videoPath)
  const page = await context.newPage()
  const base = `http://127.0.0.1:${port}/index.html`

  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  try {
    await t.test('an unbound label is recorded, not swallowed', async () => {
      await page.goto(`${base}#/scan/job-shan?mode=out`)
      // The row is the assertion: a scan that produces nothing on screen is
      // indistinguishable from a camera that saw nothing, and that is how a
      // tech decides the scanner is broken.
      await page.waitForSelector('.scan-row.is-unknown_tag', { timeout: 20_000 })
      const text = await page.locator('.scan-row.is-unknown_tag').first().innerText()
      assert.match(text, /Unknown tag/)
    })

    await t.test('it offers to attach the label, and binding sticks', async () => {
      await page.getByRole('button', { name: 'Attach this label' }).first().click()
      await page.waitForSelector('.sheet-search')

      const heading = await page.locator('.sheet-title').innerText()
      assert.match(heading, /What is this label on\?/)

      await page.locator('.sheet-search').fill('FX9-01')
      await page.locator('.sheet-row').first().click()

      // Bound: the row that follows names the item rather than the tag.
      await page.waitForSelector('.scan-row.is-accepted', { timeout: 10_000 })
      const row = await page.locator('.scan-row.is-accepted').first().innerText()
      assert.match(row, /Sony FX9/)
      assert.match(row, /Label attached/)
    })

    await t.test('moving to another job does not carry the last one\'s rows over', async () => {
      // React reuses the component when only its props change, so the scan
      // list survived a job change and the previous job's work appeared under
      // the new job's name. Asserting the list is EMPTY on arrival is the only
      // way the next test below can mean anything.
      await page.goto(`${base}#/scan/lookup?mode=in`)
      await page.waitForSelector('.scan-screen')
      assert.equal(await page.locator('.scan-list li').count(), 0, 'a fresh session starts empty')
    })

    await t.test('the same label now resolves to that item on sight', async () => {
      // The point of writing the mapping locally at bind time. A tech who
      // rescans what they just tagged and gets "unknown" does it again.
      await page.waitForSelector('.scan-row.is-accepted, .scan-row.is-unexpected', {
        timeout: 20_000,
      })
      const row = await page.locator('.scan-list li').first().innerText()
      assert.match(row, /Sony FX9/, 'the fresh label now reads as the camera it is on')
      assert.doesNotMatch(row, /Unknown/)
    })

    assert.deepEqual(errors, [], 'no uncaught errors on any screen')
  } finally {
    await browser.close()
    server.close()
  }
})
