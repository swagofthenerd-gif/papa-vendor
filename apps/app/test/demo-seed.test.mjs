/**
 * The demo warehouse.
 *
 * Worth testing rather than eyeballing, because the demo is currently the ONLY
 * way anyone exercises the scan engine end to end, and a seed that quietly
 * drifts out of shape (a tag pointing at no asset, a job expecting gear the
 * house does not own) would make the engine look broken when it is not.
 *
 * Runs against the real on-device schema and the real ScanSession, through
 * node:sqlite. Only the browser's SQLite is swapped out.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA } from '@papa/core'
import { ScanSession, buildPullList, matchKitList, parseKitList, checkAvailability } from '@papa/core'
import { seedDemo, demoCatalogue } from '../src/demo/seed.ts'

let db
let seed

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
})

describe('the demo seed', () => {
  test('every tag resolves to an asset that exists', () => {
    assert.ok(seed.tags.length > 50, 'a house with fifty-odd items, not three')
    for (const tag of seed.tags) {
      const row = db.get(
        `select a.id from asset_tags t join assets a on a.id = t.asset_id where t.tag_code = ?`,
        [tag.tagCode],
      )
      assert.ok(row, `tag ${tag.tagCode} points at nothing`)
    }
  })

  test('tag codes are stable across runs', () => {
    // The demo database is in memory and is rebuilt on every refresh. If the
    // codes moved, every label already printed or displayed would stop
    // working — which is the one thing a demo must not do to someone who has
    // just stuck labels on things.
    const other = new NodeSqliteDriver()
    other.exec(LOCAL_SCHEMA)
    const again = seedDemo(other)
    assert.deepEqual(
      seed.tags.map((t) => t.tagCode),
      again.tags.map((t) => t.tagCode),
    )
  })

  test('tag codes carry the server format', () => {
    for (const tag of seed.tags) {
      assert.match(tag.tagCode, /^v1[A-Z0-9]{22}$/)
    }
  })

  test('every job expects gear the house actually owns', () => {
    for (const job of seed.jobs) {
      assert.ok(job.expected.length > 0, `${job.label} expects nothing`)
      for (const assetId of job.expected) {
        const row = db.get(`select id from assets where id = ?`, [assetId])
        assert.ok(row, `${job.label} expects ${assetId}, which does not exist`)
      }
    }
  })
})

describe('the scan loop against the demo house', () => {
  test('scanning an expected tag is accepted and counts', () => {
    const job = seed.jobs[0]
    const session = new ScanSession(db, {
      deviceId: 'test',
      jobId: job.id,
      expected: new Set(job.expected),
    })
    const tag = seed.tags.find((t) => t.assetId === job.expected[0])
    const result = session.scan(tag.tagCode)
    assert.equal(result.outcome, 'accepted')
    assert.equal(result.assetId, job.expected[0])
  })

  test('the same tag twice reads as a duplicate, not a second item', () => {
    const job = seed.jobs[0]
    const session = new ScanSession(db, {
      deviceId: 'test',
      jobId: job.id,
      expected: new Set(job.expected),
    })
    const tag = seed.tags.find((t) => t.assetId === job.expected[0])
    session.scan(tag.tagCode)
    assert.equal(session.scan(tag.tagCode).outcome, 'duplicate')
    assert.equal(session.scannedIds.length, 1)
  })

  test('the camera already out to another job warns, and still records', () => {
    // The seed deliberately leaves one FX6 out on the documentary. Without it
    // the demo could never show the local double-checkout warning, which is
    // the check the whole offline design exists to make possible.
    const session = new ScanSession(db, {
      deviceId: 'test',
      jobId: 'job-wedding',
      expected: new Set(['asset-fx6-3']),
    })
    const tag = seed.tags.find((t) => t.assetId === 'asset-fx6-3')
    const result = session.scan(tag.tagCode)
    assert.equal(result.outcome, 'conflict')
    assert.ok(result.message.includes('Documentary'), 'names the job it is out on')
    assert.equal(session.scannedIds.length, 1, 'recorded anyway — the truck is real')
  })

  test('an unknown tag is recorded rather than rejected', () => {
    const session = new ScanSession(db, { deviceId: 'test', jobId: 'job-shan' })
    const result = session.scan('v1NOTAREALTAGCODEATALL0')
    assert.equal(result.outcome, 'unknown_tag')
    assert.ok(result.outboxId, 'queued, not dropped')
  })

  test('the pull list names the shelves the remaining gear is on', () => {
    const job = seed.jobs[0]
    const view = buildPullList(db, job.expected, [])
    assert.equal(view.total, job.expected.length)
    assert.ok(view.groups.length > 1, 'a real pull crosses more than one shelf')
    for (const g of view.groups) {
      assert.ok(g.locationName && g.locationName !== '—', 'every group is a place to walk to')
    }
  })
})

describe('the kit-list reader against the demo catalogue', () => {
  const answer = (text) =>
    checkAvailability(db, matchKitList(parseKitList(text), demoCatalogue()))

  test('a plain WhatsApp message resolves to real stock', () => {
    // One item per line, greeting included — the shape these actually arrive
    // in. The parser is line-based, so a run-on sentence is deliberately NOT
    // split at "and": guessing where one item ends and the next begins is the
    // kind of silent mistake that sends the wrong body to a set.
    const summary = answer(
      [
        'Salam bhai',
        '1 Sony FX9',
        '2 Aputure 600D Pro',
        'Thursday to Saturday, please confirm',
      ].join('\n'),
    )
    const fx9 = summary.lines.find((l) => l.productName === 'Sony FX9')
    assert.ok(fx9, 'found the camera')
    assert.equal(fx9.state, 'available')

    const light = summary.lines.find((l) => l.productName === 'Aputure 600D Pro')
    assert.ok(light, 'found the light')
    assert.equal(light.wanted, 2)
  })

  test('C300 and C500 are never guessed between', () => {
    // They differ by one character. Auto-matching here sends the wrong body to
    // a set, so the reader must hand it to a person instead.
    const summary = answer('C300 body')
    const line = summary.lines[0]
    assert.notEqual(line.confidence, 'strong', 'a one-character difference is not a strong match')
  })

  test('a faulty light is not offered as available', () => {
    // Four 600Ds exist; one is marked faulty in the seed. A lens that ships
    // broken costs more than one you declined.
    const summary = answer('4 Aputure 600D Pro')
    const line = summary.lines[0]
    assert.equal(line.onHand, 3)
    assert.equal(line.state, 'short')
  })
})
