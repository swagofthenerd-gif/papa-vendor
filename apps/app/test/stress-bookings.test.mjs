/**
 * Adversarial stress: the promise calendar under a year of random desks.
 *
 * Five hundred seeded-random bookings over twelve months on a 60-unit
 * fleet, interleaved with confirms, extensions, conversions and cancels
 * the way a busy desk actually works — then every invariant the calendar
 * promises (0022 on the server, demo/bookings.ts on the phone) re-checked
 * after EVERY write, not at the end.
 *
 * INVARIANTS
 *  - no two confirmed claims overlap on one unit, '[)' on the blocked
 *    window — the exclusion constraint's promise, on the phone
 *  - every pencil is confirmed, cancelled or expired by its own timestamp:
 *    after any write there is no pencil the clock has already passed,
 *    and once the year is over and the clock has run on, none remains
 *  - booking numbers are gapless — a refused confirm never burns one
 *  - an extension either lands with no collision, or changes nothing and
 *    hands back exactly the collision list the preview showed
 *  - availability is never negative over any window
 *  - converting yields a job whose expected set IS the allocation
 *  - reservations belong only to live bookings in the matching state
 *
 * Seeded mulberry32; the clock is a fixed 2031 calendar (far from the
 * seed's wall-clock-relative bookings, whose two pencils expire at the
 * first write — that is the prune doing its job, and it is counted).
 * Reruns are identical.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, DAY_MS, HOUR_MS, bookingAvailability, loadAssetReservations } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { openJob } from '../src/demo/read-model.ts'
import { createCustomer } from '../src/demo/khata.ts'
import {
  bookingView,
  cancelBooking,
  confirmBooking,
  convertBookingToJob,
  createBooking,
  extendBooking,
  extensionPreview,
  pruneExpiredPencils,
} from '../src/demo/bookings.ts'

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const pick = (r, xs) => xs[Math.floor(r() * xs.length)]
const int = (r, lo, hi) => lo + Math.floor(r() * (hi - lo + 1))

const ORG = 'demo-org'
/** Mon 6 Jan 2031, 09:00 local — a year the seed's calendar never touches. */
const T0 = new Date(2031, 0, 6, 9).getTime()
const YEAR = 365 * DAY_MS
const STEPS = 500
const PRODUCTS = 6
const UNITS_PER_PRODUCT = 10

// ------------------------------------------------------------- the world

/** The seeded house plus a 60-unit stress fleet: six serialized products,
 *  ten units each, no replacement value on purpose — the credential gate
 *  (exposure over the threshold) is another test's subject, and a fleet
 *  that trips it on every stranger would only measure the gate. */
function world() {
  const db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  const seed = seedDemo(db)
  const products = []
  const units = new Map()
  for (let k = 0; k < PRODUCTS; k++) {
    const productId = `sp-${k}`
    db.exec(
      `insert into products (id, org_id, display_name, category) values (?, ?, ?, 'camera')`,
      [productId, ORG, `Stress Body ${k}`],
    )
    const ids = []
    for (let i = 1; i <= UNITS_PER_PRODUCT; i++) {
      const id = `su-${k}-${i}`
      db.exec(
        `insert into assets
           (id, org_id, product_id, asset_code, display_name, presence, health, ownership,
            current_location_id, current_job_id, updated_at)
         values (?, ?, ?, ?, ?, 'here', 'ok', 'owned', 'loc-rack-a', null, ?)`,
        [id, ORG, productId, `SP${k}-${String(i).padStart(2, '0')}`, `Stress Body ${k}`, new Date(T0).toISOString()],
      )
      ids.push(id)
    }
    products.push(productId)
    units.set(productId, ids)
  }
  const customers = ['cust-bilal', 'cust-hamza', 'cust-ayesha', 'cust-imran']
  for (let n = 1; n <= 4; n++) {
    customers.push(createCustomer(db, { id: `cust-stress-${n}`, orgId: ORG, name: `Stress Client ${n}`, phone: null }))
  }
  return { db, seed, products, units, customers }
}

const iso = (ms) => new Date(ms).toISOString()

