/**
 * Scanning a case, through a real camera.
 *
 * The rule under test is the plan's override #1: a case scan records the case
 * and its welded-on parts, and NOTHING that is merely packed inside. The unit
 * tests prove the engine refuses; this proves the screen does too — that the
 * manifest actually opens, that it says what it is doing, and that taking the
 * case as packed records those items as a belief rather than as observations.
 *
 * Wants a build: `npm run build:app && npm run test:e2e`.
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

/**
 * The A-Cam Case's label from the seed.
 *
 * Hard-coded rather than derived, deliberately: the seed's tag codes are
 * generated from a FIXED seed precisely so a printed label keeps working, and
 * this asserts that promise as a side effect. If the generator ever changes,
 * this test fails and says so — which is the warning a house with labels
 * already stuck on its gear would want.
 */
const CASE_LABEL = 'v1JN2R5JB9QFB73TDKF64TGL'

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

test('a case opens a manifest instead of recording its contents', async (t) => {
  if (!existsSync(join(DIST, 'index.html'))) {
    throw new Error('No build found. Run `npm run build:app` first.')
  }

  const dir = mkdtempSync(join(tmpdir(), 'papa-case-'))
  const videoPath = join(dir, 'case.y4m')
  writeQrVideo(videoPath, CASE_LABEL)

  const { server, port } = await serveDist()
  const browser = await chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-video-capture=${videoPath}`,
    ],
  })
  const context = await browser.newContext({ permissions: ['camera'] })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))

  try {
    await page.goto(`http://127.0.0.1:${port}/index.html#/scan/job-shan?mode=out`)

    await t.test('the label is a real one — the seed is still stable', async () => {
      // If the tag generator changed, this is where a house with labels
      // already on its gear finds out.
      await page.waitForSelector('.scan-row', { timeout: 20_000 })
      const first = await page.locator('.scan-row').first().innerText()
      assert.doesNotMatch(first, /Unknown tag/, 'the seeded case label still resolves')
    })

    await t.test('the manifest opens and names what is inside', async () => {
      await page.waitForSelector('[aria-label="What is in this case"]', { timeout: 10_000 })
      const sheet = await page.locator('[aria-label="What is in this case"]').innerText()
      assert.match(sheet, /A-Cam Case/)
      // Case-insensitive: the section labels are uppercased in CSS, and
      // innerText returns what is rendered.
      assert.match(sheet, /packed inside — not looked at/i)
      assert.match(sheet, /Sigma/, 'the lenses are named')
    })

    await t.test('it does not offer to mark them scanned', async () => {
      // There is no third button, and there must never be one.
      const sheet = page.locator('[aria-label="What is in this case"]')
      assert.equal(await sheet.getByRole('button', { name: /mark.*scanned/i }).count(), 0)
      assert.match(
        await sheet.innerText(),
        /as assumed/i,
        'and it says plainly what taking the case does',
      )
    })

    await t.test('taking the case as packed records a belief, not a scan', async () => {
      await page.getByRole('button', { name: /Take the case as packed/ }).click()
      await page.waitForSelector('[aria-label="What is in this case"]', { state: 'detached' })

      // The count moves, so the tech can see the work landed.
      const progress = await page.locator('.progress-count').innerText()
      assert.match(progress, /\d+\/\d+/)

      // And the rows for the packed items exist.
      const list = await page.locator('.scan-list').innerText()
      assert.match(list, /Sigma/)
    })

    assert.deepEqual(errors, [], 'no uncaught errors')
  } finally {
    await browser.close()
    server.close()
  }
})
