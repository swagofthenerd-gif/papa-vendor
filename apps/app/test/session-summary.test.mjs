/**
 * The handover summary's numbers.
 *
 * The screen shows a tally and, underneath it, the list that tally describes.
 * If those two ever disagree the tech stops believing the screen — and they
 * DID disagree: the shortfall was computed as expected-minus-scanned, so
 * scanning one item that was not on the job silently knocked one off the
 * count while the list below still named it. "3 not accounted for" above a
 * list of 4.
 *
 * These assert the numbers against the lists, which is the only relationship
 * that has to hold.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, ScanSession, moneyLabel } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { assetFacts } from '../src/demo/read-model.ts'
import { buildSummary, manifestText, shortfall } from '../src/session-summary.ts'

function build() {
  const db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  const seed = seedDemo(db)
  return { db, seed }
}

/** The real rule, fed from a real ScanSession. */
function summarise(db, seed, job, session) {
  return buildSummary({
    jobLabel: job.label,
    mode: 'out',
    expected: job.expected,
    recorded: session.scannedIds,
    assumed: [],
    unknownTags: [],
    facts: (id) => {
      const r = db.get(
        `select a.asset_code, coalesce(p.display_name, a.display_name) as display_name
           from assets a left join products p on p.id = a.product_id where a.id = ?`,
        [id],
      )
      return r ? { id, code: r.asset_code, name: r.display_name } : undefined
    },
  })
}

describe('the handover tally agrees with the lists under it', () => {
  test('a plain partial pull', () => {
    const { db, seed } = build()
    const job = seed.jobs[0]
    const session = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    for (const id of job.expected.slice(0, 4)) session.addManually(id)

    const s = summarise(db, seed, job, session)
    assert.equal(s.scanned, 4)
    assert.equal(shortfall(s), job.expected.length - 4)
    assert.equal(s.missing.length, shortfall(s))
  })

  test('an off-list item does not shrink the shortfall', () => {
    // THE REGRESSION. Scanning something the job never asked for must not make
    // the count of what is still on the shelf go down — nothing came off the
    // shelf. Under the old arithmetic this reported one fewer than the list.
    const { db, seed } = build()
    const job = seed.jobs[0]
    const session = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    for (const id of job.expected.slice(0, 4)) session.addManually(id)

    const before = shortfall(summarise(db, seed, job, session))
    session.addManually('asset-komodo-1')      // a camera on no job at all
    const after = summarise(db, seed, job, session)

    assert.equal(shortfall(after), before, 'the shortfall must not move')
    assert.equal(after.exceptions.length, 1, 'it shows up as an exception instead')
    assert.equal(after.missing.length, shortfall(after))
  })

  test('a full pull reports nothing outstanding', () => {
    const { db, seed } = build()
    const job = seed.jobs[0]
    const session = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    for (const id of job.expected) session.addManually(id)

    const s = summarise(db, seed, job, session)
    assert.equal(shortfall(s), 0)
    assert.equal(s.missing.length, 0)
    assert.equal(s.scanned, job.expected.length)
  })
})

describe('the WhatsApp message', () => {
  test('names every outstanding item, so the client can chase one', () => {
    const { db, seed } = build()
    const job = seed.jobs[0]
    const session = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    session.addManually(job.expected[0])

    const s = summarise(db, seed, job, session)
    const text = manifestText(s)

    assert.ok(text.includes(job.label), 'the job is named')
    assert.ok(text.includes('Still to come:'), 'the shortfall is stated, not hidden')
    for (const m of s.missing) {
      assert.ok(text.includes(m.name), `${m.name} is missing from the message`)
    }
  })

  test('says nothing about a shortfall when there is none', () => {
    const { db, seed } = build()
    const job = seed.jobs[1]
    const session = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    for (const id of job.expected) session.addManually(id)

    const text = manifestText(summarise(db, seed, job, session))
    assert.ok(!text.includes('Still to come'), 'no empty section')
  })
})

describe('money on the missing lines', () => {
  // The real facts source, rates included — what the store actually wires.
  const factsOf = (db) => (id) => assetFacts(db, id)

  test('coming back, a missing line is priced at replacement value', () => {
    const { db, seed } = build()
    const job = seed.jobs[0]
    // Expect the FX9 (asset-fx9-1) back and record nothing.
    const s = buildSummary({
      jobLabel: job.label,
      mode: 'in',
      expected: ['asset-fx9-1'],
      recorded: [],
      assumed: [],
      unknownTags: [],
      facts: factsOf(db),
    })
    assert.equal(s.missing.length, 1)
    assert.equal(s.missing[0].valueMinor, 3_500_000 * 100)
    assert.deepEqual(s.missingValue, { totalMinor: 350_000_000, priced: 1, unpriced: 0 })
  })

  test('going out, the same gap is a day of revenue, not a claim', () => {
    const { db, seed } = build()
    const s = buildSummary({
      jobLabel: seed.jobs[0].label,
      mode: 'out',
      expected: ['asset-fx9-1'],
      recorded: [],
      assumed: [],
      unknownTags: [],
      facts: factsOf(db),
    })
    assert.equal(s.missing[0].valueMinor, 25_000 * 100)
  })

  test('an unpriced item is counted, never priced at zero', () => {
    const { db, seed } = build()
    // Sachdeva Tripod is deliberately seeded without a rate.
    const s = buildSummary({
      jobLabel: seed.jobs[0].label,
      mode: 'in',
      expected: ['asset-fx9-1', 'asset-sachdeva-1'],
      recorded: [],
      assumed: [],
      unknownTags: [],
      facts: factsOf(db),
    })
    const tripod = s.missing.find((m) => m.key === 'asset-sachdeva-1')
    assert.equal(tripod.valueMinor, null)
    // The header total: the FX9's money, plus the honest unpriced count.
    assert.deepEqual(s.missingValue, { totalMinor: 350_000_000, priced: 1, unpriced: 1 })
    assert.equal(moneyLabel(s.missingValue), 'Rs 3,500,000 +1 unpriced')
  })

  test('nothing missing means a zero total with nothing to say', () => {
    const { db, seed } = build()
    const s = buildSummary({
      jobLabel: seed.jobs[0].label,
      mode: 'in',
      expected: ['asset-fx9-1'],
      recorded: ['asset-fx9-1'],
      assumed: [],
      unknownTags: [],
      facts: factsOf(db),
    })
    assert.deepEqual(s.missingValue, { totalMinor: 0, priced: 0, unpriced: 0 })
    assert.equal(moneyLabel(s.missingValue), null)
  })
})