// ---------------------------------------------------------- the invariants

/** Confirmed claims that overlap on one unit, '[)' — must always be zero.
 *  One query, then a sort per unit: a self-join has no index to lean on
 *  and went quadratic in the year's own reservations. */
function overlappingConfirmedClaims(db) {
  const byUnit = new Map()
  for (const r of db.all(
    `select r.asset_id, r.blocked_from as f, r.blocked_until as u
       from asset_reservations r join bookings b on b.id = r.booking_id
      where r.state = 'confirmed' and b.status = 'confirmed'`,
  )) {
    if (!byUnit.has(r.asset_id)) byUnit.set(r.asset_id, [])
    byUnit.get(r.asset_id).push([Date.parse(r.f), Date.parse(r.u)])
  }
  let overlaps = 0
  for (const claims of byUnit.values()) {
    claims.sort((a, b) => a[0] - b[0])
    for (let i = 1; i < claims.length; i++) if (claims[i][0] < claims[i - 1][1]) overlaps++
  }
  return overlaps
}

function assertInvariants(w, nowMs, r, label, sweep = false) {
  const { db, products, units } = w

  assert.equal(overlappingConfirmedClaims(db), 0, `${label}: two confirmed claims overlap on one unit`)

  // Gapless numbers — every refused confirm left the counter alone.
  const nos = db.all(`select booking_no from bookings order by booking_no`).map((x) => Number(x.booking_no))
  assert.deepEqual(nos, nos.map((_, i) => i + 1), `${label}: booking numbers have a gap`)

  // No pencil the clock has already passed survives a write.
  const dead = db.get(
    `select count(*) as n from bookings where status = 'pencil' and pencil_expires_at <= ?`, [iso(nowMs)],
  )
  assert.equal(Number(dead.n), 0, `${label}: an expired pencil was not pruned`)

  // Reservations belong to live bookings, in the matching state.
  const orphans = db.get(
    `select count(*) as n from asset_reservations r join bookings b on b.id = r.booking_id
      where (r.state = 'confirmed' and b.status <> 'confirmed')
         or (r.state = 'pencil' and b.status <> 'pencil')
         or b.status = 'cancelled'`,
  )
  assert.equal(Number(orphans.n), 0, `${label}: a reservation outlived its booking's state`)

  // Availability is never negative over a random window — two products a
  // step (the reservation table grows all year; twelve reads a step made
  // this the suite's slowest file), every product at the year-end sweep.
  const asked = sweep ? products : [pick(r, products), pick(r, products)]
  for (const productId of asked) {
    for (let i = 0; i < (sweep ? 4 : 1); i++) {
      const start = nowMs + int(r, -3 * DAY_MS, 40 * DAY_MS)
      const end = start + int(r, HOUR_MS, 10 * DAY_MS)
      const a = bookingAvailability(db, productId, start, end, nowMs)
      assert.ok(a.available >= 0, `${label}: negative availability`)
      assert.ok(a.confirmedOverlap <= units.get(productId).length, `${label}: more claims than units`)
      assert.equal(a.available, Math.max(a.hereNow - a.confirmedOverlap, 0), `${label}: availability arithmetic`)
    }
  }
}

// ------------------------------------------------------------- the desk

