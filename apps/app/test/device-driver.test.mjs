/**
 * The device database driver, against a REAL SQLite behind a FAKE bridge.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PROVES AND WHAT IT CANNOT
 *
 * The Android side of W12 is ~450 lines of Java that this machine cannot run:
 * the emulator segfaults here (docs/android.md, "What the emulator could not
 * do"), so Java is verified by reading, and reading is not a test. The answer
 * is to keep Java to marshalling and put every decision in TypeScript — then
 * test the TypeScript against a bridge that mimics the Java contract
 * EXACTLY, including its restrictions:
 *
 *   - `exec` runs ONE statement, like Android's execSQL. A script is
 *     refused, so if splitStatements ever stops splitting, this suite fails
 *     rather than a phone failing on first boot.
 *   - `begin` refuses a second begin, and commit/rollback refuse with none
 *     open — like the Java, which keeps one transaction per connection.
 *   - params and rows cross as JSON in three types only; a boolean is
 *     refused on both sides, because node:sqlite (the driver every other
 *     test in the repo runs against) refuses one too.
 *   - the fake's database is a real FILE, so `header()` returns real bytes —
 *     and because the fake is NOT encrypted, those bytes are the plaintext
 *     magic. That is the point: the plaintext detector is shown to FAIL on a
 *     plaintext file, so the same check in db/device-proof.sh and on the
 *     This-phone screen is not a check that always passes.
 *
 * WHAT IT DOES NOT PROVE: that SQLCipher encrypts. Nothing running under
 * Node can prove that. The factory below CLAIMS `encrypted` so that
 * openDeviceDatabase can be exercised at all, and that claim is a fiction
 * local to this file. The real proof is the first bytes of the file on a
 * phone — db/device-proof.sh, and the bytes rendered on Settings → This
 * phone.
 * ---------------------------------------------------------------------------
 */
import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

import {
  openDeviceDatabase,
  openEphemeralDatabase,
  UnencryptedDeviceDatabaseError,
  LOCAL_SCHEMA_VERSION,
  LOCAL_MIGRATIONS,
  Outbox,
  migrateLocal,
  metaGet,
} from '@papa/core'
import {
  CAPACITOR_SQLCIPHER,
  CapacitorKeyProvider,
  CapacitorSqlcipherDriver,
  DeviceSqlError,
  PLAINTEXT_MAGIC_HEX,
  UnsentEvidenceError,
  capacitorSqlcipherFactory,
  encodeParams,
  papaSqlBridge,
  splitStatements,
  unsentEvidence,
} from '../src/db/capacitor-driver.ts'
import { thermalPrintSaid } from '../src/print/print-said.ts'
import { bytesToBase64 } from '../src/print/bt-printer.ts'

const scratch = mkdtempSync(join(tmpdir(), 'papa-device-'))
after(() => { try { rmSync(scratch, { recursive: true, force: true }) } catch { /* the OS will */ } })

let nth = 0

/**
 * A `window.PapaSql` of the same shape, over node:sqlite on a real file.
 *
 * Every restriction the Java has is reproduced. Where the Java would throw,
 * this returns the same error shape, because the driver's job is to turn
 * those shapes into exceptions and the test has to see it do that.
 */
