/**
 * Condition photos.
 *
 * The out/in comparison is the best commercial feature in the product, and
 * both ways it can fail are silent: a photo quietly deleted to make room, and
 * a pair assembled out of the wrong two photos. Neither shows up as a crash;
 * both show up months later as a dispute lost.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { PhotoStore, pairBySide } from '../src/photos.ts'

let db
let clock
let seq

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  clock = 1_000
  seq = 0
})

const store = (budgetBytes) =>
  new PhotoStore(db, {
    budgetBytes,
    now: () => clock,
    newId: () => `p${++seq}`,
  })

const shot = (s, over = {}) =>
  s.capture({
    assetId: 'asset-1',
    jobId: 'job-1',
    sessionId: 'sess-1',
    side: 'out',
    localUri: 'data:image/webp;base64,AA',
    bytes: 150_000,
    sha256: 'abc',
    ...over,
  })

describe('capture', () => {
  test('records the photo and queues the bytes in one go', () => {
    const s = store()
    const r = shot(s)
    assert.equal(r.ok, true)

    const photo = db.get(`select * from condition_photos where id = ?`, [r.photo.id])
    assert.ok(photo, 'the row exists')
    assert.equal(photo.uploaded, 0)

    // If the row and the queue entry can separate, the app shows evidence the
    // owner does not actually have.
    const upload = db.get(`select * from pending_uploads where id = ?`, [r.photo.id])
    assert.ok(upload, 'the bytes are queued')
    assert.equal(upload.state, 'pending')
  })

  test('the upload path is the hash, so nothing can be overwritten', () => {
    const s = store()
    const r = shot(s, { sha256: 'deadbeef' })
    const upload = db.get(`select target_path from pending_uploads where id = ?`, [r.photo.id])
    assert.equal(upload.target_path, 'photos/deadbeef')
  })

  test('captured_at is the device clock, recorded as given', () => {
    const s = store()
    clock = 42_000
    const r = shot(s)
    assert.equal(r.photo.capturedAt, 42_000)
  })
})

describe('the device filling up', () => {
  test('refuses rather than deleting an un-uploaded photo', () => {
    // THE RULE. A blocked capture is a person walking to a laptop; a deleted
    // photo is the out-side half of a dispute, gone, discovered months later.
    const s = store(300_000)
    assert.equal(shot(s).ok, true)
    const second = shot(s)
    assert.equal(second.ok, true)

    const third = shot(s)
    assert.equal(third.ok, false)
    assert.equal(third.reason, 'device_full')

    // And nothing was thrown away to make room.
    const n = db.get(`select count(*) as n from condition_photos`).n
    assert.equal(Number(n), 2)
  })

  test('the refusal names how many are waiting, because that is the action', () => {
    const s = store(300_000)
    shot(s); shot(s)
    const blocked = shot(s)
    assert.equal(blocked.waiting, 2)
    assert.equal(blocked.bytesWaiting, 300_000)
  })

  test('an uploaded photo stops counting against the budget', () => {
    const s = store(300_000)
    const first = shot(s)
    shot(s)
    assert.equal(shot(s).ok, false, 'full')

    db.exec(`update condition_photos set uploaded = 1 where id = ?`, [first.photo.id])
    assert.equal(shot(s).ok, true, 'room again once the bytes are safe elsewhere')
  })
})

describe('pairing out with in', () => {
  test('pairs a return with the departure that preceded it', () => {
    const s = store()
    clock = 100; const out = shot(s, { side: 'out' })
    clock = 200; const back = shot(s, { side: 'in' })

    const pairs = pairBySide(s.forAsset('asset-1'))
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].out.id, out.photo.id)
    assert.equal(pairs[0].in.id, back.photo.id)
  })

  test('two photos of one side do not shift the pairing', () => {
    // The normal case: the second photo is of the thing that worried them.
    // Pairing positionally would marry photo #2 of the departure to the
    // return, and show a client a scratch that was already there.
    const s = store()
    clock = 100; const outA = shot(s, { side: 'out' })
    clock = 110; const outB = shot(s, { side: 'out' })
    clock = 300; const back = shot(s, { side: 'in' })

    const pairs = pairBySide(s.forAsset('asset-1'))
    assert.equal(pairs.length, 2)
    const first = pairs.find((p) => p.out.id === outA.photo.id)
    const second = pairs.find((p) => p.out.id === outB.photo.id)
    assert.equal(first.in.id, back.photo.id, 'the earliest departure claims the return')
    assert.equal(second.in, null, 'the second has no return of its own')
  })

  test('a return that predates a departure is never paired with it', () => {
    // Otherwise a photo taken last month gets attached to today's job.
    const s = store()
    clock = 500; shot(s, { side: 'in' })
    clock = 900; const out = shot(s, { side: 'out' })

    const pairs = pairBySide(s.forAsset('asset-1'))
    const forOut = pairs.find((p) => p.out?.id === out.photo.id)
    assert.equal(forOut.in, null)
  })

  test('gear that went out with no photo coming back is still reported', () => {
    const s = store()
    clock = 100; shot(s, { side: 'out' })
    const pairs = pairBySide(s.forAsset('asset-1'))
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].in, null, 'the gap is the finding')
  })

  test('a return with no departure photo is surfaced, not dropped', () => {
    // It means gear left without evidence, which is the gap that costs money.
    const s = store()
    clock = 100; shot(s, { side: 'in' })
    const pairs = pairBySide(s.forAsset('asset-1'))
    assert.equal(pairs.length, 1)
    assert.equal(pairs[0].out, null)
    assert.ok(pairs[0].in)
  })
})
