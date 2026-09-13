/**
 * The PostgREST transport, against a fake fetch.
 *
 * What is worth pinning: the headers (one session header, never a JWT), the
 * request shape (POST /rpc/<name>, named args), and above all the error
 * rule — retryable versus verdict — because the flush loop parks or backs
 * off on exactly that bit, and both mistakes are expensive.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { PostgrestTransport, errorFrom } from '../src/transport/postgrest.ts'
import { TransportError } from '../src/sync.ts'

const json = (status, body) =>
  new Response(body === undefined ? '' : JSON.stringify(body), {
    status, headers: { 'content-type': 'application/json' },
  })

function transportWith(handler, opts = {}) {
  const calls = []
  const t = new PostgrestTransport({
    baseUrl: 'http://pipe.test/',
    sessionToken: () => ('token' in opts ? opts.token : 'tok-1'),
    anonKey: opts.anonKey,
    fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init) },
    timeoutMs: opts.timeoutMs,
  })
  return { t, calls }
}

describe('the request', () => {
  test('is POST /rpc/<name> with named args and the session header', async () => {
    const { t, calls } = transportWith(() => json(200, { ok: 1 }))
    const out = await t.rpc('pull_changes', { p_since: 7, p_limit: 10 })
    assert.deepEqual(out, { ok: 1 })
    assert.equal(calls[0].url, 'http://pipe.test/rpc/pull_changes', 'trailing slash trimmed')
    assert.equal(calls[0].init.method, 'POST')
    assert.deepEqual(JSON.parse(calls[0].init.body), { p_since: 7, p_limit: 10 })
    assert.equal(calls[0].init.headers['x-papa-session'], 'tok-1')
    assert.equal(calls[0].init.headers['content-type'], 'application/json')
    assert.equal('authorization' in calls[0].init.headers, false, 'never a JWT')
    assert.equal('apikey' in calls[0].init.headers, false, 'plain PostgREST wants no apikey')
  })

  test('sends no session header before enrolment, and apikey when given', async () => {
    const { t, calls } = transportWith(() => json(200, null), { token: null, anonKey: 'anon' })
    await t.rpc('complete_enrolment', {})
    assert.equal('x-papa-session' in calls[0].init.headers, false)
    assert.equal(calls[0].init.headers.apikey, 'anon')
  })

  test('reads the token per call, so a sign-out is seen by the next request', async () => {
    let token = 'a'
    const calls = []
    const t = new PostgrestTransport({
      baseUrl: 'http://x', sessionToken: () => token,
      fetch: async (_u, init) => { calls.push(init.headers['x-papa-session']); return json(200, 1) },
    })
    await t.rpc('a'); token = null; await t.rpc('b')
    assert.deepEqual(calls, ['a', undefined])
  })

  test('a 204 from a void function reads as null', async () => {
    const { t } = transportWith(() => new Response(null, { status: 204 }))
    assert.equal(await t.rpc('sign_out_device', {}), null)
  })

  test('submitScanBatch and pull are the two named RPCs', async () => {
    const { t, calls } = transportWith(() => json(200, []))
    await t.submitScanBatch('WH-01', [{ client_seq: 1 }])
    await t.pull(42, 100)
    assert.equal(calls[0].url, 'http://pipe.test/rpc/submit_scan_batch')
    assert.deepEqual(JSON.parse(calls[0].init.body), { p_device_id: 'WH-01', p_ops: [{ client_seq: 1 }] })
    assert.equal(calls[1].url, 'http://pipe.test/rpc/pull_changes')
    assert.deepEqual(JSON.parse(calls[1].init.body), { p_since: 42, p_limit: 100 })
  })
})

describe('the error rule', () => {
  const cases = [
    // [status, body, retryable, code]
    [500, undefined, true, 'http_500'],
    [502, '<html>bad gateway</html>', true, 'http_502'],
    [503, { code: 'PGRST002', message: 'schema cache' }, true, 'PGRST002'],
    [429, undefined, true, 'http_429'],
    [503, { code: '53300', message: 'too many OTP requests' }, true, '53300'],
    [500, { code: '08006', message: 'connection failure' }, true, '08006'],
    [409, { code: '23P01', message: 'asset FX9-02 is already promised to booking #7' }, false, '23P01'],
    [403, { code: '28000', message: 'invalid or expired device session' }, false, '28000'],
    [403, { code: '42501', message: 'no org context' }, false, '42501'],
    [400, { code: 'P0001', message: 'a booking needs at least one line' }, false, 'P0001'],
    [400, { code: '22023', message: 'this phone belongs to more than one organisation' }, false, '22023'],
    [404, { code: 'PGRST202', message: 'no such function' }, false, 'PGRST202'],
  ]
  for (const [status, body, retryable, code] of cases) {
    test(`${status} ${code} → ${retryable ? 'retryable' : 'a verdict'}`, () => {
      const err = errorFrom(status, body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body))
      assert.ok(err instanceof TransportError)
      assert.equal(err.retryable, retryable)
      assert.equal(err.code, code)
    })
  }

  test('a verdict carries the server\'s message', () => {
    const err = errorFrom(409, JSON.stringify({ code: '23P01', message: 'asset FX9-02 is already promised to booking #7' }))
    assert.equal(err.message, 'asset FX9-02 is already promised to booking #7')
  })

  test('a named client_seq rides through, from details or message', () => {
    assert.equal(
      errorFrom(400, JSON.stringify({ code: 'P0001', message: 'bad op', details: '{"client_seq": 17}' })).clientSeq, 17)
    assert.equal(
      errorFrom(400, JSON.stringify({ code: 'P0001', message: 'refused op with client_seq 9' })).clientSeq, 9)
    assert.equal(errorFrom(400, JSON.stringify({ code: 'P0001', message: 'nothing named' })).clientSeq, null)
    assert.equal(
      errorFrom(503, JSON.stringify({ code: '53300', message: 'client_seq 4' })).clientSeq, null,
      'a retryable error names no poison — nothing is parked on it')
  })

  test('a thrown fetch is retryable "network"', async () => {
    const { t } = transportWith(() => { throw new TypeError('fetch failed') })
    await assert.rejects(t.rpc('x'), (err) =>
      err instanceof TransportError && err.retryable && err.code === 'network')
  })

  test('a timeout is retryable "timeout"', async () => {
    const { t } = transportWith((_u, init) => new Promise((_res, rej) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; rej(e)
      })
    }), { timeoutMs: 20 })
    await assert.rejects(t.rpc('x'), (err) =>
      err instanceof TransportError && err.retryable && err.code === 'timeout')
  })
})