describe('the promise calendar under a year of random desks', () => {
  test(`${STEPS} bookings on a 60-unit fleet (and a second seed's 200): every invariant holds after every write`, () => {
    for (const [seedN, steps] of [[7, STEPS], [1913, 200]]) {
      const w = world()
      const { db, products, units, customers } = w
      const r = rng(seedN)
      let n = 0
      const ids = { now: () => now, newId: () => `s${seedN}-${++n}` }
      let now = T0
      const label = () => `seed ${seedN} step ${step}`
      const counts = {
        created: 0, confirmedAtCreate: 0, refusedAtCreate: 0, confirmed: 0, collisions: 0, shortfalls: 0,
        extended: 0, extensionRefused: 0, converted: 0, cancelled: 0, cancelRefused: 0,
      }
      /** This desk's bookings whose stamp is one of `want` — one query, the
       *  stamp rule of bookings.ts (a pencil the clock has passed reads
       *  'expired'), so 500 steps do not re-read 500 views each. */
      const live = (want) => db
        .all(`select id, status, pencil_expires_at as exp from bookings where id like ?`, [`bk-s${seedN}-%`])
        .filter((b) => {
          const stamp = b.status === 'pencil' && !(b.exp && Date.parse(b.exp) > now) ? 'expired' : b.status
          return want.includes(stamp)
        })
        .map((b) => b.id)
      const hasJob = (id) => !!db.get(`select 1 as one from jobs where booking_id = ?`, [id])
      let step = 0

      for (step = 0; step < steps; step++) {
        now = T0 + Math.floor((step * YEAR) / steps) + int(r, 0, HOUR_MS)

        // ---- create: a pencil, a straight confirm, or a draft ---------------
        const start = now + int(r, HOUR_MS, 30 * DAY_MS)
        const end = start + int(r, 2 * HOUR_MS, 7 * DAY_MS)
        const lines = []
        for (let l = int(r, 1, 3); l > 0; l--) {
          const productId = pick(r, products)
          if (r() < 0.15) lines.push({ assetId: pick(r, units.get(productId)) })
          else lines.push({ productId, qty: int(r, 1, 4) })
        }
        const roll = r()
        const status = roll < 0.55 ? 'pencil' : roll < 0.85 ? 'confirmed' : 'draft'
        const made = createBooking(db, ORG, { customerId: pick(r, customers), startMs: start, endMs: end, lines, status }, now, ids)
        assert.ok(made.bookingId, `${label()}: a well-formed create always leaves a booking`)
        counts.created++
        if (made.ok) {
          if (made.confirm) counts.confirmedAtCreate++
        } else {
          counts.refusedAtCreate++
          assert.ok('collision' in made || made.reason === 'short', `${label()}: refused for ${made.reason}`)
          assert.equal(bookingView(db, made.bookingId, now).stamp, 'pencil', `${label()}: the pencil stands after a refused confirm`)
          if ('collision' in made) counts.collisions++; else counts.shortfalls++
        }

        // ---- confirm a pencil or a draft ---------------------------------------
        if (r() < 0.5) {
          const candidates = live(['pencil', 'draft'])
          if (candidates.length > 0) {
            const id = pick(r, candidates)
            const c = confirmBooking(db, ORG, id, {}, now, ids)
            if (c.ok) {
              counts.confirmed++
              const allocated = c.allocations.map((a) => a.assetId)
              assert.equal(new Set(allocated).size, allocated.length, `${label()}: one unit allocated twice in one confirm`)
              assert.equal(bookingView(db, id, now).stamp, 'confirmed')
            } else {
              assert.ok('collision' in c || c.reason === 'short', `${label()}: refused for ${c.reason}`)
              if ('collision' in c) counts.collisions++; else counts.shortfalls++
              assert.notEqual(bookingView(db, id, now).stamp, 'confirmed')
            }
          }
        }

        // ---- extend a confirmed booking ---------------------------------------
        if (r() < 0.2) {
          const candidates = live(['confirmed'])
          if (candidates.length > 0) {
            const id = pick(r, candidates)
            const before = bookingView(db, id, now)
            const newEnd = before.customerEndMs + int(r, HOUR_MS, 5 * DAY_MS)
            const preview = extensionPreview(db, id, newEnd, now)
            const x = extendBooking(db, id, newEnd, now, ids)
            const after = bookingView(db, id, now)
            if (x.extended) {
              counts.extended++
              assert.equal(preview.collisions.length, 0, `${label()}: the preview saw a collision the extend ignored`)
              assert.equal(after.customerEndMs, newEnd)
              assert.equal(after.blockedEndMs, preview.blockedEndMs)
            } else {
              counts.extensionRefused++
              assert.ok(x.collisions.length > 0, `${label()}: refused with no collision named`)
              assert.deepEqual(x.collisions, preview.collisions, `${label()}: the refusal is not the preview`)
              assert.equal(after.customerEndMs, before.customerEndMs, `${label()}: a refused extension moved the end`)
              assert.equal(after.blockedEndMs, before.blockedEndMs)
            }
            assert.equal(overlappingConfirmedClaims(db), 0, `${label()}: an extension produced an overlap`)
          }
        }

        // ---- convert a confirmed booking to its job ---------------------------
        if (r() < 0.15) {
          const candidates = live(['confirmed']).filter((id) => !hasJob(id))
          if (candidates.length > 0) {
            const id = pick(r, candidates)
            const v = convertBookingToJob(db, ORG, id, now, ids)
            assert.equal(v.ok, true, `${label()}: convert refused ${v.reason}`)
            counts.converted++
            const allocation = loadAssetReservations(db, id).filter((x) => x.state === 'confirmed').map((x) => x.assetId).sort()
            assert.deepEqual([...openJob(db, v.jobId).expected].sort(), allocation, `${label()}: the job's expected set is not the allocation`)
            assert.equal(v.expected, allocation.length)
            assert.equal(bookingView(db, id, now).job?.id, v.jobId)
            assert.deepEqual(convertBookingToJob(db, ORG, id, now, ids), { ok: false, reason: 'already_has_job' })
          }
        }

        // ---- cancel something live ---------------------------------------------
        if (r() < 0.15) {
          const candidates = live(['pencil', 'confirmed', 'draft'])
          if (candidates.length > 0) {
            const id = pick(r, candidates)
            const hadJob = hasJob(id)
            const c = cancelBooking(db, id, 'stress', now, ids)
            if (hadJob) {
              counts.cancelRefused++
              assert.equal(c.ok, false)
              assert.equal(c.reason, 'job_open', `${label()}: a booking with a live job cancelled`)
            } else {
              counts.cancelled++
              assert.equal(c.ok, true)
              assert.equal(loadAssetReservations(db, id).length, 0, `${label()}: a cancel left claims behind`)
              assert.equal(bookingView(db, id, now).stamp, 'cancelled')
            }
          }
        }

        assertInvariants(w, now, r, label())
      }

      // ---- the year is over: the clock runs on, every pencil is dead ----------
      now = T0 + YEAR + 40 * DAY_MS
      pruneExpiredPencils(db, now)
      assertInvariants(w, now, r, `seed ${seedN} year end`, true)
      assert.equal(Number(db.get(`select count(*) as n from bookings where status = 'pencil'`).n), 0, `seed ${seedN}: a pencil outlived the year`)
      const expired = Number(db.get(`select count(*) as n from bookings where cancel_reason = 'pencil_expired'`).n)
      assert.ok(expired > 0, `seed ${seedN}: no pencil ever expired`)
      const statuses = new Set(db.all(`select distinct status as s from bookings`).map((x) => x.s))
      for (const s of statuses) assert.ok(['draft', 'confirmed', 'cancelled'].includes(s), `seed ${seedN}: status ${s} at year end`)

      // ---- the queue told the same story ----------------------------------------
      const opCount = (op) => Number(db.get(`select count(*) as n from outbox where op = ?`, [op]).n)
      assert.equal(opCount('create_booking'), counts.created, `seed ${seedN}: one create op per booking`)
      assert.equal(opCount('confirm_booking'), counts.confirmedAtCreate + counts.confirmed, `seed ${seedN}: one confirm op per confirm`)
      assert.equal(opCount('extend_booking'), counts.extended, `seed ${seedN}: refused extensions queue nothing`)
      assert.equal(opCount('convert_booking_to_job'), counts.converted)
      assert.equal(opCount('cancel_booking'), counts.cancelled)
      assert.equal(
        Number(db.get(`select count(*) as n from outbox where op in ('confirm_booking','extend_booking','convert_booking_to_job','cancel_booking') and depends_on is null`).n),
        0,
        `seed ${seedN}: every later op on a booking chains behind an earlier one`,
      )

      // ---- the run exercised every door -------------------------------------------
      assert.equal(counts.created, steps)
      for (const [k, v] of Object.entries(counts)) assert.ok(v > 0, `seed ${seedN}: ${k} never happened`)
    }
  })
})
