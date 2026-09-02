/**
 * Din ka hisaab — the day's account.
 *
 * The account is derived from the queue (via the ONE decode helper), the
 * mirror and the photo table, entirely locally. What is worth pinning down is
 * the classification: out vs back, trust vs observation, today vs not-today,
 * one job's day vs another's — and that a rescan is the same physical fact,
 * not a second departure.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, PhotoStore } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { SessionRegistry } from '../src/demo/sessions.ts'
import { dayAccount, dayAccountText, dayBounds } from '../src/demo/hisaab.ts'

let db
let seed
let registry

const expectedFor = (jobId, mode) => {
  if (mode === 'out') return seed.jobs.find((j) => j.id === jobId)?.expected ?? []
  return db
    .all(
      `select id from assets
        where current_job_id = ? and presence in ('out', 'in_transit')
        order by asset_code`,
      [jobId],
    )
    .map((r) => r.id)
}

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  registry = new SessionRegistry(db, 'test-device', expectedFor)
})

const group = (account, jobId) => account.jobs.find((g) => g.jobId === jobId)

describe('classification', () => {
  test('out, back, trust and photos each land in their own column', () => {
    const shan = seed.jobs[0]
    const prep = registry.open(shan.id, 'out')
    prep.session.addManually(shan.expected[0], 'check_out')
    prep.session.addManually(shan.expected[1], 'check_out')
    // Two taken on trust — the case was sealed and nobody opened it.
    prep.session.confirmContents([shan.expected[2], shan.expected[3]], 'check_out')

    const back = registry.open('job-doc', 'in')
    back.session.addManually(back.expected[0], 'check_in')

    new PhotoStore(db).capture({
      assetId: shan.expected[0],
      jobId: shan.id,
      side: 'out',
      localUri: 'data:x',
      bytes: 10,
    })

    const account = dayAccount(db, Date.now())
    assert.equal(account.wentOut, 4)
    assert.equal(account.cameBack, 1)
    assert.equal(account.onTrust, 2)
    assert.equal(account.photos, 1)

    const g = group(account, shan.id)
    assert.equal(g.out.length, 4)
    assert.equal(g.back.length, 0)
    assert.equal(g.photos, 1)
    // The trust mark sits on exactly the items that were never seen.
    assert.deepEqual(
      g.out.filter((i) => i.assumed).map((i) => i.assetId).sort(),
      [shan.expected[2], shan.expected[3]].sort(),
    )
    // And the items carry names and codes the evening reader can act on.
    assert.ok(g.out.every((i) => i.code !== null && i.name !== null))
  })

  test('jobs group separately — one job\'s day never bleeds into another\'s', () => {
    const shan = seed.jobs[0]
    registry.open(shan.id, 'out').session.addManually(shan.expected[0], 'check_out')
    const back = registry.open('job-doc', 'in')
    back.session.addManually(back.expected[0], 'check_in')

    const account = dayAccount(db, Date.now())
    assert.equal(group(account, shan.id).out.length, 1)
    assert.equal(group(account, shan.id).back.length, 0)
    assert.equal(group(account, 'job-doc').back.length, 1)
    assert.equal(group(account, 'job-doc').out.length, 0)
  })

  test('an unknown label is counted, not dropped', () => {
    const shan = seed.jobs[0]
    registry.open(shan.id, 'out').session.scan('v1NOTAREALTAGCODEATALL0')
    const account = dayAccount(db, Date.now())
    assert.equal(account.unknownTags, 1)
  })

  test('a rescan in a later session is the same fact, counted once', () => {
    const shan = seed.jobs[0]
    registry.open(shan.id, 'out').session.addManually(shan.expected[0], 'check_out')
    registry.endCurrent()
    registry.open(shan.id, 'out').session.addManually(shan.expected[0], 'check_out')

    assert.equal(
      db.get(`select count(*) as n from outbox`).n, 2,
      'the queue really holds two ops — the dedupe is the account\'s, not the engine\'s',
    )
    assert.equal(dayAccount(db, Date.now()).wentOut, 1)
  })

  test('a scan upgrades trust to observation, in either order of arrival', () => {
    const shan = seed.jobs[0]
    // Trust first, then seen.
    registry.open(shan.id, 'out').session.confirmContents([shan.expected[0]], 'check_out')
    registry.endCurrent()
    registry.open(shan.id, 'out').session.addManually(shan.expected[0], 'check_out')
    registry.endCurrent()
    // Seen first, then a later trust-confirm of the same item.
    registry.open(shan.id, 'out').session.addManually(shan.expected[1], 'check_out')
    registry.endCurrent()
    registry.open(shan.id, 'out').session.confirmContents([shan.expected[1]], 'check_out')

    const g = group(dayAccount(db, Date.now()), shan.id)
    assert.equal(g.out.length, 2)
    // Neither is still a belief: something real was seen both times.
    assert.deepEqual(g.out.filter((i) => i.assumed), [])
  })
})

describe('the day boundary', () => {
  test('yesterday\'s scans are not today\'s account', () => {
    const shan = seed.jobs[0]
    registry.open(shan.id, 'out').session.addManually(shan.expected[0], 'check_out')

    const now = Date.now()
    const { startMs } = dayBounds(now)
    // Push the op back to yesterday evening, the way a phone that scanned
    // yesterday and never synced would hold it.
    db.exec(`update outbox set created_at = ?`, [startMs - 60 * 60 * 1000])

    const account = dayAccount(db, now)
    assert.equal(account.wentOut, 0)
    assert.equal(account.jobs.length, 0)
  })

  test('yesterday\'s photos are not today\'s either', () => {
    // The seed itself plants demo condition photos dated 2026-08-14 — they
    // must not leak into today's photo count.
    const account = dayAccount(db, Date.now())
    assert.equal(account.photos, 0)
  })
})

describe('what is still out', () => {
  test('carries the due label the Today board shows, from the same read', () => {
    const account = dayAccount(db, Date.now())
    // The seed has gear physically out (job-doc among others).
    assert.ok(account.stillOut.length > 0)
    for (const j of account.stillOut) {
      assert.equal(typeof j.due.label, 'string')
      assert.ok(j.out > 0)
    }
  })
})

describe('the WhatsApp copy', () => {
  test('is compact: counts per job, never item recitations', () => {
    const shan = seed.jobs[0]
    const prep = registry.open(shan.id, 'out')
    prep.session.addManually(shan.expected[0], 'check_out')
    prep.session.confirmContents([shan.expected[1]], 'check_out')

    const text = dayAccountText(dayAccount(db, Date.now()))
    assert.match(text, /^Din ka hisaab — /)
    assert.match(text, /Out 2 · Back 0 · On trust 1/)
    assert.match(text, new RegExp(`${shan.label.slice(0, 10)}.*2 out \\(1 on trust\\)`))
    assert.match(text, /Still out:/)
    // Item names stay on the screen; the message that gets forwarded to a
    // staff group must not scroll.
    assert.doesNotMatch(text, /Sony FX9/)
  })

  test('an empty day says so instead of rendering a page of zeros', () => {
    const text = dayAccountText(dayAccount(db, Date.now()))
    assert.match(text, /Nothing scanned or photographed today\./)
  })

  test('still-out lines carry the honest due label', () => {
    const text = dayAccountText(dayAccount(db, Date.now()))
    // Every still-out line ends in a due label — 'due today', 'N days late',
    // 'back <day>', or the honest 'no date'.
    const lines = text.split('\n').filter((l) => l.startsWith('- '))
    assert.ok(lines.length > 0)
    for (const l of lines) {
      assert.match(l, /items?, (due today|\d+ days? late|back \w{3} \d+ \w{3}|no date)$/)
    }
  })
})
