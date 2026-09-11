import { DEFAULT_BOOKING_SETTINGS, HOUR_MS, blockedPeriod, type SqlDriver } from '@papa/core'
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
  /** Day rate and replacement value in WHOLE RUPEES (stored as minor units).
   *  Absent means no rate — the honest 'unpriced', never zero. */
  dayRateRs?: number
  replacementRs?: number
  /** Service due after this many rental days (0021 D1). Absent = no nudge. */
  serviceDueDays?: number
  /** Count check_out cycles on this product's units (0021 D3). */
  countCycles?: boolean
  /** Cycle ceiling — crossing raises an alert, never a state change. */
  retireAfterCycles?: number
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
// ASSUMPTION: the per-product day rates and replacement values below are
// plausible Lahore PKR figures, unvalidated — no primary rate-card source.
// They exist so money renders on the return flow, the hisaab and the parchi;
// the pilot vendor's real rate card replaces them. Sachdeva Tripod and the
// C-Stands are LEFT UNPRICED on purpose, so the '+N unpriced' honesty path
// is visible in the demo. See docs/assumptions.md#demo-rates
const PRODUCTS: ProductSpec[] = [
  // The FX9s carry the living-fleet config (0021): a usage-service
  // threshold and the cycle flag with a ceiling — FX9-01 is seeded OVER
  // the service threshold and FX9-02 NEAR the cycle ceiling below, so the
  // service line, the cycle line and the Sehat surface all show real
  // numbers the moment the demo opens.
  { key: 'fx9', name: 'Sony FX9', category: 'camera', units: 2, shelf: 'loc-rack-a', code: 'FX9', dayRateRs: 25_000, replacementRs: 3_500_000, serviceDueDays: 100, countCycles: true, retireAfterCycles: 30 },
  { key: 'fx6', name: 'Sony FX6', category: 'camera', units: 3, shelf: 'loc-rack-a', code: 'FX6', dayRateRs: 18_000, replacementRs: 2_200_000 },
  { key: 'c300', name: 'Canon C300 Mark III', category: 'camera', units: 2, shelf: 'loc-rack-a', code: 'C300', dayRateRs: 20_000, replacementRs: 2_800_000 },
  { key: 'c500', name: 'Canon C500 Mark II', category: 'camera', units: 1, shelf: 'loc-rack-a', code: 'C500', dayRateRs: 22_000, replacementRs: 3_000_000 },
  { key: 'komodo', name: 'RED Komodo 6K', category: 'camera', units: 1, shelf: 'loc-rack-a', code: 'KMD', dayRateRs: 20_000, replacementRs: 2_500_000 },
  { key: 'sigma1835', name: 'Sigma 18-35mm f1.8', category: 'lens', units: 3, shelf: 'loc-rack-b', code: 'SG1835', dayRateRs: 8_000, replacementRs: 350_000 },
  { key: 'sigma50100', name: 'Sigma 50-100mm f1.8', category: 'lens', units: 2, shelf: 'loc-rack-b', code: 'SG50100', dayRateRs: 9_000, replacementRs: 400_000 },
  { key: 'cne', name: 'Canon CN-E Prime Set', category: 'lens', units: 1, shelf: 'loc-rack-b', code: 'CNE', dayRateRs: 30_000, replacementRs: 8_000_000 },
  { key: 'samyang', name: 'Samyang Xeen Prime Set', category: 'lens', units: 1, shelf: 'loc-rack-b', code: 'XEEN', dayRateRs: 25_000, replacementRs: 4_500_000 },
  { key: 'ronin', name: 'DJI Ronin RS3 Pro', category: 'support', units: 2, shelf: 'loc-rack-c', code: 'RS3', dayRateRs: 8_000, replacementRs: 250_000 },
  { key: 'sachtler', name: 'Sachtler Flowtech 75', category: 'support', units: 2, shelf: 'loc-rack-c', code: 'SACH', dayRateRs: 5_000, replacementRs: 700_000 },
  { key: 'sachdeva', name: 'Sachdeva Tripod', category: 'support', units: 3, shelf: 'loc-rack-c', code: 'SDV' },
  { key: 'smallhd', name: 'SmallHD 702 Monitor', category: 'monitor', units: 2, shelf: 'loc-rack-c', code: 'SHD', dayRateRs: 4_000, replacementRs: 250_000 },
  { key: 'aputure600', name: 'Aputure 600D Pro', category: 'light', units: 4, shelf: 'loc-grip', code: 'AP600', dayRateRs: 12_000, replacementRs: 550_000 },
  { key: 'aputure300', name: 'Aputure 300X', category: 'light', units: 2, shelf: 'loc-grip', code: 'AP300', dayRateRs: 7_000, replacementRs: 250_000 },
  { key: 'forza', name: 'Nanlite Forza 500', category: 'light', units: 2, shelf: 'loc-grip', code: 'FRZ', dayRateRs: 8_000, replacementRs: 300_000 },
  { key: 'cstand', name: 'C-Stand', category: 'grip', units: 8, shelf: 'loc-grip', code: 'CST' },
  { key: 'mixpre', name: 'Sound Devices MixPre-6', category: 'sound', units: 2, shelf: 'loc-rack-c', code: 'MXP', dayRateRs: 6_000, replacementRs: 350_000 },
  { key: 'mkh416', name: 'Sennheiser MKH 416', category: 'sound', units: 2, shelf: 'loc-rack-c', code: 'MKH', dayRateRs: 4_000, replacementRs: 300_000 },
  { key: 'vmount', name: 'V-Mount Battery 190Wh', category: 'power', units: 12, shelf: 'loc-cage', code: 'VM', dayRateRs: 1_500, replacementRs: 60_000 },
  { key: 'xlr', name: 'XLR Cable 5m', category: 'cable', units: 20, shelf: 'loc-cage', code: 'XLR', dayRateRs: 300, replacementRs: 8_000 },
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

/** Which khata each seeded live job's money lands in — jobs.customer_id,
 *  the real mirror column (0017/0018), not a demo-only link table. */
const JOB_CUSTOMER: Record<string, string> = {
  'job-shan': 'cust-bilal',
  'job-wedding': 'cust-hamza',
  'job-doc': 'cust-ayesha',
}

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
  return localDay(d)
}