function fakeBridge() {
  const path = join(scratch, `papa-${++nth}.db`)
  let sqlite = null
  let key = null
  let inTransaction = false

  const oneStatementOnly = (sql) => {
    // Android's execSQL runs a single statement. Detected with a
    // deliberately DUMB rule rather than by calling splitStatements — using
    // the code under test to police the code under test would hide exactly
    // the bug this is here to catch. (The rule would false-positive on a
    // semicolon inside a string literal; the app's SQL has none.)
    return sql.replace(/;\s*$/, '').includes(';')
  }

  const args = (paramsJson) => {
    const list = paramsJson ? JSON.parse(paramsJson) : []
    return list.map((v, i) => {
      if (v === null) return null
      if (typeof v === 'string' || typeof v === 'number') return v
      throw new Error(`Parameter ${i + 1} is a ${typeof v}; the driver takes string, number or null only.`)
    })
  }

  return {
    /** Not part of the bridge — the test's own window on the file. */
    _path: path,
    _isOpen: () => sqlite !== null,

    key() {
      if (key === null) key = randomBytes(32).toString('base64')
      return JSON.stringify({ key })
    },

    wipe() {
      key = null
      if (sqlite) { sqlite.close(); sqlite = null }
      try { if (existsSync(path)) rmSync(path) } catch (e) { return String(e) }
      return ''
    },

    open(keyB64) {
      if (!keyB64) return 'Refusing to open the device database with an empty key.'
      if (key === null) return 'There is no device key yet.'
      if (keyB64 !== key) return "That is not this phone's database key."
      if (sqlite) return ''
      sqlite = new DatabaseSync(path)
      sqlite.exec('pragma foreign_keys = on')
      return ''
    },

    exec(sql, paramsJson) {
      try {
        if (!sqlite) throw new Error('The device database is not open.')
        if (oneStatementOnly(sql)) throw new Error('execSQL runs ONE statement; this is a script.')
        const bound = args(paramsJson)
        if (bound.length === 0) sqlite.exec(sql)
        else sqlite.prepare(sql).run(...bound)
        return ''
      } catch (e) {
        return `Statement failed: ${e.message}`
      }
    },

    all(sql, paramsJson) {
      try {
        if (!sqlite) throw new Error('The device database is not open.')
        const rows = sqlite.prepare(sql).all(...args(paramsJson))
        // The Java maps INTEGER to a long and keeps NULL columns present
        // (JSONObject.NULL, never a dropped key). node:sqlite may hand back
        // BigInt, which JSON.stringify refuses — so it is narrowed here the
        // way the Java narrows a Cursor.
        return JSON.stringify(rows.map((row) => {
          const out = {}
          for (const [k, v] of Object.entries(row)) {
            out[k] = typeof v === 'bigint' ? Number(v) : v === undefined ? null : v
          }
          return out
        }))
      } catch (e) {
        return JSON.stringify({ error: `Query failed: ${e.message}` })
      }
    },

    begin() {
      if (!sqlite) return 'The device database is not open.'
      if (inTransaction) return 'A transaction is already open on this connection.'
      sqlite.exec('begin')
      inTransaction = true
      return ''
    },

    commit() {
      if (!inTransaction) return 'No transaction is open.'
      sqlite.exec('commit')
      inTransaction = false
      return ''
    },

    rollback() {
      if (!inTransaction) return 'No transaction is open.'
      sqlite.exec('rollback')
      inTransaction = false
      return ''
    },

    header() {
      if (!existsSync(path)) return ''
      const bytes = readFileSync(path).subarray(0, 16)
      return Buffer.from(bytes).toString('hex')
    },
  }
}

/**
 * A DeviceDriverFactory over the fake.
 *
 * `protection` is a parameter because the refusals are half of what is being
 * tested. 'encrypted' over an unencrypted fake is a fiction, stated at the
 * top of this file: nothing under Node can encrypt a file with SQLCipher.
 */
function factoryOver(bridge, protection = 'encrypted') {
  const real = capacitorSqlcipherFactory(bridge)
  return { ...real, protection, name: protection === 'encrypted' ? CAPACITOR_SQLCIPHER : `fake-${protection}` }
}

/** Open the way the app does: key provider, then openDeviceDatabase. */
async function openFake(bridge, unsent = () => 0) {
  const keys = new CapacitorKeyProvider(bridge, unsent)
  const db = await openDeviceDatabase(factoryOver(bridge), keys)
  return { db, keys }
}

// ---------------------------------------------------------------------------

