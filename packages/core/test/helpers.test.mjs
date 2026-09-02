/**
 * The two pure behaviours the demo UI grew and the real client needs too:
 * the decode-side same-tag debounce, and the WhatsApp share url.
 *
 * Both lived in apps/app/src/demo and would have been rewritten — slightly
 * differently — by the first real screen that needed them.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { SameTagDebounce, SAME_TAG_QUIET_MS } from '../src/scan.ts'
import { whatsAppShareUrl } from '../src/share.ts'

describe('the same-tag decode debounce', () => {
  test('the first sighting of a tag is always handled', () => {
    const d = new SameTagDebounce()
    assert.equal(d.accept('T1', 0), true)
  })

  test('the camera staring at one label does not become sixty rows', () => {
    const d = new SameTagDebounce()
    d.accept('T1', 0)
    assert.equal(d.accept('T1', 16), false, 'the very next frame is ignored')
    assert.equal(d.accept('T1', SAME_TAG_QUIET_MS - 1), false)
  })

  test('a deliberate rescan after the quiet window still gets its double-tick', () => {
    const d = new SameTagDebounce()
    d.accept('T1', 0)
    assert.equal(d.accept('T1', SAME_TAG_QUIET_MS), true)
  })

  test('a suppressed frame does not extend the window', () => {
    // The window runs from the last ACCEPTED decode. If suppression refreshed
    // it, a label held up to the camera would renew its own quiet window
    // sixty times a second and never re-fire — and the rescan double-tick is
    // the feedback that tells the tech the scanner is alive.
    const d = new SameTagDebounce()
    d.accept('T1', 0)
    d.accept('T1', 1_000)                                   // suppressed
    assert.equal(d.accept('T1', 1_600), true, 'measured from t=0, not t=1000')
  })

  test('different tags never debounce each other', () => {
    const d = new SameTagDebounce()
    d.accept('T1', 0)
    assert.equal(d.accept('T2', 1), true)
  })

  test('the window is tunable but defaults to the product value', () => {
    const d = new SameTagDebounce(100)
    d.accept('T1', 0)
    assert.equal(d.accept('T1', 100), true)
    assert.equal(SAME_TAG_QUIET_MS, 1_500)
  })
})

describe('the WhatsApp share url', () => {
  test('builds the wa.me scheme the demo already ships', () => {
    assert.equal(whatsAppShareUrl('hello'), 'https://wa.me/?text=hello')
  })

  test('encodes the manifest text, newlines and Urdu included', () => {
    const url = whatsAppShareUrl('FX9 x1\n18-35mm — ٹھیک ہے & sound')
    assert.ok(url.startsWith('https://wa.me/?text='))
    assert.ok(!url.includes('\n'), 'no raw newlines in a url')
    assert.ok(!url.includes(' & '), 'ampersands cannot survive unencoded')
    const back = decodeURIComponent(url.slice('https://wa.me/?text='.length))
    assert.equal(back, 'FX9 x1\n18-35mm — ٹھیک ہے & sound')
  })
})
