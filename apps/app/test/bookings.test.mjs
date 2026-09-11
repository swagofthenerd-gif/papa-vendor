/**
 * The promise calendar on the phone, against a real SQLite and the seeded
 * demo house — the write side's 0022 semantics, end to end:
 *
 *   * the seed: six bookings in the states the screens must show;
 *   * gapless numbers, and a refused create burns none (D12);
 *   * an expired pencil reads dead by the predicate, and the next write
 *     prunes it to cancelled/pencil_expired (D7);
 *   * a collision on confirm NAMES THE WINNER, never a raw error (D5);
 *   * allocation is least-utilised and skips held units (D4); a shortfall
 *     says how many it could find;
 *   * the credential gate refuses a stranger over the threshold, passes a
 *     verified regular, logs a manager's override (D9) — and says it
 *     read one local flag;
 *   * extension returns the collision list as data, then extends (D10);
 *   * convert-to-job lands the bound units on the Today board (D8);
 *   * the three availability layers over the seeded calendar (D6);
 *   * every write queues the RPC op, `p_*`-shaped, chained per booking;
 *   * the WhatsApp confirmation, golden, in both tables.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, DAY_MS, HOUR_MS, bookingDateLabel, promisedSoon } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { openJobs, openJob } from '../src/demo/read-model.ts'
import {
  availabilityFor,
  bookingConfirmText,
  bookingView,
  calendar,
  cancelBooking,
  confirmBooking,
  convertBookingToJob,
  createBooking,
  extendBooking,
  extensionPreview,
  listBookings,
  noteSubRent,
  planConfirm,
  promisedStrip,
  pruneExpiredPencils,
  reallocateReservation,
  substitutesForReservation,
} from '../src/demo/bookings.ts'
import { flagForManager, managerFlaggedAt } from '../src/demo/read-model.ts'
import { STR_EN } from '../src/strings.ts'
import { STR_UR } from '../src/strings-ur.ts'

const ORG = 'demo-org'
let db
let seed
let NOW
let n = 0
const ids = { now: () => NOW, newId: () => `t${String(++n).padStart(3, '0')}` }

/** Local `days` from today at `hour`:00 — the same instant the seed uses. */
const atDays = (days, hour) => {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days, hour, 0, 0, 0).getTime()
}

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  NOW = Date.now()
  n = 0
})

const byNo = (no, nowMs = NOW) => listBookings(db, {}, nowMs).find((b) => b.bookingNo === no)

describe('the seeded calendar', () => {
  test('six bookings, numbered 1–6, in the states the screens need', () => {
    const all = listBookings(db, {}, NOW)
    assert.deepEqual(all.map((b) => b.bookingNo).sort(), [1, 2, 3, 4, 5, 6])
    assert.equal(byNo(1).stamp, 'confirmed')
    assert.equal(byNo(2).stamp, 'confirmed')
    assert.equal(byNo(3).stamp, 'pencil')
    assert.equal(byNo(4).stamp, 'expired', 'expired yesterday, not yet pruned — reads dead anyway')
    assert.equal(byNo(5).stamp, 'confirmed')
    assert.equal(byNo(6).stamp, 'confirmed')
    assert.equal(byNo(1).customerName, 'Hamza Saeed')
  })

  test('the live pencil counts down ~5h; the dead one is off the live list', () => {
    const p = byNo(3).pencil
    assert.equal(p.expired, false)
    assert.ok(p.hours === 4 || p.hours === 5, `hours left: ${p.hours}`)
    const live = listBookings(db, { status: 'live' }, NOW).map((b) => b.bookingNo)
    assert.deepEqual(live, [3, 1, 2, 5, 6], 'soonest first, B#4 gone')
    assert.deepEqual(listBookings(db, { status: 'expired' }, NOW).map((b) => b.bookingNo), [4])
  })

  test('B#6 sits in wedding season; B#1 next week does not (in September)', () => {
    assert.equal(byNo(6).season, 'wedding')
    // Only assert the normal case when the demo is not itself opened in
    // Dec–Feb, when next week genuinely IS wedding season.
    const m = new Date(byNo(1).customerStartMs).getMonth()
    if (m !== 11 && m !== 0 && m !== 1) assert.equal(byNo(1).season, 'normal')
  })

  test('the confirmed bookings carry their bound units, least-utilised first', () => {
    const v = bookingView(db, 'bk-1', NOW)
    assert.equal(v.lines.length, 2)
    assert.deepEqual(v.lines[0].allocated.map((a) => a.assetCode), ['FX9-02'],
      'FX9-02 (41 days since service) over FX9-01 (120)')
    assert.equal(v.assetReservations.length, 3)
    assert.equal(v.itemCount, 3)
  })

  test('the calendar month of B#1 shows it confirmed on its days, and December is shaded', () => {
    const start = byNo(1).customerStartMs
    const d = new Date(start)
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime()
    const days = calendar(db, monthStart, NOW)
    const day = days.find((x) => x.dayMs <= start && start < x.dayMs + DAY_MS)
    assert.ok(day.confirmed.some((b) => b.bookingNo === 1))
    assert.ok(!days.some((x) => x.pencilled.some((b) => b.bookingNo === 4)), 'the dead pencil never draws')

    const dec = new Date(byNo(6).customerStartMs)
    const decDays = calendar(db, new Date(dec.getFullYear(), 11, 1).getTime(), NOW)
    assert.equal(decDays.length, 31)
    assert.ok(decDays.every((x) => x.season === 'wedding'))
    assert.ok(decDays[19].confirmed.some((b) => b.bookingNo === 6), 'the 20th carries the shaadi')
  })
})

