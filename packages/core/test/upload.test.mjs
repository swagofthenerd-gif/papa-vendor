/**
 * The upload seam, against a real SQLite and a fake host.
 *
 * Pinned: the URL provider is asked per row and the bytes go where it
 * says; success marks the queue row AND the evidence row in one step;
 * failure defers and never evicts; wifi_only rows wait for wifi.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import { PhotoStore } from '../src/photos.ts'
import { Uploader, decodeDataUri } from '../src/upload.ts'

let db
beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  db.exec(`insert into assets (id, org_id) values ('a1', 'o')`)
})

const JPEG = 'data:image/jpeg;base64,' + Buffer.from('not really a jpeg').toString('base64')

function capture(id) {
  const store = new PhotoStore(db, { budgetBytes: 1e6, newId: () => id, now: () => 1 })
  const r = store.capture({ assetId: 'a1', side: 'out', localUri: JPEG, bytes: 17 })
  assert.equal(r.ok, true, JSON.stringify(r))
  return r
}

function hostWith(answer) {
  const puts = []
  const uploader = new Uploader(db, {
    getUploadUrl: async (path) => ({ url: `https://bucket/${path}`, headers: { 'x-sig': 'ok' } }),
    fetch: async (url, init) => { puts.push({ url, init }); return answer(url, init) },
  })
  return { uploader, puts }
}

describe('draining', () => {
  test('PUTs the bytes where the provider says, then marks queue and evidence together', async () => {
    capture('ph1')
    const { uploader, puts } = hostWith(() => new Response(null, { status: 200 }))
    const report = await uploader.drain()
    assert.equal(report.uploaded, 1)
    assert.equal(report.deferred, 0)
    assert.equal(puts[0].init.method, 'PUT')
    assert.equal(puts[0].init.headers['x-sig'], 'ok')
    assert.match(puts[0].url, /^https:\/\/bucket\/photos\//)
    assert.equal(Buffer.from(puts[0].init.body).toString(), 'not really a jpeg')
    assert.equal(db.get(`select state from pending_uploads where id = 'ph1'`).state, 'uploaded')
    assert.equal(db.get(`select uploaded from condition_photos where id = 'ph1'`).uploaded, 1)
    assert.equal(uploader.pendingCount(), 0)
  })

  test('a refusal defers: attempts climb, the row and the photo stay, nothing is evicted', async () => {
    capture('ph1')
    const { uploader } = hostWith(() => new Response('no', { status: 413 }))
    for (let i = 0; i < 3; i++) await uploader.drain()
    const row = db.get(`select state, attempts from pending_uploads where id = 'ph1'`)
    assert.equal(row.state, 'pending')
    assert.equal(row.attempts, 3)
    assert.equal(db.get(`select uploaded from condition_photos where id = 'ph1'`).uploaded, 0)
    assert.equal(db.get(`select count(*) as n from condition_photos`).n, 1)
  })

  test('a thrown fetch is the same deferral', async () => {
    capture('ph1')
    const { uploader } = hostWith(() => { throw new TypeError('fetch failed') })
    const report = await uploader.drain()
    assert.equal(report.deferred, 1)
    assert.match(report.errors[0], /fetch failed/)
  })

  test('wifi_only rows wait for wifi', async () => {
    capture('ph1')
    db.exec(`update pending_uploads set wifi_only = 1`)
    const { uploader, puts } = hostWith(() => new Response(null, { status: 200 }))
    assert.equal((await uploader.drain(10, { wifi: false })).waitingForWifi, 1)
    assert.equal(puts.length, 0)
    assert.equal((await uploader.drain(10, { wifi: true })).uploaded, 1)
  })

  test('oldest first, up to the limit', async () => {
    capture('ph1'); capture('ph2'); capture('ph3')
    db.exec(`update pending_uploads set created_at = case id when 'ph1' then 3 when 'ph2' then 1 else 2 end`)
    const { uploader, puts } = hostWith(() => new Response(null, { status: 200 }))
    await uploader.drain(2)
    assert.equal(puts.length, 2)
    assert.deepEqual(db.all(`select id from pending_uploads where state = 'uploaded' order by id`).map((r) => r.id), ['ph2', 'ph3'])
  })
})

describe('decodeDataUri', () => {
  test('decodes base64 and plain payloads, refuses anything else', async () => {
    assert.equal(Buffer.from(await decodeDataUri('data:text/plain;base64,aGk=')).toString(), 'hi')
    assert.equal(Buffer.from(await decodeDataUri('data:text/plain,h%20i')).toString(), 'h i')
    await assert.rejects(decodeDataUri('file:///x.jpg'), /not a data: URI/)
  })
})
