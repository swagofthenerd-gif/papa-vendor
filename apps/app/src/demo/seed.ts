import type { SqlDriver } from '@papa/core'

/**
 * A demo rental house, so the app can be used before there is any login,
 * server, or catalogue import.
 *
 * DETERMINISTIC ON PURPOSE. The demo database lives in memory and is gone on
 * refresh, so tag codes are generated from a fixed seed rather than at random:
 * a QR printed or displayed once keeps working across refreshes and across
 * machines. Random codes would make every reload invalidate every label the
 * user had already put on something, which is exactly the failure the real
 * product spends a migration avoiding.
 *
 * The gear is a plausible Lahore house — the products that actually show up in
 * a TVC or wedding kit list here — because the kit-list reader matches against
 * these names, and testing it against invented gear proves nothing.
 */

const ORG = 'demo-org'

/** Fixed-seed generator. Same sequence every run, in every browser. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    // xorshift32. Not for anything that must be unguessable — the real tag
    // codes come from the database's CSPRNG (generate_tag_code, 0002) and a
    // guessable code there would let a competitor enumerate a fleet.
    s ^= s << 13; s >>>= 0
    s ^= s >>> 17
    s ^= s << 5; s >>>= 0
    return s / 0x100000000
  }
}

const TAG_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Same shape as the server's: a `v1` prefix then opaque characters. */
function tagCode(rng: () => number): string {
  let out = 'v1'
  for (let i = 0; i < 22; i++) out += TAG_ALPHABET[Math.floor(rng() * TAG_ALPHABET.length)]
  return out
}

interface ProductSpec {
  key: string
  name: string
  category: string
  /** How many units, and which shelf they live on. */
  units: number
  shelf: string
  /** Prefix for the human-readable asset code stuck on the case. */
  code: string
}

const LOCATIONS: { id: string; name: string; path: string; kind: string }[] = [
  { id: 'loc-rack-a', name: 'Rack A', path: 'Warehouse / Rack A', kind: 'shelf' },
  { id: 'loc-rack-b', name: 'Rack B', path: 'Warehouse / Rack B', kind: 'shelf' },
  { id: 'loc-rack-c', name: 'Rack C', path: 'Warehouse / Rack C', kind: 'shelf' },
  { id: 'loc-cage', name: 'Battery Cage', path: 'Warehouse / Battery Cage', kind: 'shelf' },
  { id: 'loc-grip', name: 'Grip Bay', path: 'Warehouse / Grip Bay', kind: 'shelf' },
  { id: 'loc-van', name: 'Van 1', path: 'Van 1', kind: 'vehicle' },
]

/**
 * C300 and C500 both present deliberately. They differ by one character, and
 * the kit-list reader must refuse to guess between them (kit-list.ts) — that
 * refusal is only observable if both are actually in the catalogue.
 */