describe('numbering (D12)', () => {
  test('the local counter continues gapless after the seed, and a refusal burns nothing', () => {
    const refused = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(40, 9), endMs: atDays(41, 9), lines: [], status: 'pencil',
    }, NOW, ids)
    assert.equal(refused.ok, false)
    assert.equal(refused.reason, 'no_lines')

    const a = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(40, 9), endMs: atDays(41, 9),
      lines: [{ productId: 'prod-ronin', qty: 1 }], status: 'pencil',
    }, NOW, ids)
    const b = createBooking(db, ORG, {
      customerId: 'cust-imran', startMs: atDays(40, 9), endMs: atDays(41, 9),
      lines: [{ productId: 'prod-ronin', qty: 1 }], status: 'draft',
    }, NOW, ids)
    assert.equal(a.bookingNo, 7)
    assert.equal(b.bookingNo, 8)
    assert.equal(a.status, 'pencil')
    assert.equal(b.status, 'draft')
    assert.equal(b.pencilExpiresAtMs, null, 'a draft holds nothing and never expires')
  })

  test('a pencil dies 24h out by default, and the blocked window wears the buffers', () => {
    const r = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(40, 10), endMs: atDays(41, 10),
      lines: [{ productId: 'prod-ronin', qty: 1 }], status: 'pencil',
    }, NOW, ids)
    assert.equal(r.pencilExpiresAtMs, NOW + 24 * HOUR_MS)
    assert.equal(r.blockedStartMs, atDays(40, 8))
    assert.equal(r.blockedEndMs, atDays(41, 14))
  })
})

describe('pencil expiry (D7)', () => {
  test('the dead pencil is pruned by the next write, with the server\'s reason', () => {
    assert.equal(byNo(4).status, 'pencil', 'before any write: still a pencil row')
    createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(40, 9), endMs: atDays(41, 9),
      lines: [{ productId: 'prod-ronin', qty: 1 }], status: 'draft',
    }, NOW, ids)
    const b4 = byNo(4)
    assert.equal(b4.status, 'cancelled')
    assert.equal(b4.cancelReason, 'pencil_expired')
    assert.equal(b4.stamp, 'cancelled')
  })

  test('pruning is explicit too, and counts what it killed', () => {
    assert.equal(pruneExpiredPencils(db, NOW), 1)
    assert.equal(pruneExpiredPencils(db, NOW), 0)
    // Move the clock past B#3's expiry: it dies too.
    assert.equal(pruneExpiredPencils(db, NOW + 6 * HOUR_MS), 1)
  })
})

