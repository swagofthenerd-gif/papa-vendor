/**
 * Answering a pasted kit list.
 *
 * The tests that matter are the ones about NOT ANSWERING: an unresolved line
 * must never be given a stock figure, and must never be silently dropped from
 * the reply. Both mistakes produce a confident message to a client about gear
 * nobody actually checked.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { parseKitList, matchKitList } from '../src/kit-list.ts'
import { checkAvailability, replySummary, availabilityNote } from '../src/availability.ts'

const ORG = 'org-1'
const CATALOGUE = [
  { id: 'p1', name: 'Sony FX9' },
  { id: 'p2', name: 'ARRI Alexa Mini' },
  { id: 'p3', name: 'Sachtler Tripod' },
  { id: 'p5', name: 'V-Mount Battery' },
]

let db
let n = 0

function addAsset(productId, over = {}) {
  db.exec(
    `insert into assets (id, org_id, product_id, asset_code, presence, health)
     values (?, ?, ?, ?, ?, ?)`,
    [`a${++n}`, ORG, productId, `C${n}`, over.presence ?? 'here', over.health ?? 'ok'],
  )
}

const answer = (text) => checkAvailability(db, matchKitList(parseKitList(text), CATALOGUE))

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  n = 0
})

describe('counting what is on the shelf', () => {
  test('enough of it is available', () => {
    addAsset('p1'); addAsset('p1'); addAsset('p1')
    const [line] = answer('2x Sony FX9').lines
    assert.equal(line.state, 'available')
    assert.equal(line.onHand, 3)
    assert.equal(line.wanted, 2)
  })

  test('some but not all is SHORT, with the real number', () => {
    addAsset('p1')
    const [line] = answer('3x Sony FX9').lines
    assert.equal(line.state, 'short')
    assert.equal(line.onHand, 1)
  })

  test('none at all is none', () => {
    const [line] = answer('Sony FX9').lines
    assert.equal(line.state, 'none')
    assert.equal(line.onHand, 0)
  })
})

describe('what does not count as available', () => {
  test('gear out on another job is not on the shelf', () => {
    addAsset('p1', { presence: 'out' })
    addAsset('p1')
    const [line] = answer('2x Sony FX9').lines
    assert.equal(line.onHand, 1)
    assert.equal(line.state, 'short')
  })

  // A lens that ships broken costs more than one you declined.
  test('gear in for service is never promised', () => {
    addAsset('p3', { health: 'servicing' })
    const [line] = answer('Sachtler Tripod').lines
    assert.equal(line.onHand, 0)
    assert.equal(line.state, 'none')
  })

  test('quarantined gear is never promised', () => {
    addAsset('p3', { health: 'quarantined' })
    const [line] = answer('Sachtler Tripod').lines
    assert.equal(line.state, 'none')
  })
})

describe('lines the parser was not sure about', () => {
  // The important one. A stock figure attached to a guess reads as fact, and
  // the owner quotes it.
  test('an unresolved line gets NO stock number', () => {
    addAsset('p5'); addAsset('p5'); addAsset('p5'); addAsset('p5')
    const [line] = answer('4 batteries').lines
    assert.equal(line.state, 'unknown')
    assert.equal(line.onHand, 0, 'must not report a count for something unidentified')
  })

  test('an unresolved line still counts as needing attention', () => {
    const summary = answer('smoke machine')
    assert.equal(summary.needsAttention, 1)
    assert.equal(summary.canFulfilEverything, false)
  })
})

describe('the reply that gets pasted back into WhatsApp', () => {
  test('says yes plainly when everything is there', () => {
    addAsset('p1'); addAsset('p1'); addAsset('p3')
    const summary = answer('2x Sony FX9\nSachtler Tripod')
    assert.equal(summary.canFulfilEverything, true)
    const text = replySummary(summary)
    assert.match(text, /✅ 2x Sony FX9/)
    assert.match(text, /✅ 1x Sachtler Tripod/)
  })

  test('gives the real number when short, not a vague no', () => {
    addAsset('p1')
    const text = replySummary(answer('3x Sony FX9'))
    assert.match(text, /only 1 of 3/)
  })

  // Dropping it would send a reply that silently ignores something the client
  // asked for — and they find out on the truck instead of now.
  test('an unresolved line appears in the reply rather than vanishing', () => {
    addAsset('p1')
    const text = replySummary(answer('2x Sony FX9\nsmoke machine'))
    assert.match(text, /smoke machine/)
    assert.match(text, /❓/)
  })

  test('every line of the request is represented in the reply', () => {
    addAsset('p1')
    const summary = answer('2x Sony FX9\n4 batteries\nsmoke machine')
    assert.equal(replySummary(summary).split('\n').length, summary.lines.length)
  })
})

describe('what the owner already knows is promised', () => {
  // Tuesday 15 September 2026, local time — fixed so labels are golden.
  const NOW = new Date(2026, 8, 15, 10, 0).getTime()

  const commitment = (over = {}) => ({
    jobId: 'j1',
    jobLabel: 'Shan Foods TVC',
    expectedBack: '2026-09-17',
    productIds: ['p1'],
    out: true,
    ...over,
  })

  const ask = (text, commitments) =>
    checkAvailability(db, matchKitList(parseKitList(text), CATALOGUE), commitments, NOW)

  test('without commitments the answer is unchanged, with empty notes', () => {
    addAsset('p1')
    const [line] = ask('Sony FX9').lines
    assert.deepEqual(line.committed, [])
  })

  test('a commitment on the product is reported with job, count and back label', () => {
    addAsset('p1'); addAsset('p1')
    addAsset('p1', { presence: 'out' })
    const [line] = ask('2x Sony FX9', [commitment()]).lines

    assert.equal(line.onHand, 2, 'the here-now count stays the honest shelf count')
    assert.deepEqual(line.committed, [{
      jobId: 'j1',
      jobLabel: 'Shan Foods TVC',
      count: 1,
      expectedBack: '2026-09-17',
      backLabel: 'back Thu 17 Sep',
      out: true,
    }])
  })

  test('commitments on other products do not leak onto this line', () => {
    addAsset('p1')
    const [line] = ask('Sony FX9', [commitment({ productIds: ['p3', 'p3'] })]).lines
    assert.deepEqual(line.committed, [])
  })

  test('two units on one job is one note with count 2', () => {
    addAsset('p1')
    const [line] = ask('Sony FX9', [commitment({ productIds: ['p1', 'p1'] })]).lines
    assert.equal(line.committed.length, 1)
    assert.equal(line.committed[0].count, 2)
  })

  test('notes are ordered soonest-back first, no-date last', () => {
    addAsset('p1')
    const [line] = ask('Sony FX9', [
      commitment({ jobId: 'j3', jobLabel: 'Mehndi shoot', expectedBack: null }),
      commitment({ jobId: 'j2', jobLabel: 'Wedding', expectedBack: '2026-09-21' }),
      commitment({ jobId: 'j1', expectedBack: '2026-09-17' }),
    ]).lines
    assert.deepEqual(line.committed.map((c) => c.jobId), ['j1', 'j2', 'j3'])
  })

  test('an unparseable expected_back is reported as "no date", never invented', () => {
    addAsset('p1')
    const [line] = ask('Sony FX9', [commitment({ expectedBack: 'after eid' })]).lines
    assert.equal(line.committed[0].backLabel, 'no date')
    assert.equal(line.committed[0].expectedBack, 'after eid', 'raw value kept for the caller')
  })

  test('an overdue commitment says how late, computed locally at answer time', () => {
    addAsset('p1')
    const [line] = ask('Sony FX9', [commitment({ expectedBack: '2026-09-12' })]).lines
    assert.equal(line.committed[0].backLabel, '3 days late')
  })

  test('an unresolved line gets no commitment notes, for the same reason it gets no count', () => {
    const [line] = ask('4 batteries', [commitment({ productIds: ['p5'] })]).lines
    assert.equal(line.state, 'unknown')
    assert.deepEqual(line.committed, [])
  })

  describe('the one-line story the UI renders', () => {
    test('golden: here-now plus an out commitment', () => {
      addAsset('p1'); addAsset('p1')
      const [line] = ask('2x Sony FX9', [commitment()]).lines
      assert.equal(
        availabilityNote(line),
        '2 here now · 1 out on Shan Foods TVC, back Thu 17 Sep',
      )
    })

    test('golden: not yet departed reads "going to", and no date stays honest', () => {
      addAsset('p1')
      const [line] = ask('Sony FX9', [
        commitment({ out: false, expectedBack: null, jobLabel: 'Wedding' }),
      ]).lines
      assert.equal(availabilityNote(line), '1 here now · 1 going to Wedding, no date')
    })

    test('golden: nothing promised is just the shelf count', () => {
      addAsset('p1'); addAsset('p1'); addAsset('p1')
      const [line] = ask('Sony FX9', []).lines
      assert.equal(availabilityNote(line), '3 here now')
    })

    test('an unconfirmed line never gets a stock story', () => {
      const [line] = ask('smoke machine', [commitment()]).lines
      assert.equal(availabilityNote(line), 'unconfirmed item — no count')
    })
  })
})

describe('a whole realistic enquiry', () => {
  test('answers the message end to end', () => {
    addAsset('p1'); addAsset('p1')
    addAsset('p3')
    addAsset('p5'); addAsset('p5')

    const summary = answer(`Assalam o alaikum
Need for shoot:
1. 2x Sony FX9
2. Sachdeva tripod x2
3. 4 nos V-Mount Battery
Please confirm`)

    assert.equal(summary.lines.length, 3)
    assert.equal(summary.lines[0].state, 'available', 'both cameras are here')
    assert.equal(summary.lines[1].state, 'short', 'one tripod of the two asked for')
    assert.equal(summary.lines[2].state, 'short', 'two batteries of four')
    assert.equal(summary.canFulfilEverything, false)
    assert.equal(summary.needsAttention, 2)
  })
})