/** Local 'YYYY-MM-DD' — the shape the server's `date` columns mirror. */
function localDay(d: Date): string {
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
  /** The house's name as it reads on a challan — the parchi letterhead. */
  houseName: string
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
        `insert into products (id, org_id, display_name, category,
           service_due_after_rental_days, count_cycles, retire_after_cycles)
         values (?, ?, ?, ?, ?, ?, ?)`,
        [
          productId, ORG, p.name, p.category,
          p.serviceDueDays ?? null,
          p.countCycles ? 1 : 0,
          p.retireAfterCycles ?? null,
        ],
      )

      // Replacement value in minor units (paisa), the server's `_minor`
      // convention. A product without one gets NO row: 'no value' must stay
      // distinguishable from 'Rs 0', and a null-stuffed row invites someone
      // to sum it. The DAY RATE goes on the rate card below (seedRateCard)
      // — the one rate home since 0024.
      if (p.replacementRs !== undefined) {
        db.exec(
          `insert into product_rates (product_id, replacement_minor) values (?, ?)`,
          [productId, p.replacementRs * 100],
        )
      }

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
        `insert into jobs (id, org_id, label, contact, expected_back, status, customer_id)
         values (?, ?, ?, ?, ?, 'open', ?)`,
        [j.id, ORG, j.label, j.contact, isoDaysFromNow(j.backInDays), JOB_CUSTOMER[j.id] ?? null],
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

    // The living-fleet stories (0021), as synced state — on a real phone
    // these counters arrive from the server's projection:
    //   FX9-01 is OVER its 100-day service threshold (the JUN nudge, real),
    //   FX9-02 is NEAR the 30-cycle ceiling (one busy week crosses it live),
    //   and two units sit dead: the Xeen set (Rs 4.5M idle — the number
    //   that sells the surface) and a Sachdeva tripod (unpriced, so the
    //   value line's '+1 unpriced' honesty path is visible too). Their
    //   last sighting is stamped 120 days back; nothing else has an
    //   anchor, so the demo's dead-stock list stays these two.
    db.exec(
      `update assets set rental_days_since_service = 120, cycle_count = 24 where id = 'asset-fx9-1'`,
    )
    db.exec(
      `update assets set rental_days_since_service = 41, cycle_count = 28 where id = 'asset-fx9-2'`,
    )
    {
      const idleSince = new Date(msDaysAgo(120)).toISOString()
      db.exec(
        `update assets set last_scanned_at = ?, updated_at = ? where id in ('asset-samyang-1', 'asset-sachdeva-3')`,
        [idleSince, idleSince],
      )
    }

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

    seedRateCard(db)
    seedMoneyBook(db)
    seedBookings(db)
  })

  return {
    orgId: ORG,
    houseName: 'Ravi Light & Grip',
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

/**
 * The rate card (0024, mirrored by 0026): ONE default card, 'Standard',
 * on the documented knobs — a 3-day week (ASSUMPTION #week-rate), one
 * billable day minimum, every day billing (ASSUMPTION #weekend-free) —
 * with an entry for every product that carries a day rate above. Sachdeva
 * Tripod, the C-Stands and the case have NO entry, so the quote sheet's
 * UNPRICED path is visible the moment the demo opens.
 *
 * The calendar (ASSUMPTION #seasonal-pricing): the coming Dec–Feb wedding
 * season at 1.0 — shading only — and ONE Eid holiday at 1.25 next spring,
 * so a quote crossing it shows the multiplier line with a real number.
 * ASSUMPTION: the seeded Eid falls on the coming 10 April; Eid moves on
 * the lunar calendar and the desk edits the row. See
 * docs/assumptions.md#demo-eid
 */
function seedRateCard(db: SqlDriver): void {
  const iso = new Date().toISOString()
  db.exec(
    `insert into rate_cards (id, org_id, name, is_default, week_equals_days,
       min_billable_days, weekend_mask, updated_at)
     values ('card-standard', ?, 'Standard', 1, 3, 1, '[]', ?)`,
    [ORG, iso],
  )
  for (const p of PRODUCTS) {
    if (p.dayRateRs === undefined) continue
    db.exec(
      `insert into rate_card_entries (id, org_id, rate_card_id, product_id, day_rate_minor)
       values (?, ?, 'card-standard', ?, ?)`,
      [`rce-${p.key}`, ORG, `prod-${p.key}`, p.dayRateRs * 100],
    )
  }
  const now = new Date()
  const seasonYear = now.getMonth() <= 1 ? now.getFullYear() - 1 : now.getFullYear()
  for (let d = new Date(seasonYear, 11, 1); d < new Date(seasonYear + 1, 2, 1); d.setDate(d.getDate() + 1)) {
    db.exec(
      `insert into org_calendar_days (id, org_id, day, kind, name, rate_multiplier)
       values (?, ?, ?, 'season', 'Wedding season', 1.0)`,
      [`cal-season-${localDay(d)}`, ORG, localDay(d)],
    )
  }
  let eidYear = now.getFullYear()
  if (new Date(eidYear, 3, 10).getTime() <= now.getTime()) eidYear++
  db.exec(
    `insert into org_calendar_days (id, org_id, day, kind, name, rate_multiplier)
     values ('cal-eid', ?, ?, 'holiday', 'Eid ul-Fitr', 1.25)`,
    [ORG, `${eidYear}-04-10`],
  )
}

/** Epoch ms `days` before now — the ledger's created_at voice. Relative for
 *  the same reason the due dates are: a fixed date rots into ancient history
 *  and the khata would stop demonstrating a current month. */
function msDaysAgo(days: number): number {
  return Date.now() - days * 24 * 60 * 60 * 1000
}

/**
 * The money book's seed: four customers wired to the jobs, with the history
 * Phase B's screens need to demonstrate every state honestly —
 *
 *   Bilal   owes across TWO jobs (one closed, one on today's board)
 *   Hamza   clean: charged and paid in full
 *   Imran   nothing owed, but a deposit HELD pending inspection
 *   Ayesha  overdue with an unpaid charge — the late-fee draft's customer
 *
 * Amounts are minor units (paisa), the `_minor` convention everywhere.
 * ASSUMPTION: the figures are plausible Lahore PKR, unvalidated — same
 * status as the seeded rates. See docs/assumptions.md#demo-rates
 */
function seedMoneyBook(db: SqlDriver): void {
  const customers: [string, string, string | null][] = [
    ['cust-bilal', 'Bilal Hussain', '0300 4412233'],
    ['cust-hamza', 'Hamza Saeed', '0321 8899001'],
    ['cust-ayesha', 'Ayesha Raza', '0333 1122334'],
    ['cust-imran', 'Imran Qureshi', '0345 6677889'],
  ]
  for (const [id, name, phone] of customers) {
    db.exec(
      `insert into customers (id, org_id, name, phone, note) values (?, ?, ?, ?, null)`,
      [id, ORG, name, phone],
    )
  }
  // Two regulars with paperwork on file, two without — so the credential
  // gate on confirm (0022 D9) has both a pass and a refusal to show.
  db.exec(`update customers set credentials_verified = 1 where id in ('cust-bilal', 'cust-hamza')`)

  // Closed jobs the histories hang off. status 'closed' keeps them off the
  // Today board (openJobs selects 'open' only) while the khata still links,
  // and closed_at is stamped the way closeJob stamps it — the "Closed jobs"
  // door reads it. Customers wire through jobs.customer_id, the real mirror
  // column. (The live jobs' wiring rides the JOBS insert via JOB_CUSTOMER.)
  const closedJobs: [string, string, string, number][] = [
    ['job-shan-stills', 'Shan Foods stills — day shoot', 'cust-bilal', 32],
    ['job-hamza-mehndi', 'Mehndi — Model Town', 'cust-hamza', 17],
    ['job-imran-drama', 'Drama serial — Bahria set', 'cust-imran', 4],
  ]
  for (const [id, label, customerId, closedDaysAgo] of closedJobs) {
    db.exec(
      `insert into jobs (id, org_id, label, contact, expected_back, status,
                         customer_id, closed_at)
       values (?, ?, ?, null, null, 'closed', ?, ?)`,
      [id, ORG, label, customerId, new Date(msDaysAgo(closedDaysAgo)).toISOString()],
    )
  }

  // [id, customer, kind, rupees(signed), job, asset, note, daysAgo]
  const entries: [
    string, string, string, number, string | null, string | null, string | null, number,
  ][] = [
    // Bilal: Rs 60,000 charged last month, half paid, Rs 45,000 charged on
    // today's TVC — Rs 75,000 owed across two jobs. Both charges name
    // FX9-01, so its payback bar has two jobs behind it.
    ['led-bilal-1', 'cust-bilal', 'charge', 60_000, 'job-shan-stills', 'asset-fx9-1', 'FX9 kit, 2 days', 34],
    ['led-bilal-2', 'cust-bilal', 'payment', -30_000, 'job-shan-stills', null, 'JazzCash', 30],
    ['led-bilal-3', 'cust-bilal', 'charge', 45_000, 'job-shan', 'asset-fx9-1', 'TVC day, FX9 + lights', 1],
    // Hamza: the clean khata — charged, paid in full, balance zero.
    ['led-hamza-1', 'cust-hamza', 'charge', 80_000, 'job-hamza-mehndi', 'asset-fx6-1', '2x FX6, one day', 20],
    ['led-hamza-2', 'cust-hamza', 'payment', -80_000, 'job-hamza-mehndi', null, 'Cash', 18],
    // Ayesha: unpaid charge on the OVERDUE job — the return flow offers
    // the late-fee draft on top of this balance; nothing is auto-charged.
    ['led-ayesha-1', 'cust-ayesha', 'charge', 55_000, 'job-doc', 'asset-c300-1', 'C300 + CN-E, 3 days', 9],
    // Imran: paid up, but Rs 50,000 held as security — the deposit pot,
    // separate from the balance, released only after inspection.
    ['led-imran-1', 'cust-imran', 'charge', 40_000, 'job-imran-drama', 'asset-komodo-1', 'Komodo, 2 days', 6],
    ['led-imran-2', 'cust-imran', 'deposit_hold', 50_000, 'job-imran-drama', null, 'Cheque held', 6],
    ['led-imran-3', 'cust-imran', 'payment', -40_000, 'job-imran-drama', null, 'Bank transfer', 5],
  ]
  for (const [id, cust, kind, rupees, job, asset, note, daysAgo] of entries) {
    db.exec(
      `insert into customer_ledger_entries
         (id, org_id, customer_id, kind, amount_minor, job_id, asset_id, note, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, ORG, cust, kind, rupees * 100, job, asset, note, msDaysAgo(daysAgo)],
    )
  }

  // The expense side (0019): one of each story the screens must tell —
  //   a REPAIR on FX9-01 (the camera the seeded photo dispute is about:
  //     the payback bar's denominator and the asset cost line read this),
  //   a SUB-HIRE tied to the drama job it rescued (the job margin line),
  //   a PURCHASE with no links (the plain consumables-run shape).
  // ASSUMPTION: plausible Lahore figures, same status as the seeded rates.
  // [id, kind, rupees, asset, job, counterparty, note, daysAgo]
  const expenses: [
    string, string, number, string | null, string | null, string, string, number,
  ][] = [
    ['exp-fx9-repair', 'repair', 45_000, 'asset-fx9-1', null,
     'Sharif Camera Works', 'Top handle + mount — came back marked', 8],
    ['exp-drama-subhire', 'sub_hire', 18_000, null, 'job-imran-drama',
     'Noor Light & Grip', '2x 600D for the Bahria set', 5],
    ['exp-xlr-restock', 'purchase', 16_000, null, null,
     'Hall Road', 'XLR cables x10', 12],
  ]
  for (const [id, kind, rupees, asset, job, counterparty, note, daysAgo] of expenses) {
    db.exec(
      `insert into org_expenses
         (id, org_id, kind, amount_minor, asset_id, job_id, counterparty, note,
          reversal_of, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
      [id, ORG, kind, rupees * 100, asset, job, counterparty, note, msDaysAgo(daysAgo)],
    )
  }
}

/** Local `days` from today at `hour`:00 — a booking instant. Relative for
 *  the same reason the due dates are: a fixed calendar rots. */
function atDays(days: number, hour: number): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour, 0, 0, 0).getTime()
}