describe('confirm (D4, D5, D9)', () => {
  test('a demanded unit already promised is refused BY NAME', () => {
    // FX9-02 is bound to B#1 next week. Ask for exactly it, same dates.
    const b1 = byNo(1)
    const r = createBooking(db, ORG, {
      customerId: 'cust-bilal', startMs: b1.customerStartMs, endMs: b1.customerEndMs,
      lines: [{ assetId: 'asset-fx9-2' }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(r.ok, false)
    assert.deepEqual(r.collision, {
      assetId: 'asset-fx9-2', assetCode: 'FX9-02',
      bookingId: 'bk-1', bookingNo: 1, customerName: 'Hamza Saeed',
    })
    assert.equal(r.bookingNo, 7, 'the pencil stands, numbered')
    assert.equal(byNo(7).stamp, 'pencil')
  })

  test('auto-allocation skips the held unit and takes the other; two is a shortfall', () => {
    const b1 = byNo(1)
    const one = createBooking(db, ORG, {
      customerId: 'cust-bilal', startMs: b1.customerStartMs, endMs: b1.customerEndMs,
      lines: [{ productId: 'prod-fx9', qty: 1 }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(one.ok, true)
    assert.deepEqual(one.confirm.allocations.map((a) => a.assetCode), ['FX9-01'])

    const two = createBooking(db, ORG, {
      customerId: 'cust-bilal', startMs: b1.customerStartMs, endMs: b1.customerEndMs,
      lines: [{ productId: 'prod-fx9', qty: 1 }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(two.ok, false)
    assert.equal(two.reason, 'short')
    assert.deepEqual(two.short, {
      productId: 'prod-fx9', productName: 'Sony FX9', wanted: 1, available: 0, winner: null,
    })
  })

  test('back-to-back with B#1 is legal — the buffers touch, they do not overlap', () => {
    const b1 = byNo(1)
    // B#1's hold ends 18:00 + 4h = 22:00; a hold starting 22:00 needs a
    // customer start of 00:00 the next day (2h prep).
    const r = createBooking(db, ORG, {
      customerId: 'cust-bilal', startMs: b1.blockedEndMs + 2 * HOUR_MS, endMs: b1.blockedEndMs + 26 * HOUR_MS,
      lines: [{ assetId: 'asset-fx9-2' }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(r.ok, true)
    const earlier = createBooking(db, ORG, {
      customerId: 'cust-bilal', startMs: b1.blockedEndMs + HOUR_MS, endMs: b1.blockedEndMs + 26 * HOUR_MS,
      lines: [{ assetId: 'asset-fx9-2' }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(earlier.ok, false)
    assert.equal(earlier.collision.bookingNo, 1)
  })

  test('the credential gate: a stranger over the threshold is refused, honestly', () => {
    // Ayesha has no paperwork on file; an FX9 is Rs 3.5M replacement.
    const r = createBooking(db, ORG, {
      customerId: 'cust-ayesha', startMs: atDays(40, 9), endMs: atDays(41, 9),
      lines: [{ productId: 'prod-fx9', qty: 1 }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'needs_credentials')
    assert.equal(r.exposureMinor, 3_500_000 * 100)
    assert.equal(r.thresholdMinor, 10_000_000)
    assert.equal(r.gate, 'local_flag', 'says it read one local flag, not the server\'s view')
    assert.equal(byNo(7).stamp, 'pencil', 'the pencil stands')

    // A manager's note opens the door and is logged on the op.
    const ok = confirmBooking(db, ORG, r.bookingId, { credentialOverrideNote: 'Guarantor seen, Haji Saab' }, NOW, ids)
    assert.equal(ok.ok, true)
    assert.equal(ok.credentialGate, 'overridden')
    const op = db.get(`select payload from outbox where op = 'confirm_booking' order by seq desc limit 1`)
    assert.equal(JSON.parse(op.payload).p_credential_override_note, 'Guarantor seen, Haji Saab')
  })

  test('a verified regular passes the gate; a cheap ask never meets it', () => {
    const hamza = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(40, 9), endMs: atDays(41, 9),
      lines: [{ productId: 'prod-fx9', qty: 1 }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(hamza.ok, true)
    assert.equal(hamza.confirm.credentialGate, 'not_needed')
    const cable = createBooking(db, ORG, {
      customerId: 'cust-ayesha', startMs: atDays(40, 9), endMs: atDays(41, 9),
      lines: [{ productId: 'prod-xlr', qty: 2 }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(cable.ok, true, 'Rs 16,000 of cable is under the threshold')
  })

  test('a blacklisted customer can pencil but never confirm; twice-confirm and cancelled refuse', () => {
    db.exec(`update customers set blacklisted = 1 where id = 'cust-imran'`)
    const r = createBooking(db, ORG, {
      customerId: 'cust-imran', startMs: atDays(40, 9), endMs: atDays(41, 9),
      lines: [{ productId: 'prod-ronin', qty: 1 }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'blacklisted')
    assert.equal(byNo(7).stamp, 'pencil')

    assert.equal(confirmBooking(db, ORG, 'bk-1', {}, NOW, ids).reason, 'already_confirmed')
    cancelBooking(db, 'bk-2', 'client moved the shoot', NOW, ids)
    assert.equal(confirmBooking(db, ORG, 'bk-2', {}, NOW, ids).reason, 'cancelled')
    assert.equal(confirmBooking(db, ORG, 'nope', {}, NOW, ids).reason, 'not_found')
  })

  test('the hold can be shortened at confirm, never below the customer window', () => {
    const p = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(40, 10), endMs: atDays(41, 10),
      lines: [{ productId: 'prod-ronin', qty: 1 }], status: 'pencil',
    }, NOW, ids)
    const tooShort = confirmBooking(db, ORG, p.bookingId,
      { blockedPeriod: { startMs: atDays(40, 11), endMs: atDays(41, 10) } }, NOW, ids)
    assert.equal(tooShort.reason, 'blocked_period_uncovers_customer')
    const exact = confirmBooking(db, ORG, p.bookingId,
      { blockedPeriod: { startMs: atDays(40, 10), endMs: atDays(41, 10) } }, NOW, ids)
    assert.equal(exact.ok, true)
    assert.equal(exact.blockedEndMs, atDays(41, 10))
    const v = bookingView(db, p.bookingId, NOW)
    assert.equal(v.blockedEndMs, atDays(41, 10))
    assert.equal(v.assetReservations[0].blockedEndMs, atDays(41, 10), 'the claim wears the shortened hold')
  })
})

describe('extension (D10)', () => {
  test('past B#5 the list names it — booking, unit, customer — and nothing changes', () => {
    const b5 = byNo(5)
    const r = extendBooking(db, 'bk-1', b5.customerStartMs + HOUR_MS, NOW, ids)
    assert.equal(r.extended, false)
    assert.equal(r.bookingNo, 1)
    assert.equal(r.collisions.length, 1)
    const c = r.collisions[0]
    assert.equal(c.kind, 'asset')
    assert.equal(c.bookingNo, 5)
    assert.equal(c.customerName, 'Bilal Hussain')
    assert.equal(c.assetCode, 'FX9-02')
    assert.equal(c.productName, 'Sony FX9')
    assert.equal(byNo(1).customerEndMs, atDays(9, 18), 'untouched')
    assert.equal(db.get(`select count(*) as n from outbox where op = 'extend_booking'`).n, 0, 'no op queued for a refusal')
  })

  test('a clear extension moves the customer end, the hold and every claim', () => {
    const r = extendBooking(db, 'bk-1', atDays(12, 18), NOW, ids)
    assert.equal(r.extended, true)
    assert.equal(r.customerEndMs, atDays(12, 18))
    assert.equal(r.blockedEndMs, atDays(12, 22), 'the 4h tail is preserved')
    const v = bookingView(db, 'bk-1', NOW)
    assert.equal(v.customerEndMs, atDays(12, 18))
    assert.ok(v.assetReservations.every((x) => x.blockedEndMs === atDays(12, 22)))
    const op = db.get(`select payload from outbox where op = 'extend_booking'`)
    assert.equal(JSON.parse(op.payload).p_new_customer_end, new Date(atDays(12, 18)).toISOString())
  })

  test('a cancelled booking and an end before the start are refused as results', () => {
    assert.equal(extendBooking(db, 'bk-1', atDays(6, 9), NOW, ids).reason, 'ends_before_start')
    cancelBooking(db, 'bk-2', null, NOW, ids)
    assert.equal(extendBooking(db, 'bk-2', atDays(20, 9), NOW, ids).reason, 'cancelled')
  })
})

describe('convert to job (D8)', () => {
  test('the confirmed booking lands on the Today board with the units confirm bound', () => {
    const before = openJobs(db).length
    const r = convertBookingToJob(db, ORG, 'bk-1', NOW, ids)
    assert.equal(r.ok, true)
    assert.equal(r.expected, 3)
    const job = openJob(db, r.jobId)
    assert.equal(job.label, 'B#1 — Hamza Saeed')
    assert.equal(job.customer.name, 'Hamza Saeed')
    assert.equal(job.contact, '0321 8899001')
    assert.deepEqual(job.expected.sort(), ['asset-aputure600-1', 'asset-aputure600-2', 'asset-fx9-2'])
    assert.equal(openJobs(db).length, before + 1, 'on the board')
    assert.deepEqual(byNo(1).job, { id: r.jobId, label: 'B#1 — Hamza Saeed', status: 'open' })

    assert.equal(convertBookingToJob(db, ORG, 'bk-1', NOW, ids).reason, 'already_has_job')
    const cancel = cancelBooking(db, 'bk-1', 'oops', NOW, ids)
    assert.equal(cancel.reason, 'job_open')
    assert.equal(cancel.jobLabel, 'B#1 — Hamza Saeed')
  })

  test('only a confirmed booking becomes a job', () => {
    assert.equal(convertBookingToJob(db, ORG, 'bk-3', NOW, ids).reason, 'not_confirmed')
    assert.equal(convertBookingToJob(db, ORG, 'nope', NOW, ids).reason, 'not_found')
  })
})

describe('availability over the seeded calendar (D6)', () => {
  test('FX9 next week: two bodies, one promised, one free', () => {
    const b1 = byNo(1)
    const a = availabilityFor(db, 'prod-fx9', b1.blockedStartMs, b1.blockedEndMs, NOW)
    assert.deepEqual(a, { trackingMode: 'serialized', hereNow: 2, pencilledOverlap: 0, confirmedOverlap: 1, available: 1 })
  })

  test('C300 over the live pencil: reported, never subtracted', () => {
    const b3 = byNo(3)
    const a = availabilityFor(db, 'prod-c300', b3.blockedStartMs, b3.blockedEndMs, NOW)
    assert.equal(a.pencilledOverlap, 1)
    assert.equal(a.available, 2)
  })

  test('the expired pencil on the Komodo counts for nothing', () => {
    const b4 = byNo(4)
    assert.equal(availabilityFor(db, 'prod-komodo', b4.blockedStartMs, b4.blockedEndMs, NOW).pencilledOverlap, 0)
  })

  test('FX6-03 — out today and promised next month — warns the scanner only inside the horizon', () => {
    assert.equal(promisedSoon(db, 'asset-fx6-3', NOW), null)
    const b5 = byNo(5)
    assert.equal(promisedSoon(db, 'asset-fx6-3', b5.blockedStartMs - DAY_MS).bookingNo, 5)
  })
})

describe('the outbox ops', () => {
  test('every write queues its RPC op, p_*-shaped and chained per booking', () => {
    const r = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(40, 10), endMs: atDays(41, 10),
      lines: [{ productId: 'prod-ronin', qty: 1 }, { assetId: 'asset-fx9-1' }], status: 'confirmed', note: 'DHA',
    }, NOW, ids)
    assert.equal(r.ok, true)
    const ops = db.all(`select id, op, payload, depends_on from outbox order by seq`)
    assert.deepEqual(ops.map((o) => o.op), ['create_booking', 'confirm_booking'])
    const create = JSON.parse(ops[0].payload)
    assert.equal(create.client_booking_id, r.bookingId)
    assert.equal(create.p_customer_id, 'cust-hamza')
    assert.equal(create.p_customer_period, `["${new Date(atDays(40, 10)).toISOString()}","${new Date(atDays(41, 10)).toISOString()}")`)
    assert.deepEqual(create.p_lines, [{ product_id: 'prod-ronin', qty: 1 }, { asset_id: 'asset-fx9-1' }])
    assert.equal(create.p_status, 'pencil', 'the server insists: born a pencil, confirmed by the next op')
    assert.equal(create.p_note, 'DHA')
    assert.equal(create.p_pencil_ttl, '24 hours')
    assert.equal(ops[0].depends_on, null)
    assert.equal(ops[1].depends_on, ops[0].id, 'confirm waits for create')
    assert.equal(JSON.parse(ops[1].payload).p_booking_id, r.bookingId)

    cancelBooking(db, r.bookingId, 'changed their mind', NOW, ids)
    const cancel = db.get(`select payload, depends_on from outbox where op = 'cancel_booking'`)
    assert.equal(cancel.depends_on, ops[1].id, 'cancel waits for confirm')
    assert.deepEqual(JSON.parse(cancel.payload), { p_booking_id: r.bookingId, p_reason: 'changed their mind' })
  })

  test('convert queues its op with the client job id', () => {
    const r = convertBookingToJob(db, ORG, 'bk-1', NOW, ids)
    const op = db.get(`select payload from outbox where op = 'convert_booking_to_job'`)
    assert.deepEqual(JSON.parse(op.payload), { p_booking_id: 'bk-1', client_job_id: r.jobId })
  })
})

describe('the confirmation text', () => {
  const fixed = () => {
    const start = new Date(2030, 3, 1, 10, 0).getTime()   // Mon 1 Apr 2030
    const end = new Date(2030, 3, 3, 18, 0).getTime()     // Wed 3 Apr 2030
    const r = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: start, endMs: end,
      lines: [{ productId: 'prod-fx6', qty: 2 }, { assetId: 'asset-ronin-1' }],
      status: 'confirmed', note: 'Baraat at 8pm',
    }, NOW, ids)
    assert.equal(r.ok, true)
    return r.bookingId
  }

  test('English, golden', () => {
    const id = fixed()
    assert.equal(bookingDateLabel(new Date(2030, 3, 1, 10, 0).getTime()), 'Mon 1 Apr, 10:00')
    assert.equal(bookingConfirmText(db, STR_EN, seed.houseName, id, NOW), [
      'Ravi Light & Grip — booking confirmed',
      'Booking #7',
      'For: Hamza Saeed',
      'From Mon 1 Apr, 10:00 to Wed 3 Apr, 18:00',
      '',
      'Items:',
      '2x Sony FX6',
      '1x DJI Ronin RS3 Pro RS3-01',
      '',
      'Note: Baraat at 8pm',
      '',
      'Reply here to change anything. Thank you.',
    ].join('\n'))
  })

  test('Roman Urdu, golden', () => {
    const id = fixed()
    assert.equal(bookingConfirmText(db, STR_UR, seed.houseName, id, NOW), [
      'Ravi Light & Grip — booking pakki',
      'Booking #7',
      'Naam: Hamza Saeed',
      'Mon 1 Apr, 10:00 se Wed 3 Apr, 18:00 tak',
      '',
      'Samaan:',
      '2x Sony FX6',
      '1x DJI Ronin RS3 Pro RS3-01',
      '',
      'Note: Baraat at 8pm',
      '',
      'Kuch badalna ho to yahin reply karein. Shukriya.',
    ].join('\n'))
  })

  test('a pencil has no confirmation to send', () => {
    assert.equal(bookingConfirmText(db, STR_EN, seed.houseName, 'bk-3', NOW), null)
    assert.equal(bookingConfirmText(db, STR_EN, seed.houseName, 'nope', NOW), null)
  })
})

// ---------------------------------------------------------------- W5b doors

describe('the confirm preview (the Confirm sheet)', () => {
  test('the plan names the units confirm will bind, and the commit binds exactly them', () => {
    const c = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(14, 10), endMs: atDays(15, 10),
      lines: [{ productId: 'prod-fx9', qty: 1 }, { productId: 'prod-ronin', qty: 1 }], status: 'pencil',
    }, NOW, ids)
    const plan = planConfirm(db, c.bookingId, {}, NOW)
    assert.equal(plan.ok, true)
    assert.deepEqual(plan.plan.map((p) => p.assetCode).sort(), ['FX9-02', 'RS3-01'].sort())
    assert.equal(plan.needsCredentials, false)
    // Same-day turnaround: the hold is exactly the customer window.
    const tight = planConfirm(db, c.bookingId, { blockedPeriod: { startMs: atDays(14, 10), endMs: atDays(15, 10) } }, NOW)
    assert.equal(tight.blockedStartMs, atDays(14, 10))
    assert.equal(tight.blockedEndMs, atDays(15, 10))
    const r = confirmBooking(db, ORG, c.bookingId, {}, NOW, ids)
    assert.equal(r.ok, true)
    assert.deepEqual(r.allocations.map((a) => a.assetCode).sort(), plan.plan.map((p) => p.assetCode).sort())
    assert.equal(db.get(`select count(*) as n from outbox where op = 'confirm_booking'`).n, 1, 'a preview writes nothing; the commit writes once')
  })

  test('the preview says needs_credentials for a stranger; the note turns it into a plan', () => {
    const c = createBooking(db, ORG, {
      customerId: 'cust-ayesha', startMs: atDays(14, 10), endMs: atDays(15, 10),
      lines: [{ productId: 'prod-fx9', qty: 1 }], status: 'pencil',
    }, NOW, ids)
    const gate = planConfirm(db, c.bookingId, {}, NOW)
    assert.equal(gate.ok, false)
    assert.equal(gate.reason, 'needs_credentials')
    const over = planConfirm(db, c.bookingId, { credentialOverrideNote: 'known through Bilal' }, NOW)
    assert.equal(over.ok, true)
    assert.equal(over.needsCredentials, true)
  })
})

describe('the substitute door (reallocate_reservation)', () => {
  const b5Reservation = () =>
    db.get(`select id from asset_reservations where booking_id = 'bk-5' and asset_id = 'asset-fx9-2'`).id

  test('moves the rival claim onto a free unit of the same product, and the extension goes clean', () => {
    const reservationId = b5Reservation()
    const subs = substitutesForReservation(db, reservationId)
    assert.deepEqual(subs.map((s) => s.code), ['FX9-01'], 'FX9-01 is free next month; FX9-02 is the unit itself')
    const r = reallocateReservation(db, reservationId, 'asset-fx9-1', NOW, ids, 'bk-1')
    assert.equal(r.ok, true)
    assert.equal(r.assetCode, 'FX9-01')
    assert.deepEqual(bookingView(db, 'bk-5', NOW).lines[0].allocated.map((a) => a.assetCode), ['FX9-01'])
    // B#1's extension past B#5 no longer breaks anything.
    const b5 = byNo(5)
    assert.deepEqual(extensionPreview(db, 'bk-1', b5.customerStartMs + HOUR_MS, NOW).collisions, [])
    const ext = extendBooking(db, 'bk-1', b5.customerStartMs + HOUR_MS, NOW, ids)
    assert.equal(ext.extended, true)
    // The ops: the move is chained under B#5 AND names B#1, so B#1's
    // extend replays after it.
    const ops = db.all(`select id, op, payload, depends_on from outbox order by seq`)
    assert.deepEqual(ops.map((o) => o.op), ['reallocate_reservation', 'extend_booking'])
    const move = JSON.parse(ops[0].payload)
    assert.equal(move.p_reservation_id, reservationId)
    assert.equal(move.p_new_asset_id, 'asset-fx9-1')
    assert.equal(move.client_booking_id, 'bk-5')
    assert.equal(move.for_booking_id, 'bk-1')
    assert.equal(ops[1].depends_on, ops[0].id, 'the extension waits for the move')
  })

  test('a unit already promised over the window is refused by name; wrong product refused', () => {
    // Hold FX9-01 next month first, then try to move B#5 onto it.
    const c = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(30, 9), endMs: atDays(31, 9),
      lines: [{ assetId: 'asset-fx9-1' }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(c.ok, true)
    const r = reallocateReservation(db, b5Reservation(), 'asset-fx9-1', NOW, ids)
    assert.equal(r.ok, false)
    assert.equal(r.collision.bookingNo, c.bookingNo)
    assert.equal(r.collision.assetCode, 'FX9-01')
    assert.deepEqual(substitutesForReservation(db, b5Reservation()), [], 'nothing free to offer')
    assert.equal(reallocateReservation(db, b5Reservation(), 'asset-fx6-1', NOW, ids).reason, 'different_product')
    // A booking's own other claim: "give them the body they already have"
    // is not a substitution, and the picker never offers it.
    const two = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: atDays(50, 9), endMs: atDays(51, 9),
      lines: [{ productId: 'prod-fx9', qty: 2 }], status: 'confirmed',
    }, NOW, ids)
    const [claimA, claimB] = db.all(`select id, asset_id from asset_reservations where booking_id = ? order by rowid`, [two.bookingId])
    assert.equal(reallocateReservation(db, claimA.id, claimB.asset_id, NOW, ids).reason, 'already_held')
    assert.ok(!substitutesForReservation(db, claimA.id).some((s) => s.id === claimB.asset_id))
    assert.equal(reallocateReservation(db, 'nope', 'asset-fx9-1', NOW, ids).reason, 'not_found')
    assert.deepEqual(bookingView(db, 'bk-5', NOW).lines[0].allocated.map((a) => a.assetCode), ['FX9-02'], 'nothing moved')
  })
})

describe('the sub-rent door (intent, then the extension behind it)', () => {
  test('the note lands on the booking, the op queues, and the acknowledged extension writes behind it', () => {
    const b5 = byNo(5)
    const preview = extensionPreview(db, 'bk-1', b5.customerStartMs + HOUR_MS, NOW)
    assert.equal(preview.collisions.length, 1)
    const c = preview.collisions[0]
    const noted = noteSubRent(db, 'bk-1', {
      productId: c.productId, productName: c.productName, qty: 1,
      forBookingId: c.bookingId, forBookingNo: c.bookingNo,
    }, STR_EN, NOW, ids)
    assert.equal(noted.ok, true)
    assert.equal(bookingView(db, 'bk-1', NOW).note, 'Mehndi + baraat, DHA\nSub-rent Sony FX9 ×1 for #5')
    // Not acknowledged: still refused, still named.
    const refused = extendBooking(db, 'bk-1', b5.customerStartMs + HOUR_MS, NOW, ids)
    assert.equal(refused.extended, false)
    assert.equal(refused.collisions[0].bookingNo, 5)
    // Acknowledged: written, chained behind the intent.
    const ext = extendBooking(db, 'bk-1', b5.customerStartMs + HOUR_MS, NOW, ids, { acknowledged: [c] })
    assert.equal(ext.extended, true)
    const ops = db.all(`select id, op, payload, depends_on from outbox order by seq`)
    assert.deepEqual(ops.map((o) => o.op), ['sub_rent_intent', 'extend_booking'])
    const intent = JSON.parse(ops[0].payload)
    assert.equal(intent.p_booking_id, 'bk-1')
    assert.equal(intent.p_for_booking_id, 'bk-5')
    assert.equal(intent.p_product_id, 'prod-fx9')
    assert.equal(intent.p_qty, 1)
    assert.equal(ops[1].depends_on, ops[0].id)
    // B#5's own claim on FX9-02 stands untouched — the intent moved nothing.
    assert.deepEqual(bookingView(db, 'bk-5', NOW).lines[0].allocated.map((a) => a.assetCode), ['FX9-02'])
  })
})

describe('the Today board reads', () => {
  test('the Promised strip: pencils dying today, confirmed starts inside 48h with no job yet', () => {
    const strip0 = promisedStrip(db, NOW)
    assert.deepEqual(strip0.pencilsToday.map((b) => b.bookingNo), [3], 'B#3 dies in ~5h; B#4 is dead already')
    assert.deepEqual(strip0.startingSoon, [], 'B#1 is a week out')
    const c = createBooking(db, ORG, {
      customerId: 'cust-hamza', startMs: NOW + 20 * HOUR_MS, endMs: NOW + 40 * HOUR_MS,
      lines: [{ productId: 'prod-ronin', qty: 1 }], status: 'confirmed',
    }, NOW, ids)
    assert.equal(c.ok, true)
    assert.deepEqual(promisedStrip(db, NOW).startingSoon.map((b) => b.bookingNo), [c.bookingNo])
    convertBookingToJob(db, ORG, c.bookingId, NOW, ids)
    assert.deepEqual(promisedStrip(db, NOW).startingSoon, [], 'once it is a job, the board already shows it')
    // The pencil strip is a predicate over the stored expiry: at midnight it is empty.
    const midnight = new Date(new Date(NOW).getFullYear(), new Date(NOW).getMonth(), new Date(NOW).getDate() + 1).getTime()
    assert.deepEqual(promisedStrip(db, midnight).pencilsToday, [])
  })

  test('the manager flag is written once and read back', () => {
    assert.equal(managerFlaggedAt(db, 'job-doc'), null)
    assert.equal(flagForManager(db, 'job-doc', NOW), true)
    const first = managerFlaggedAt(db, 'job-doc')
    assert.equal(first, new Date(NOW).toISOString())
    assert.equal(flagForManager(db, 'job-doc', NOW + HOUR_MS), true)
    assert.equal(managerFlaggedAt(db, 'job-doc'), first, 'a second tap does not move the time')
    assert.equal(flagForManager(db, 'no-such-job', NOW), false)
  })
})