describe('splitting a script into statements', () => {
  test('splits on semicolons and drops the empties', () => {
    assert.deepEqual(splitStatements('select 1; select 2;;'), ['select 1', 'select 2'])
  })

  test('ignores the line comments the local schema is full of', () => {
    const script = `
      -- a table; with a semicolon in the comment
      create table t (a text);
      -- another; one
      create index i on t (a);
    `
    assert.deepEqual(splitStatements(script), ['create table t (a text)', 'create index i on t (a)'])
  })

  test('ignores block comments', () => {
    assert.deepEqual(splitStatements('/* one; two */ select 1;'), ['select 1'])
  })

  test('does not cut inside a string literal', () => {
    const out = splitStatements(`insert into t values ('a;b'); select 1;`)
    assert.deepEqual(out, [`insert into t values ('a;b')`, 'select 1'])
  })

  test("keeps SQLite's doubled-quote escape intact", () => {
    const out = splitStatements(`select 'it''s; fine' as a;`)
    assert.deepEqual(out, [`select 'it''s; fine' as a`])
  })

  test('a statement with no trailing semicolon is still one statement', () => {
    assert.deepEqual(splitStatements('  pragma foreign_keys = on  '), ['pragma foreign_keys = on'])
  })

  test('nothing in, nothing out', () => {
    assert.deepEqual(splitStatements('   \n -- just a comment \n '), [])
  })
})

describe('parameters crossing as JSON', () => {
  test('the three types cross', () => {
    assert.equal(encodeParams(['a', 1, null]), '["a",1,null]')
  })

  // JSON.stringify([NaN]) is '[null]'. A NaN timestamp would land as NULL
  // with nothing raised anywhere, which is the failure shape this codebase
  // treats as the worst kind — wrong data, found weeks later.
  test('NaN is refused rather than silently becoming null', () => {
    assert.throws(() => encodeParams([Number.NaN]), DeviceSqlError)
    assert.throws(() => encodeParams([Number.POSITIVE_INFINITY]), DeviceSqlError)
  })

  test('a boolean is refused, exactly as node:sqlite refuses one', () => {
    assert.throws(() => encodeParams([true]), DeviceSqlError)
    assert.throws(() => encodeParams([undefined]), DeviceSqlError)
    assert.throws(() => encodeParams([{}]), DeviceSqlError)
  })
})