/** The coming 20 December at `hour` — this year's if it is still ahead,
 *  otherwise next year's — so the wedding-season booking is always a
 *  future promise, not a stale one. */
function nextDecember(day: number, hour: number): number {
  const now = new Date()
  let y = now.getFullYear()
  if (new Date(y, 11, 20, 0, 0).getTime() <= now.getTime()) y++
  return new Date(y, 11, day, hour, 0, 0, 0).getTime()
}

interface BookingSpec {
  id: string
  no: number
  customer: string
  status: 'pencil' | 'confirmed'
  startMs: number
  endMs: number
  /** Pencil only: expiry relative to seed time, hours (negative = dead). */
  expiresInHours?: number
  note: string | null
  /** [product key, qty, allocated unit ids (confirmed only)] or a demanded unit. */
  lines: ({ product: string; qty: number; alloc: string[] } | { asset: string })[]
}

/**
 * The promise calendar's seed (0022; PLAN phase 2) — every state the
 * screens must show, relative to the day the demo opens:
 *
 *   B#1, B#2  CONFIRMED next week (Hamza's mehndi, Imran's drama block),
 *             units bound the way confirm binds them — least-utilised
 *             first, so B#1 holds FX9-02 (41 days) over FX9-01 (120);
 *   B#3       a live PENCIL dying in ~5h — the countdown chip's customer;
 *   B#4       a pencil that EXPIRED yesterday and has not been pruned —
 *             the predicate must already read it dead, and the next write
 *             cancels it with reason pencil_expired (D7);
 *   B#5       CONFIRMED next month on FX9-02 again — so extending B#1 past
 *             it has a collision to name (D10) — and on FX6-03, the unit
 *             currently OUT on the documentary, so the scanner's
 *             promised-soon warning has a target once it comes home;
 *   B#6       December, wedding season (ASSUMPTION #wedding-season).
 *
 * Numbers 1–6 are gapless and the local counter continues at 7 (D12).
 */
