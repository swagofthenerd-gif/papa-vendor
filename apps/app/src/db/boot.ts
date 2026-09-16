import type { SqlDriver, StorageProtection } from '@papa/core'
import { openDeviceDatabase } from '@papa/core'
import { SqlJsDriver } from '../demo/sqljs-driver.ts'
import {
  CAPACITOR_SQLCIPHER,
  CapacitorKeyProvider,
  CapacitorSqlcipherDriver,
  capacitorSqlcipherFactory,
  papaSqlBridge,
  unsentEvidence,
} from './capacitor-driver.ts'

/**
 * Where the app's database comes from — the ONE branch.
 *
 * Two hosts, two honest answers:
 *
 *   - THE ANDROID SHELL. The `window.PapaSql` bridge is present, so the
 *     database is SQLCipher on the filesystem, opened through
 *     `openDeviceDatabase` — which by signature cannot be reached without a
 *     key provider, and by its own guard refuses a factory that does not
 *     claim `encrypted` or a key that is empty. There is deliberately no
 *     other path to a file on a phone: not a flag, not a fallback, not a
 *     "just for now". packages/core/src/db/device-key.ts explains at length
 *     why the ordering is the risk, and this is the file that would have
 *     broken it.
 *
 *   - THE BROWSER (the demo, the desk console, the e2e suite). sql.js in
 *     memory. Nothing is at rest, so there is nothing at rest to protect —
 *     `ephemeral`, which is the word device-key.ts gives exactly this case.
 *     The screens say so out loud rather than wearing a lock they have not
 *     earned.
 *
 * THE MIGRATION LADDER IS NOT RUN HERE. `DemoStore.open` calls
 * `migrateLocal` for both hosts, and it stays the single call site — one
 * home per rule (docs/principles.md #4). A second call here would be
 * harmless (the ladder is idempotent by construction) and would still be a
 * second place to keep in step.
 */

export interface DeviceStorage {
  /** What the database this app is running on actually protects. */
  protection: StorageProtection
  /** The driver's own name, for the screen and the refusal message. */
  driver: string
}

const BROWSER: DeviceStorage = { protection: 'ephemeral', driver: 'sql.js' }
const DEVICE: DeviceStorage = { protection: 'encrypted', driver: CAPACITOR_SQLCIPHER }

let storage: DeviceStorage = BROWSER
let opened: SqlDriver | null = null
let keys: CapacitorKeyProvider | null = null

/**
 * What the screens ask so their wording is true on both hosts. Read at
 * render, not captured at boot, because the honest sentence differs and a
 * stale copy of it is the kind of lie this app avoids.
 */
export function deviceStorage(): DeviceStorage {
  return storage
}

/**
 * The key provider on the device, or null in a browser.
 *
 * Exposed so the wipe has a caller. Nothing in the app calls `wipe()`
 * automatically and nothing should: device-key.ts is explicit that a wipe
 * must never be an automatic response to a transient condition such as "the
 * session looks stale", because the outbox dies with the key.
 */
export function deviceKeys(): CapacitorKeyProvider | null {
  return keys
}

/**
 * The first bytes of the database file, as hex — or null off the device.
 *
 * This is the phone showing its own proof. A plaintext SQLite file opens
 * with the ASCII "SQLite format 3\0"; a SQLCipher file opens with its random
 * per-database salt, so these bytes differ on every install and match that
 * magic on none. Read on demand: before the first write there is no file and
 * the answer is an empty string, which is not a failure.
 */
export function deviceHeaderHex(): string | null {
  if (!(opened instanceof CapacitorSqlcipherDriver)) return null
  try {
    return opened.header()
  } catch {
    return null
  }
}

/**
 * Open the database this app should be using, and remember which it was.
 *
 * Returns an UNMIGRATED driver: the caller (DemoStore.open) runs the ladder.
 */
export async function openAppDatabase(): Promise<SqlDriver> {
  const bridge = papaSqlBridge()

  if (!bridge) {
    const db = await SqlJsDriver.open()
    storage = BROWSER
    opened = db
    keys = null
    return db
  }

  // The wipe guard needs to count what is still only on this phone, and it
  // can only do that through the database it is about to destroy — so the
  // provider is given a late-bound reader rather than a driver. Before the
  // open finishes it answers null, and null refuses a wipe: "cannot count"
  // is not "nothing to lose".
  let bound: SqlDriver | null = null
  const provider = new CapacitorKeyProvider(bridge, () => (bound ? unsentEvidence(bound) : null))
  const db = await openDeviceDatabase(capacitorSqlcipherFactory(bridge), provider)
  bound = db
  storage = DEVICE
  opened = db
  keys = provider
  return db
}