const PRODUCTS: ProductSpec[] = [
  { key: 'fx9', name: 'Sony FX9', category: 'camera', units: 2, shelf: 'loc-rack-a', code: 'FX9' },
  { key: 'fx6', name: 'Sony FX6', category: 'camera', units: 3, shelf: 'loc-rack-a', code: 'FX6' },
  { key: 'c300', name: 'Canon C300 Mark III', category: 'camera', units: 2, shelf: 'loc-rack-a', code: 'C300' },
  { key: 'c500', name: 'Canon C500 Mark II', category: 'camera', units: 1, shelf: 'loc-rack-a', code: 'C500' },
  { key: 'komodo', name: 'RED Komodo 6K', category: 'camera', units: 1, shelf: 'loc-rack-a', code: 'KMD' },
  { key: 'sigma1835', name: 'Sigma 18-35mm f1.8', category: 'lens', units: 3, shelf: 'loc-rack-b', code: 'SG1835' },
  { key: 'sigma50100', name: 'Sigma 50-100mm f1.8', category: 'lens', units: 2, shelf: 'loc-rack-b', code: 'SG50100' },
  { key: 'cne', name: 'Canon CN-E Prime Set', category: 'lens', units: 1, shelf: 'loc-rack-b', code: 'CNE' },
  { key: 'samyang', name: 'Samyang Xeen Prime Set', category: 'lens', units: 1, shelf: 'loc-rack-b', code: 'XEEN' },
  { key: 'ronin', name: 'DJI Ronin RS3 Pro', category: 'support', units: 2, shelf: 'loc-rack-c', code: 'RS3' },
  { key: 'sachtler', name: 'Sachtler Flowtech 75', category: 'support', units: 2, shelf: 'loc-rack-c', code: 'SACH' },
  { key: 'sachdeva', name: 'Sachdeva Tripod', category: 'support', units: 3, shelf: 'loc-rack-c', code: 'SDV' },
  { key: 'smallhd', name: 'SmallHD 702 Monitor', category: 'monitor', units: 2, shelf: 'loc-rack-c', code: 'SHD' },
  { key: 'aputure600', name: 'Aputure 600D Pro', category: 'light', units: 4, shelf: 'loc-grip', code: 'AP600' },
  { key: 'aputure300', name: 'Aputure 300X', category: 'light', units: 2, shelf: 'loc-grip', code: 'AP300' },
  { key: 'forza', name: 'Nanlite Forza 500', category: 'light', units: 2, shelf: 'loc-grip', code: 'FRZ' },
  { key: 'cstand', name: 'C-Stand', category: 'grip', units: 8, shelf: 'loc-grip', code: 'CST' },
  { key: 'mixpre', name: 'Sound Devices MixPre-6', category: 'sound', units: 2, shelf: 'loc-rack-c', code: 'MXP' },
  { key: 'mkh416', name: 'Sennheiser MKH 416', category: 'sound', units: 2, shelf: 'loc-rack-c', code: 'MKH' },
  { key: 'vmount', name: 'V-Mount Battery 190Wh', category: 'power', units: 12, shelf: 'loc-cage', code: 'VM' },
  { key: 'xlr', name: 'XLR Cable 5m', category: 'cable', units: 20, shelf: 'loc-cage', code: 'XLR' },
]

interface JobSpec {
  id: string
  label: string
  contact: string
  departsAt: string
  expectedBack: string
  /** Product keys and how many of each the job expects. */
  wants: [string, number][]
}

const JOBS: JobSpec[] = [
  {
    id: 'job-shan',
    label: 'Shan Foods TVC — Ghazi Studios',
    contact: 'Bilal (prod) 0300 4412233',
    departsAt: '06:30',
    expectedBack: 'Thu 21 Aug',
    wants: [['fx9', 1], ['sigma1835', 2], ['aputure600', 2], ['vmount', 4], ['sachtler', 1], ['smallhd', 1]],
  },
  {
    id: 'job-wedding',
    label: 'Wedding — DHA Phase 5',
    contact: 'Hamza 0321 8899001',
    departsAt: '14:00',
    expectedBack: 'Sun 24 Aug',
    wants: [['fx6', 2], ['sigma50100', 1], ['ronin', 1], ['vmount', 4], ['sachdeva', 2], ['aputure300', 1]],
  },
  {
    id: 'job-doc',
    label: 'Documentary — Walled City',
    contact: 'Ayesha 0333 1122334',
    departsAt: '09:15',
    expectedBack: 'Fri 22 Aug',
    wants: [['c300', 1], ['cne', 1], ['mixpre', 1], ['mkh416', 1], ['vmount', 3], ['xlr', 4]],
  },
]

export interface DemoTag {
  tagCode: string
  assetId: string
  assetCode: string
  displayName: string
  shelf: string
}

export interface DemoSeed {
  orgId: string
  userName: string
  tags: DemoTag[]
  jobs: { id: string; label: string; contact: string; departsAt: string; expected: string[] }[]
}

