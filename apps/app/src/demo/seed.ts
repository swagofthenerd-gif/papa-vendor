import type { SqlDriver } from '@papa/core'
import { DEMO_SCHEMA } from './read-model.ts'

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
  /** Days from "today" the gear is expected back. See isoDaysFromNow. */
  backInDays: number
  /** Product keys and how many of each the job expects. */
  wants: [string, number][]
}

const JOBS: JobSpec[] = [
  {
    id: 'job-shan',
    label: 'Shan Foods TVC — Ghazi Studios',
    contact: 'Bilal (prod) 0300 4412233',
    departsAt: '06:30',
    backInDays: 0, // due today — the middle of the board's three states
    wants: [['fx9', 1], ['sigma1835', 2], ['aputure600', 2], ['vmount', 4], ['sachtler', 1], ['smallhd', 1]],
  },
  {
    id: 'job-wedding',
    label: 'Wedding — DHA Phase 5',
    contact: 'Hamza 0321 8899001',
    departsAt: '14:00',
    backInDays: 3, // upcoming
    wants: [['fx6', 2], ['sigma50100', 1], ['ronin', 1], ['vmount', 4], ['sachdeva', 2], ['aputure300', 1]],
  },
  {
    id: 'job-doc',
    label: 'Documentary — Walled City',
    contact: 'Ayesha 0333 1122334',
    departsAt: '09:15',
    // OVERDUE — and deliberately the job that also has the FX6 physically
    // out, so the coming-back board opens with a real red row, a nudge to
    // send, and an overdue counter that is not zero.
    backInDays: -2,
    wants: [['c300', 1], ['cne', 1], ['mixpre', 1], ['mkh416', 1], ['vmount', 3], ['xlr', 4]],
  },
]

/**
 * Due dates are RELATIVE to the day the demo opens, as real ISO dates.
 *
 * The tag codes above are fixed-seed because a printed label must survive a
 * refresh. Dates have the OPPOSITE requirement: a fixed calendar date rots —
 * within a week of writing it, every job would read overdue and the board
 * would only ever demonstrate one of its three states. So the now-reference
 * is `new Date()` at seed time (the same clock `dueStatus` reads at render,
 * and the same one the seed already uses for updated_at), and the offsets
 * are chosen so the board always shows one overdue, one due-today and one
 * upcoming job. Formatted as local YYYY-MM-DD — exactly what the server's
 * `date` column mirrors — so parseDueDate accepts it.
 */
function isoDaysFromNow(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() + days)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/**
 * Two stand-in condition photos, so the out/in comparison is visible before
 * anyone has a working camera in front of them.
 *
 * Drawn as SVG rather than shipped as a JPEG for two reasons: the seed module
 * is imported by the test suite under plain Node, where there is no canvas and
 * no image decoding, and a few hundred bytes of markup keeps the bundle honest
 * where a pair of real photographs would add half a megabyte.
 *
 * They are deliberately, visibly diagrams. A demo that ships fake PHOTOGRAPHS
 * of gear invites someone to mistake them for a real record.
 */