describe('the refusals that are the point of the wave', () => {
  test('a factory that names itself plaintext is refused', async () => {
    const bridge = fakeBridge()
    const keys = new CapacitorKeyProvider(bridge, () => 0)
    await assert.rejects(
      () => openDeviceDatabase(factoryOver(bridge, 'plaintext'), keys),
      UnencryptedDeviceDatabaseError,
    )
    assert.equal(bridge._isOpen(), false, 'nothing was opened')
  })

  test('an ephemeral driver cannot be used as a device database', async () => {
    const bridge = fakeBridge()
    await assert.rejects(
      () => openDeviceDatabase(factoryOver(bridge, 'ephemeral'), new CapacitorKeyProvider(bridge, () => 0)),
      UnencryptedDeviceDatabaseError,
    )
  })

  test('an empty key is refused before the bridge is asked to open anything', async () => {
    const bridge = fakeBridge()
    await assert.rejects(
      () => openDeviceDatabase(factoryOver(bridge), { getKey: async () => '', wipe: async () => {} }),
      UnencryptedDeviceDatabaseError,
    )
    assert.equal(bridge._isOpen(), false)
  })

  // Belt and braces: openEphemeralDatabase passes '' as the key, so the
  // factory's own guard has to hold even when the contract's does not apply.
  test('the factory itself refuses an empty key, not just openDeviceDatabase', () => {
    const bridge = fakeBridge()
    assert.throws(() => openEphemeralDatabase(factoryOver(bridge, 'ephemeral')), DeviceSqlError)
  })

  test('the bridge refuses a key that is not the one it holds', () => {
    const bridge = fakeBridge()
    JSON.parse(bridge.key())
    assert.match(bridge.open('not-the-key'), /not this phone's database key/)
  })

  test('a partial bridge is a build mismatch, not a browser', () => {
    const host = globalThis
    assert.equal(papaSqlBridge(), null, 'no bridge at all is the browser')
    host.PapaSql = { open() { return '' } }
    try {
      assert.throws(() => papaSqlBridge(), DeviceSqlError)
    } finally {
      delete host.PapaSql
    }
  })
})

describe('the key provider', () => {
  test('the key is created once and then stable', async () => {
    const bridge = fakeBridge()
    const keys = new CapacitorKeyProvider(bridge, () => 0)
    const first = await keys.getKey()
    assert.equal(first.length, 44, '32 bytes, base64')
    assert.equal(await keys.getKey(), first, 'read-or-create, not create-every-time')
  })

  test('a bridge that answers with an error raises it', async () => {
    const keys = new CapacitorKeyProvider({ key: () => JSON.stringify({ error: 'keystore is sulking' }) })
    await assert.rejects(() => keys.getKey(), /keystore is sulking/)
  })

  test('a bridge that answers with rubbish raises it rather than guessing', async () => {
    const keys = new CapacitorKeyProvider({ key: () => 'not json' })
    await assert.rejects(() => keys.getKey(), DeviceSqlError)
  })
})

describe('the wipe, which is the one unrecoverable act', () => {
  test('refuses while anything is unsent, and says how much', async () => {
    const bridge = fakeBridge()
    const { db, keys } = await openFake(bridge, () => 2)
    migrateLocal(db)
    await assert.rejects(() => keys.wipe(), UnsentEvidenceError)
    await assert.rejects(() => keys.wipe(), /2 pieces of evidence/)
    assert.equal(bridge._isOpen(), true, 'the refusal did not close anything')
  })

  test('refuses when it cannot count: "cannot count" is not "nothing to lose"', async () => {
    const bridge = fakeBridge()
    const { keys } = await openFake(bridge, () => null)
    await assert.rejects(() => keys.wipe(), UnsentEvidenceError)
    await assert.rejects(() => keys.wipe(), /has not been opened/)
  })

  test('goes through with nothing unsent, and takes the file with it', async () => {
    const bridge = fakeBridge()
    const { db, keys } = await openFake(bridge)
    migrateLocal(db)
    assert.equal(existsSync(bridge._path), true)
    await keys.wipe()
    assert.equal(existsSync(bridge._path), false, 'the file is gone')
    assert.notEqual(JSON.parse(bridge.key()).key, undefined, 'a NEW key is minted next time')
  })

  test('force is the deliberate act that gets past the guard', async () => {
    const bridge = fakeBridge()
    const { db, keys } = await openFake(bridge, () => 7)
    migrateLocal(db)
    await keys.wipe(true)
    assert.equal(existsSync(bridge._path), false)
  })

  test('the evidence count is the outbox plus what has not uploaded', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    migrateLocal(db)
    assert.equal(unsentEvidence(db), 0)
    new Outbox(db, () => 1000).enqueue({ id: 'op-1', op: 'submit_scan_batch', payload: { a: 1 } })
    assert.equal(unsentEvidence(db), 1)
    db.exec(
      `insert into condition_photos (id, asset_id, side, captured_at, local_uri, uploaded)
       values ('ph-1', 'a1', 'out', 1, 'file://x', 0)`,
    )
    db.exec(
      `insert into voice_notes (id, asset_id, captured_at, local_uri, uploaded)
       values ('vn-1', 'a1', 1, 'file://y', 0)`,
    )
    assert.equal(unsentEvidence(db), 3, 'the outbox row, the photo and the note')
    db.exec(`update condition_photos set uploaded = 1`)
    assert.equal(unsentEvidence(db), 2, 'an uploaded photo exists somewhere else')
  })

  test('a database with no tables yet has nothing to lose', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    assert.equal(unsentEvidence(db), 0, 'before migrateLocal, genuinely nothing')
  })

  // The difference that decides whether a wipe is allowed. "The table is not
  // there" is nothing to lose; "the query failed" is a question that could
  // not be answered, and answering "nothing" to it would be the automatic
  // response to a transient condition that device-key.ts forbids.
  test('a query that fails for any other reason answers null, not zero', () => {
    const angry = new CapacitorSqlcipherDriver({
      all: () => JSON.stringify({ error: 'database is locked' }),
    })
    assert.equal(unsentEvidence(angry), null)
  })

  test('and null refuses the wipe', async () => {
    const bridge = fakeBridge()
    const keys = new CapacitorKeyProvider(bridge, () => unsentEvidence(
      new CapacitorSqlcipherDriver({ all: () => JSON.stringify({ error: 'database is locked' }) }),
    ))
    await assert.rejects(() => keys.wipe(), UnsentEvidenceError)
  })
})