function seedBookings(db: SqlDriver): void {
  const specs: BookingSpec[] = [
    {
      id: 'bk-1', no: 1, customer: 'cust-hamza', status: 'confirmed',
      startMs: atDays(7, 9), endMs: atDays(9, 18), note: 'Mehndi + baraat, DHA',
      lines: [
        { product: 'fx9', qty: 1, alloc: ['asset-fx9-2'] },
        { product: 'aputure600', qty: 2, alloc: ['asset-aputure600-1', 'asset-aputure600-2'] },
      ],
    },
    {
      id: 'bk-2', no: 2, customer: 'cust-imran', status: 'confirmed',
      startMs: atDays(8, 10), endMs: atDays(10, 10), note: null,
      lines: [
        { product: 'fx6', qty: 2, alloc: ['asset-fx6-1', 'asset-fx6-2'] },
        { product: 'mixpre', qty: 1, alloc: ['asset-mixpre-1'] },
      ],
    },
    {
      id: 'bk-3', no: 3, customer: 'cust-bilal', status: 'pencil', expiresInHours: 5,
      startMs: atDays(3, 8), endMs: atDays(4, 20), note: 'Waiting on the agency',
      lines: [
        { product: 'c300', qty: 1, alloc: [] },
        { product: 'sigma1835', qty: 2, alloc: [] },
      ],
    },
    {
      id: 'bk-4', no: 4, customer: 'cust-ayesha', status: 'pencil', expiresInHours: -24,
      startMs: atDays(5, 9), endMs: atDays(6, 9), note: null,
      lines: [{ product: 'komodo', qty: 1, alloc: [] }],
    },
    {
      id: 'bk-5', no: 5, customer: 'cust-bilal', status: 'confirmed',
      startMs: atDays(30, 9), endMs: atDays(32, 18), note: 'Corporate film, Gulberg',
      lines: [
        { product: 'fx9', qty: 1, alloc: ['asset-fx9-2'] },
        { asset: 'asset-fx6-3' },
      ],
    },
    {
      id: 'bk-6', no: 6, customer: 'cust-hamza', status: 'confirmed',
      startMs: nextDecember(20, 9), endMs: nextDecember(22, 20), note: 'Shaadi — Bahria',
      lines: [
        { product: 'fx6', qty: 2, alloc: ['asset-fx6-1', 'asset-fx6-2'] },
        { product: 'ronin', qty: 1, alloc: ['asset-ronin-1'] },
      ],
    },
  ]

  const iso = (ms: number) => new Date(ms).toISOString()
  const nowMs = Date.now()
  for (const b of specs) {
    const blocked = blockedPeriod(b.startMs, b.endMs, DEFAULT_BOOKING_SETTINGS)
    const name = db.get<{ name: string }>(`select name from customers where id = ?`, [b.customer])?.name ?? ''
    const expires = b.status === 'pencil'
      ? iso(nowMs + (b.expiresInHours ?? 24) * HOUR_MS)
      : null
    db.exec(
      `insert into bookings (id, org_id, booking_no, customer_id, customer_name, status,
         customer_from, customer_until, blocked_from, blocked_until, pencil_expires_at,
         note, cancel_reason, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, null, ?)`,
      [b.id, ORG, b.no, b.customer, name, b.status, iso(b.startMs), iso(b.endMs),
       iso(blocked.blockedStartMs), iso(blocked.blockedEndMs), expires, b.note, iso(nowMs)],
    )
    b.lines.forEach((line, i) => {
      const lineId = `${b.id}-line-${i + 1}`
      if ('asset' in line) {
        db.exec(
          `insert into booking_lines (id, org_id, booking_id, product_id, asset_id, qty)
           values (?, ?, ?, null, ?, 1)`,
          [lineId, ORG, b.id, line.asset],
        )
        if (b.status === 'confirmed') {
          db.exec(
            `insert into asset_reservations (id, org_id, booking_id, booking_line_id, asset_id,
               blocked_from, blocked_until, state) values (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
            [`${lineId}-res`, ORG, b.id, lineId, line.asset,
             iso(blocked.blockedStartMs), iso(blocked.blockedEndMs)],
          )
        }
        return
      }
      db.exec(
        `insert into booking_lines (id, org_id, booking_id, product_id, asset_id, qty)
         values (?, ?, ?, ?, null, ?)`,
        [lineId, ORG, b.id, `prod-${line.product}`, line.qty],
      )
      line.alloc.forEach((assetId, k) => {
        db.exec(
          `insert into asset_reservations (id, org_id, booking_id, booking_line_id, asset_id,
             blocked_from, blocked_until, state) values (?, ?, ?, ?, ?, ?, ?, 'confirmed')`,
          [`${lineId}-res-${k + 1}`, ORG, b.id, lineId, assetId,
           iso(blocked.blockedStartMs), iso(blocked.blockedEndMs)],
        )
      })
    })
  }
  db.exec(`insert into app_settings (key, value) values ('booking_next_no', '7')`)
}

/** The catalogue the kit-list reader matches a pasted WhatsApp message against. */
export function demoCatalogue(): { id: string; name: string }[] {
  return PRODUCTS.map((p) => ({ id: `prod-${p.key}`, name: p.name }))
}
