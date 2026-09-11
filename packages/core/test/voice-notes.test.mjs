/**
 * Voice notes (voice-notes.ts; 0021, Phase D5).
 *
 * The storage model is the condition-photos model, and the same two silent
 * failures matter: a note quietly deleted to make room, and a note shown
 * on screen that was never actually queued to leave the phone.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { VoiceNoteStore } from '../src/voice-notes.ts'

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
  new VoiceNoteStore(db, {
    budgetBytes,
    now: () => clock,
    newId: () => `v${++seq}`,
  })

const say = (s, over = {}) =>
  s.capture({
    assetId: 'asset-1',
    jobId: 'job-1',
    sessionId: 'sess-1',
    durationMs: 8_000,
    localUri: 'data:audio/webm;base64,AA',
    bytes: 90_000,
    mime: 'audio/webm',
    ...over,
  })

describe('capture', () => {
  test('records the note and queues the bytes in one write', () => {
    const s = store()
    const r = say(s)
    assert.equal(r.ok, true)
    assert.equal(r.note.capturedAt, 1_000)
    assert.equal(r.note.uploaded, false)

    const queued = db.get(`select target_path, state, bytes from pending_uploads where id = 'v1'`)
    assert.equal(queued.target_path, 'voice/v1')
    assert.equal(queued.state, 'pending')
    assert.equal(Number(queued.bytes), 90_000)
  })

  test('refuses when full and says how much is waiting — never evicts', () => {
    const s = store(200_000)
    assert.equal(say(s).ok, true)
    assert.equal(say(s).ok, true)

    const r = say(s)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'device_full')
    assert.equal(r.waiting, 2)
    assert.equal(r.bytesWaiting, 180_000)

    // The refusal deleted NOTHING: both earlier notes still exist.
    assert.equal(Number(db.get(`select count(*) as n from voice_notes`).n), 2)
  })

  test('uploaded notes free the budget; un-uploaded ones never stop counting', () => {
    const s = store(200_000)
    say(s)
    say(s)
    db.exec(`update voice_notes set uploaded = 1 where id = 'v1'`)
    assert.equal(s.pendingStats().count, 1)
    assert.equal(say(s).ok, true, 'room again once a note has actually left the phone')
  })
})

describe('reads', () => {
  test('forAsset and forSession, newest first', () => {
    const s = store()
    say(s)
    clock = 2_000
    say(s, { sessionId: 'sess-2' })
    clock = 3_000
    say(s, { assetId: 'asset-2' })

    const forAsset = s.forAsset('asset-1')
    assert.deepEqual(forAsset.map((n) => n.id), ['v2', 'v1'])
    assert.equal(forAsset[0].durationMs, 8_000)

    assert.deepEqual(s.forSession('sess-1').map((n) => n.id), ['v3', 'v1'])
  })

  test('a note with no asset (a session-level word) still lands and reads back', () => {
    const s = store()
    const r = say(s, { assetId: null })
    assert.equal(r.ok, true)
    assert.equal(r.note.assetId, null)
    assert.deepEqual(s.forSession('sess-1').map((n) => n.id), ['v1'])
  })
})
