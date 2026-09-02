/**
 * UI logic that is pure enough to test without a browser.
 *
 * Routing and status collapse are both places where a quiet mistake shows up
 * as "the app took me somewhere odd" or "that camera looked available" rather
 * than as a crash — so they are worth pinning down.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { parseHash, viewToHash } from '../src/nav.ts'
import { toBucket, statusSentence } from '../src/status.ts'
import { HOLD_MS } from '../src/hold.ts'

describe('routing', () => {
  test('an empty hash is the job list', () => {
    for (const h of ['', '#', '#/']) {
      assert.deepEqual(parseHash(h), { name: 'jobs' })
    }
  })

  test('a scan route carries the job and the mode', () => {
    assert.deepEqual(parseHash('#/scan/job-42?mode=in'), {
      name: 'scan', jobId: 'job-42', mode: 'in',
    })
  })

  test('lookup is a scan mode of its own', () => {
    // The asking mode. Routing "Just scan" as a check-in was the defect where
    // scanning an item to SEE where it was quietly marked it returned — so
    // the mode must survive the round trip, not collapse into in/out.
    assert.deepEqual(parseHash('#/scan/lookup?mode=lookup'), {
      name: 'scan', jobId: 'lookup', mode: 'lookup',
    })
  })

  test('mode defaults to going out', () => {
    // The overwhelmingly common case at 6am, and the one a mistyped link
    // should land on rather than silently recording returns.
    assert.equal(parseHash('#/scan/job-42').mode, 'out')
    assert.equal(parseHash('#/scan/job-42?mode=nonsense').mode, 'out')
  })

  test('round-trips every view', () => {
    const views = [
      { name: 'jobs' },
      { name: 'scan', jobId: 'j1', mode: 'out' },
      { name: 'scan', jobId: 'j1', mode: 'in' },
      { name: 'scan', jobId: 'lookup', mode: 'lookup' },
      { name: 'session', sessionId: 's1' },
      { name: 'asset', assetId: 'a1' },
      { name: 'gear' },
      { name: 'gear', query: 'attention' },
      // A code with a space and a slash in it. The gear query goes into the
      // hash, so anything that does not survive encoding lands the person on
      // a different screen than the one they linked to.
      { name: 'gear', query: 'FX9 / 01' },
      { name: 'enquiry' },
      { name: 'import' },
      { name: 'settings' },
    ]
    for (const v of views) {
      assert.deepEqual(parseHash(viewToHash(v)), v, `round-trip failed for ${v.name}`)
    }
  })

  test('every view name has a hash, and every hash has a view', () => {
    // viewToHash returning undefined for a view it forgot is how the last
    // rename broke routing: the switch simply fell through and the caller
    // navigated to "undefined". Any new route added to the View union without
    // a case here fails this rather than at runtime in a warehouse.
    const names = ['jobs', 'scan', 'session', 'asset', 'gear', 'enquiry', 'import', 'settings']
    const sample = {
      jobs: { name: 'jobs' },
      scan: { name: 'scan', jobId: 'j', mode: 'out' },
      session: { name: 'session', sessionId: 's' },
      asset: { name: 'asset', assetId: 'a' },
      gear: { name: 'gear' },
      enquiry: { name: 'enquiry' },
      import: { name: 'import' },
      settings: { name: 'settings' },
    }
    for (const n of names) {
      const hash = viewToHash(sample[n])
      assert.equal(typeof hash, 'string', `${n} has no hash`)
      assert.equal(parseHash(hash).name, n, `${n} does not parse back`)
    }
  })

  test('a malformed route falls back rather than crashing', () => {
    // A stale deep link from an old build must not white-screen a phone in a
    // warehouse, where the fix is "reinstall the app" and the cost is a
    // morning.
    for (const h of ['#/scan', '#/session', '#/asset', '#/nonsense', '#/scan//?mode=in']) {
      assert.equal(parseHash(h).name, 'jobs', `${h} should fall back`)
    }
  })
})

describe('status collapses three axes to four buckets', () => {
  const here = { presence: 'here', health: 'ok' }

  test('the ordinary cases', () => {
    assert.equal(toBucket(here), 'here')
    assert.equal(toBucket({ presence: 'out', health: 'ok' }), 'out')
    assert.equal(toBucket({ presence: 'in_transit', health: 'ok' }), 'out')
    assert.equal(toBucket({ presence: 'gone', health: 'ok' }), 'gone')
  })

  test('HEALTH WINS over presence', () => {
    // A camera physically on the shelf but quarantined is NOT available.
    // Showing it as HERE is the specific lie that gets broken gear re-rented,
    // which the research names as the most damaging class of double-booking.
    assert.equal(toBucket({ presence: 'here', health: 'quarantined' }), 'attention')
    assert.equal(toBucket({ presence: 'here', health: 'servicing' }), 'attention')
  })

  test('but GONE wins over everything', () => {
    // A retired asset is not "needs a look" — there is nothing to look at.
    assert.equal(toBucket({ presence: 'gone', health: 'quarantined' }), 'gone')
  })

  test('a sub-rented lens that is out on a job is representable', () => {
    // The case that broke the original single-column design: `sub_rented_in`
    // and `out` were mutually exclusive values and both were true.
    const s = { presence: 'out', health: 'ok', ownership: 'sub_rented_in' }
    assert.equal(toBucket(s), 'out')
    assert.match(statusSentence(s), /sub-rented in/)
  })
})

describe('the asset page says it in a sentence, not a badge', () => {
  test('names the job and when it left', () => {
    const s = statusSentence(
      { presence: 'out', health: 'ok' },
      { jobLabel: 'Zindagi Films', since: '3 Apr' },
    )
    assert.match(s, /Zindagi Films/)
    assert.match(s, /since 3 Apr/)
  })

  test('names the vehicle when in transit', () => {
    const s = statusSentence({ presence: 'in_transit', health: 'ok' }, { locationName: 'Van 1' })
    assert.match(s, /Van 1/)
  })

  test('spells out that quarantined gear is not bookable', () => {
    // "quarantined" alone is jargon; the consequence is the point.
    assert.match(statusSentence({ presence: 'here', health: 'quarantined' }), /not bookable/)
  })

  test('degrades gracefully with no context at all', () => {
    assert.equal(statusSentence({ presence: 'here', health: 'ok' }), 'Here')
  })
})

describe('hold to finish', () => {
  test('is a hold, not a tap', () => {
    // A tap at the bottom of the screen is what a knuckle does while carrying
    // a case, and an accidental finish closes a half-done pull.
    assert.ok(HOLD_MS >= 400, 'must be long enough to be deliberate')
    assert.ok(HOLD_MS <= 800, 'but not so long it feels broken')
  })
})
