import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  openDeviceDatabase,
  openEphemeralDatabase,
  UnencryptedDeviceDatabaseError,
} from '../src/db/device-key.ts'
import { NodeSqliteDriver } from '../src/db/node-driver.ts'

const keys = {
  getKey: async () => 'a-256-bit-key-from-the-keystore',
  wipe: async () => {},
}

function factory(protection, name = 'test') {
  return { protection, name, open: () => new NodeSqliteDriver(':memory:') }
}

describe('the device database contract', () => {
  test('an encrypted driver opens', async () => {
    const db = await openDeviceDatabase(factory('encrypted'), keys)
    assert.ok(db)
  })

  // The point of the whole file. Whoever builds the Capacitor driver will
  // reach for the short path first; this is what stops them shipping it.
  test('a plaintext driver is refused for device use', async () => {
    await assert.rejects(
      () => openDeviceDatabase(factory('plaintext', 'capacitor-sqlite'), keys),
      UnencryptedDeviceDatabaseError,
    )
  })

  test('the test driver cannot be used as a device database', async () => {
    await assert.rejects(
      () => openDeviceDatabase(factory('ephemeral', 'node:sqlite'), keys),
      UnencryptedDeviceDatabaseError,
    )
  })

  test('the refusal names the driver, so the error is actionable', async () => {
    await assert.rejects(
      () => openDeviceDatabase(factory('plaintext', 'capacitor-sqlite'), keys),
      (err) => err.message.includes('capacitor-sqlite'),
    )
  })

  // SQLCipher treats an empty key as "no encryption" and opens the database
  // in plaintext WITHOUT error. Everything downstream then works perfectly
  // while the data sits unprotected, which is why this is checked here rather
  // than trusted to the key provider.
  test('an empty key is refused rather than silently disabling encryption', async () => {
    await assert.rejects(
      () => openDeviceDatabase(factory('encrypted'), { ...keys, getKey: async () => '' }),
      UnencryptedDeviceDatabaseError,
    )
  })

  test('ephemeral databases open for tests and the console', () => {
    assert.ok(openEphemeralDatabase(factory('ephemeral')))
  })

  test('but ephemeral is not a way around the plaintext refusal', () => {
    assert.throws(
      () => openEphemeralDatabase(factory('plaintext')),
      UnencryptedDeviceDatabaseError,
    )
  })
})