describe('rows and values crossing the bridge', () => {
  test('strings, numbers and nulls come back as themselves', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    db.exec(`create table t (a text, b integer, c real, d text)`)
    db.exec(`insert into t (a, b, c, d) values (?, ?, ?, ?)`, ['hello', 42, 1.5, null])
    assert.deepEqual(db.all(`select * from t`), [{ a: 'hello', b: 42, c: 1.5, d: null }])
  })

  // A null column must be PRESENT and null, not absent. Java's JSONObject
  // drops a key whose value is a Java null, which would make the column read
  // as undefined in JavaScript — `row.d ?? 'x'` behaves the same, but
  // `'d' in row` and Object.entries do not, and the read models use both.
  test('a null column is present, not missing', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    db.exec(`create table t (a text, b text)`)
    db.exec(`insert into t (a) values ('x')`)
    const row = db.get(`select * from t`)
    assert.equal('b' in row, true)
    assert.equal(row.b, null)
  })

  test('a typed parameter binds as its type, not as text', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    db.exec(`create table t (n integer)`)
    db.exec(`insert into t (n) values (5)`)
    // The failure this guards: binding numbers as strings (what a
    // String[]-only query API would force) makes `= ?` with 5 match nothing.
    assert.deepEqual(db.all(`select n from t where n = ?`, [5]), [{ n: 5 }])
  })

  test('get returns undefined for no rows, like every other driver', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    db.exec(`create table t (a text)`)
    assert.equal(db.get(`select * from t`), undefined)
  })

  test('a script reaches a one-statement-at-a-time bridge intact', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    // The fake REFUSES a script, so this passing means the splitting
    // happened in TypeScript — which is the whole reason it lives there.
    db.exec(`
      -- two tables; one call
      create table a (x text);
      create table b (y text);
    `)
    assert.deepEqual(
      db.all(`select name from sqlite_master where type = 'table' order by name`),
      [{ name: 'a' }, { name: 'b' }],
    )
  })

  test('a failed statement raises, naming the SQL', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    assert.throws(() => db.exec(`insert into nope values (1)`), (e) => {
      assert.ok(e instanceof DeviceSqlError)
      assert.match(e.message, /nope/)
      return true
    })
  })

  test('a failed query raises rather than reading as no rows', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    // The dangerous alternative: {"error":…} parsed as an empty result, so
    // a broken query reads as "this asset has no history".
    assert.throws(() => db.all(`select * from nope`), DeviceSqlError)
  })

  test('an answer that is not JSON at all raises', () => {
    const db = new CapacitorSqlcipherDriver({ all: () => '<html>a proxy ate it</html>' })
    assert.throws(() => db.all(`select 1`), /not JSON/)
  })
})