/**
 * Write the demo house into a fresh local database.
 *
 * Uses the real on-device schema (LOCAL_SCHEMA) and the real tables, so the
 * scan engine, the pull list and the kit-list reader all run against exactly
 * what they will run against on a phone. Nothing here is a mock of the engine
 * — only of the server that would normally have filled these tables by sync.
 */
export function seedDemo(db: SqlDriver): DemoSeed {
  const rng = makeRng(0x5A17A11)
  const tags: DemoTag[] = []

  db.transaction(() => {
    for (const l of LOCATIONS) {
      db.exec(
        `insert into locations (id, org_id, name, kind, path, code) values (?, ?, ?, ?, ?, ?)`,
        [l.id, ORG, l.name, l.kind, l.path, l.name],
      )
    }

    const assetsByProduct = new Map<string, string[]>()

    for (const p of PRODUCTS) {
      const productId = `prod-${p.key}`
      db.exec(
        `insert into products (id, org_id, display_name, category) values (?, ?, ?, ?)`,
        [productId, ORG, p.name, p.category],
      )

      const ids: string[] = []
      for (let i = 1; i <= p.units; i++) {
        const assetId = `asset-${p.key}-${i}`
        const assetCode = `${p.code}-${String(i).padStart(2, '0')}`
        const shelf = LOCATIONS.find((l) => l.id === p.shelf)

        db.exec(
          `insert into assets
             (id, org_id, product_id, asset_code, display_name, presence, health,
              ownership, current_location_id, current_job_id, updated_at)
           values (?, ?, ?, ?, ?, 'here', 'ok', 'owned', ?, null, ?)`,
          [assetId, ORG, productId, assetCode, p.name, p.shelf, new Date().toISOString()],
        )

        const code = tagCode(rng)
        db.exec(
          `insert into asset_tags (tag_code, asset_id, status) values (?, ?, 'active')`,
          [code, assetId],
        )

        tags.push({
          tagCode: code,
          assetId,
          assetCode,
          displayName: p.name,
          shelf: shelf?.name ?? '—',
        })
        ids.push(assetId)
      }
      assetsByProduct.set(p.key, ids)
    }

    for (const j of JOBS) {
      db.exec(
        `insert into jobs (id, org_id, label, contact, expected_back, status)
         values (?, ?, ?, ?, ?, 'open')`,
        [j.id, ORG, j.label, j.contact, j.expectedBack],
      )
    }

    // One camera already out, so the double-checkout warning is reachable
    // without having to set it up by hand. Scanning FX6-03 against any job
    // now warns from local data alone — the check CONTRIBUTING principle 4
    // exists for, and the one thing a demo would otherwise never show.
    db.exec(
      `update assets set presence = 'out', current_job_id = ? where id = ?`,
      ['job-doc', 'asset-fx6-3'],
    )

    // One light in for repair, so 'available' is not trivially everything.
    db.exec(`update assets set health = 'faulty' where id = ?`, ['asset-aputure600-4'])
  })

  const expectedFor = (j: JobSpec): string[] => {
    const out: string[] = []
    for (const [key, n] of j.wants) {
      const spec = PRODUCTS.find((p) => p.key === key)
      if (!spec) continue
      for (let i = 1; i <= Math.min(n, spec.units); i++) out.push(`asset-${key}-${i}`)
    }
    return out
  }

  return {
    orgId: ORG,
    userName: 'Usman (prep)',
    tags,
    jobs: JOBS.map((j) => ({
      id: j.id,
      label: j.label,
      contact: j.contact,
      departsAt: j.departsAt,
      expected: expectedFor(j),
    })),
  }
}

/** The catalogue the kit-list reader matches a pasted WhatsApp message against. */
export function demoCatalogue(): { id: string; name: string }[] {
  return PRODUCTS.map((p) => ({ id: `prod-${p.key}`, name: p.name }))
}
