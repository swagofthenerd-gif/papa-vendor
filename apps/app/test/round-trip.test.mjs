/**
 * Out and back — the whole loop.
 *
 * THE RULE UNDER TEST: a return is reconciled against what is PHYSICALLY OUT
 * on the job, never against the job's original list. Those two sets differ on
 * the normal morning — items follow on the 2pm run, the desk swaps a body at
 * the door, someone adds a spare — and reconciling a return against the list
 * would report gear as missing that never left the building.
 *
 * A return screen that cries wolf on the ordinary case is one a tech stops
 * reading by the second week, and then a genuinely lost camera goes unnoticed.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, ScanSession } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { buildSummary, shortfall } from '../src/session-summary.ts'

function build() {
  const db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  return { db, seed: seedDemo(db) }
}

/** What is actually out on a job right now, the way the store asks. */
const physicallyOut = (db, jobId) =>
  db
    .all(
      `select id from assets where current_job_id = ? and presence in ('out','in_transit')
        order by asset_code`,
      [jobId],
    )
    .map((r) => r.id)

const summarise = (db, jobLabel, mode, expected, session) =>
  buildSummary({
    jobLabel,
    mode,
    expected,
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

describe('a job goes out and comes back', () => {
  test('everything that went out, comes back clean', () => {
    const { db, seed } = build()
    const job = seed.jobs[0]

    const out = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    for (const id of job.expected) out.addManually(id, 'check_out')

    const nowOut = physicallyOut(db, job.id)
    assert.equal(nowOut.length, job.expected.length, 'the projection moved every item')

    const back = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(nowOut),
    })
    for (const id of nowOut) back.addManually(id, 'check_in')

    const s = summarise(db, job.label, 'in', nowOut, back)
    assert.equal(shortfall(s), 0)
    assert.equal(physicallyOut(db, job.id).length, 0, 'nothing is still out')
  })

  test('a partial pull is reconciled against what left, not what was promised', () => {
    // THE REGRESSION THIS EXISTS FOR. Four of eleven went out. Everything that
    // left comes back. The return must report NOTHING missing — the other
    // seven never left the shelf.
    const { db, seed } = build()
    const job = seed.jobs[0]

    const out = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    for (const id of job.expected.slice(0, 4)) out.addManually(id, 'check_out')

    const nowOut = physicallyOut(db, job.id)
    assert.equal(nowOut.length, 4)

    const back = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(nowOut),
    })
    for (const id of nowOut) back.addManually(id, 'check_in')

    const s = summarise(db, job.label, 'in', nowOut, back)
    assert.equal(s.expected, 4, 'the return is about the four that left')
    assert.equal(shortfall(s), 0, 'nothing is missing — the other seven never left')

    // And against the original list it WOULD have cried wolf, which is the
    // whole point of not doing that.
    const wrong = summarise(db, job.label, 'in', job.expected, back)
    assert.equal(shortfall(wrong), 7)
  })

  test('gear that does not come back is named', () => {
    const { db, seed } = build()
    const job = seed.jobs[0]

    const out = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(job.expected),
    })
    for (const id of job.expected) out.addManually(id, 'check_out')

    const nowOut = physicallyOut(db, job.id)
    const back = new ScanSession(db, {
      deviceId: 't', jobId: job.id, expected: new Set(nowOut),
    })
    for (const id of nowOut.slice(0, nowOut.length - 2)) back.addManually(id, 'check_in')

    const s = summarise(db, job.label, 'in', nowOut, back)
    assert.equal(shortfall(s), 2)
    assert.equal(s.missing.length, 2)
    for (const m of s.missing) assert.ok(m.name, 'a missing item is named, not just counted')

    assert.equal(physicallyOut(db, job.id).length, 2, 'and it still reads as out')
  })

  test('an item returned to the wrong job still comes home', () => {
    // A case comes back on someone else's truck. Physical reality outranks the
    // schedule: it is here, and the app must record that rather than refuse.
    const { db, seed } = build()
    const shan = seed.jobs[0]

    const out = new ScanSession(db, {
      deviceId: 't', jobId: shan.id, expected: new Set(shan.expected),
    })
    out.addManually(shan.expected[0], 'check_out')
    assert.equal(physicallyOut(db, shan.id).length, 1)

    const wrongDesk = new ScanSession(db, {
      deviceId: 't', jobId: seed.jobs[1].id, expected: new Set(),
    })
    const r = wrongDesk.addManually(shan.expected[0], 'check_in')
    assert.equal(r.outcome, 'accepted')
    assert.equal(physicallyOut(db, shan.id).length, 0, 'it is home either way')
  })
})