function conditionPlate(caption: string, mark: boolean): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480">
<rect width="640" height="480" fill="#2b2724"/>
<rect x="90" y="130" width="460" height="230" rx="18" fill="#3d3733" stroke="#5a524c" stroke-width="3"/>
<circle cx="250" cy="245" r="72" fill="#232020" stroke="#6b625b" stroke-width="6"/>
<circle cx="250" cy="245" r="42" fill="#15130f"/>
<rect x="360" y="190" width="150" height="110" rx="8" fill="#332e2a" stroke="#5a524c" stroke-width="2"/>
${mark ? '<path d="M372 205 L498 292" stroke="#e2725b" stroke-width="7" stroke-linecap="round"/>' : ''}
<text x="320" y="424" font-family="monospace" font-size="26" fill="#8a807a" text-anchor="middle">${caption}</text>
</svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

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
  jobs: {
    id: string
    label: string
    contact: string
    departsAt: string
    expectedBack: string
    expected: string[]
  }[]
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

  // The demo-only tables (job_expected, job_meta, scan_sessions) sit beside
  // the real schema, applied the same create-if-not-exists way.
  db.exec(DEMO_SCHEMA)

  const expectedFor = (j: JobSpec): string[] => {
    const out: string[] = []
    for (const [key, n] of j.wants) {
      const spec = PRODUCTS.find((p) => p.key === key)
      if (!spec) continue
      for (let i = 1; i <= Math.min(n, spec.units); i++) out.push(`asset-${key}-${i}`)
    }
    return out
  }

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
        [j.id, ORG, j.label, j.contact, isoDaysFromNow(j.backInDays)],
      )
      db.exec(
        `insert into job_meta (job_id, departs_at) values (?, ?)`,
        [j.id, j.departsAt],
      )
      // The promised set lives in the database, not on the seed object, so a
      // job created at the desk later behaves exactly like these three.
      for (const assetId of expectedFor(j)) {
        db.exec(
          `insert into job_expected (job_id, asset_id) values (?, ?)`,
          [j.id, assetId],
        )
      }
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

    // A packed camera case: the A-cam kit as it actually travels. One
    // PERMANENT child (the handle cannot leave without the body) and four
    // PACKED ones, so scanning the case opens a manifest rather than
    // recording five things nobody looked at.
    db.exec(
      `insert into products (id, org_id, display_name, category)
       values ('prod-case', ?, 'A-Cam Case', 'case')`,
      [ORG],
    )
    db.exec(
      `insert into assets
         (id, org_id, product_id, asset_code, display_name, is_container,
          presence, health, ownership, current_location_id, updated_at)
       values ('asset-case-1', ?, 'prod-case', 'CASE-01', 'A-Cam Case', 1,
               'here', 'ok', 'owned', 'loc-rack-a', ?)`,
      [ORG, new Date().toISOString()],
    )
    {
      const caseTag = tagCode(rng)
      db.exec(`insert into asset_tags (tag_code, asset_id, status) values (?, 'asset-case-1', 'active')`, [caseTag])
      tags.push({
        tagCode: caseTag,
        assetId: 'asset-case-1',
        assetCode: 'CASE-01',
        displayName: 'A-Cam Case',
        shelf: 'Rack A',
      })
    }
    const contents: [string, 'permanent' | 'packed'][] = [
      ['asset-fx9-1', 'permanent'],
      ['asset-sigma1835-1', 'packed'],
      ['asset-sigma1835-2', 'packed'],
      ['asset-vmount-1', 'packed'],
      ['asset-vmount-2', 'packed'],
    ]
    for (const [child, kind] of contents) {
      db.exec(
        `insert into asset_containment (parent_asset_id, child_asset_id, kind) values ('asset-case-1', ?, ?)`,
        [child, kind],
      )
    }

    // A finished dispute, waiting on the asset page: one camera photographed
    // going out clean and coming back marked. Without this the best feature in
    // the product is an empty state until someone finds a working camera.
    const photos: [string, 'out' | 'in', number, boolean, string][] = [
      ['demo-photo-out', 'out', Date.parse('2026-08-14T06:20:00Z'), false, 'DEMO PLATE - leaving the warehouse'],
      ['demo-photo-in', 'in', Date.parse('2026-08-17T19:05:00Z'), true, 'DEMO PLATE - back from the shoot'],
    ]
    for (const [id, side, at, mark, caption] of photos) {
      db.exec(
        `insert into condition_photos
           (id, asset_id, job_id, session_id, side, captured_at, sha256, bytes, local_uri, note, uploaded)
         values (?, 'asset-fx9-1', 'job-shan', null, ?, ?, null, 0, ?, null, 1)`,
        [id, side, at, conditionPlate(caption, mark)],
      )
    }
  })

  return {
    orgId: ORG,
    userName: 'Usman (prep)',
    tags,
    jobs: JOBS.map((j) => ({
      id: j.id,
      label: j.label,
      contact: j.contact,
      departsAt: j.departsAt,
      expectedBack: isoDaysFromNow(j.backInDays),
      expected: expectedFor(j),
    })),
  }
}

/** The catalogue the kit-list reader matches a pasted WhatsApp message against. */
export function demoCatalogue(): { id: string; name: string }[] {
  return PRODUCTS.map((p) => ({ id: `prod-${p.key}`, name: p.name }))
}