describe('transactions, where the outbox lives or dies', () => {
  test('a commit keeps both writes', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    migrateLocal(db)
    const outbox = new Outbox(db, () => 1000)
    db.transaction(() => {
      db.exec(`insert into assets (id, org_id, presence) values ('a1', 'o1', 'out')`)
      outbox.enqueue({ id: 'op-1', op: 'submit_scan_batch', payload: { asset_id: 'a1' } })
    })
    assert.equal(db.get(`select count(*) as n from assets`).n, 1)
    assert.equal(db.get(`select count(*) as n from outbox`).n, 1)
  })

  // The failure the transaction exists to prevent: an optimistic row written
  // without its queue row, so the tech believes the gear is accounted for
  // and it is not. Outbox.enqueue opens a transaction of its OWN, so this
  // also proves nesting joins rather than committing the outer one early.
  test('a throw after a nested enqueue rolls BOTH back', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    migrateLocal(db)
    const outbox = new Outbox(db, () => 1000)
    assert.throws(() => {
      db.transaction(() => {
        db.exec(`insert into assets (id, org_id, presence) values ('a1', 'o1', 'out')`)
        outbox.enqueue({ id: 'op-1', op: 'submit_scan_batch', payload: { asset_id: 'a1' } })
        throw new Error('the scan handler blew up')
      })
    }, /blew up/)
    assert.equal(db.get(`select count(*) as n from assets`).n, 0)
    assert.equal(db.get(`select count(*) as n from outbox`).n, 0, 'no orphan queue row')
  })

  test('a nested transaction commits with the outer one, not before it', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    db.exec(`create table t (a text)`)
    assert.throws(() => {
      db.transaction(() => {
        db.transaction(() => { db.exec(`insert into t values ('inner')`) })
        throw new Error('outer fails after the inner "committed"')
      })
    })
    assert.deepEqual(db.all(`select * from t`), [], 'the inner commit was never real')
  })

  test('the original error survives, and the driver is usable afterwards', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    db.exec(`create table t (a text)`)
    assert.throws(() => db.transaction(() => { throw new Error('mine') }), /mine/)
    db.exec(`insert into t values ('after')`)
    assert.deepEqual(db.all(`select * from t`), [{ a: 'after' }], 'no transaction was left open')
  })

  test('deep nesting unwinds to depth zero', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    db.exec(`create table t (a text)`)
    db.transaction(() => db.transaction(() => db.transaction(() => {
      db.exec(`insert into t values ('deep')`)
    })))
    assert.deepEqual(db.all(`select * from t`), [{ a: 'deep' }])
  })
})

describe('the migration ladder over the bridge', () => {
  /**
   * A phone at version 1 — the pre-0018 shape, reduced to the tables the
   * steps actually ALTER plus the two that must survive.
   *
   * Column-for-column coverage of the ladder is packages/core's
   * migrate.test.mjs, which welds history to present against node:sqlite.
   * What is under test HERE is the bridge: that the ladder's scripts, its
   * `pragma table_info` reads and its per-step transactions all work through
   * a one-statement-at-a-time String interface.
   */
  const v1 = `
    create table if not exists assets (
      id text primary key, org_id text not null, product_id text, asset_code text,
      serial_number text, display_name text, is_container integer default 0,
      presence text default 'here', health text default 'ok', ownership text default 'owned',
      current_location_id text, current_parent_id text, current_job_id text,
      last_scanned_at text, notes text, updated_at text
    );
    create table if not exists jobs (id text primary key, org_id text, label text, status text);
    create table if not exists products (id text primary key, org_id text, display_name text);
    create table if not exists asset_containment (
      parent_asset_id text not null, child_asset_id text not null, kind text not null,
      primary key (parent_asset_id, child_asset_id)
    );
    create table if not exists outbox (
      id text primary key, seq integer not null, op text not null, payload text not null,
      depends_on text, state text not null default 'pending', attempts integer not null default 0,
      next_retry_at integer, error_code text, error_detail text, created_at integer not null
    );
    create table if not exists sync_meta (key text primary key, value text);
  `

  test('a v1 phone is brought to the current version, step by step', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    db.exec(v1)
    db.exec(
      `insert into outbox (id, seq, op, payload, created_at)
       values ('o40', 40, 'submit_scan_batch', '{"asset_id":"a1"}', 1),
              ('o41', 41, 'submit_scan_batch', '{"asset_id":"a2"}', 2)`,
    )
    db.exec(`insert into sync_meta (key, value) values ('outbox_seq', '41')`)

    const report = migrateLocal(db)

    assert.equal(report.from, 1, 'tables but no stamp means version 1')
    assert.equal(report.to, LOCAL_SCHEMA_VERSION)
    assert.deepEqual(report.applied, LOCAL_MIGRATIONS.map((m) => m.version))
    assert.equal(metaGet(db, 'schema_version'), String(LOCAL_SCHEMA_VERSION))

    // The whole reason the ladder exists: the queue survives it.
    assert.deepEqual(
      db.all(`select id, seq from outbox order by seq`),
      [{ id: 'o40', seq: 40 }, { id: 'o41', seq: 41 }],
    )
    assert.equal(metaGet(db, 'outbox_seq'), '41', 'the never-resetting counter did not reset')

    // A table from the far end of the ladder, reached through the bridge.
    assert.equal(db.get(`select count(*) as n from org`).n, 0)
  })

  test('a fresh install gets the schema in one go and no step runs', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    const report = migrateLocal(db)
    assert.deepEqual(report, { from: 0, to: LOCAL_SCHEMA_VERSION, applied: [] })
  })

  test('running it again changes nothing', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    migrateLocal(db)
    const again = migrateLocal(db)
    assert.deepEqual(again, { from: LOCAL_SCHEMA_VERSION, to: LOCAL_SCHEMA_VERSION, applied: [] })
  })
})

describe('the plaintext detector can fail', () => {
  /**
   * This is the test that keeps the proof honest.
   *
   * The fake bridge's file is an ORDINARY SQLite file, so its first sixteen
   * bytes ARE the plaintext magic. If this passes, the same comparison in
   * db/device-proof.sh and on the This-phone screen is one that can tell the
   * difference — rather than a check that would have said "encrypted" about
   * a plaintext file all along.
   */
  test('an unencrypted file is recognised as one', async () => {
    const bridge = fakeBridge()
    const { db } = await openFake(bridge)
    migrateLocal(db)
    assert.equal(db.header(), PLAINTEXT_MAGIC_HEX)
    assert.equal(
      Buffer.from(PLAINTEXT_MAGIC_HEX, 'hex').toString('latin1'),
      // The NUL as an ESCAPE, not as a raw byte in this file: one NUL
      // makes the whole file binary to grep and ripgrep, and "grep for
      // the rule" is how docs/principles.md #4 is checked.
      'SQLite format 3\u0000',
      'the magic is what the file actually says',
    )
  })

  test('before anything is written there is no file and that is not a failure', () => {
    const bridge = fakeBridge()
    assert.equal(bridge.header(), '')
  })
})

describe('what the printer said', () => {
  test('every refusal the transport can speak becomes a sentence', () => {
    for (const reason of [
      'no_printer', 'no_printer_chosen', 'bluetooth_off', 'permission_denied', 'no_bluetooth',
    ]) {
      const said = thermalPrintSaid({ ok: false, reason })
      assert.ok(said.length > 10, `${reason} has no sentence`)
      assert.ok(!said.includes(reason), `${reason} leaked its machine word into the sentence`)
    }
  })

  test('an unknown reason is shown rather than swallowed', () => {
    assert.match(thermalPrintSaid({ ok: false, reason: 'read failed' }), /read failed/)
  })

  test('a success says so, and the dev download says which it was', () => {
    assert.notEqual(thermalPrintSaid({ ok: true }), thermalPrintSaid({ ok: true, reason: 'dev_download' }))
  })
})

describe('bytes to base64 for the printer', () => {
  test('round-trips', () => {
    const bytes = Uint8Array.from([0x1b, 0x40, 0x00, 0xff, 0x0a])
    assert.deepEqual(Buffer.from(bytesToBase64(bytes), 'base64'), Buffer.from(bytes))
  })

  test('a parchi-sized payload does not blow the stack', () => {
    const big = randomBytes(64 * 1024)
    assert.deepEqual(Buffer.from(bytesToBase64(new Uint8Array(big)), 'base64'), big)
  })
})
