/**
 * The booking rules against a real SQLite — the 0022 semantics, on the
 * phone. What is pinned here is exactly what the server pins in
 * 0022_bookings_test.sql, because the two must agree:
 *
 *   * '[)' boundaries: back-to-back windows touch without colliding;
 *   * a pencil is reported and NEVER subtracted; an expired one stops
 *     counting by the predicate alone;
 *   * bulk capacity is a PEAK, not a sum;
 *   * the extension-collision list names the winner, per asset and per
 *     bulk shortfall; a pencil collides with nothing;
 *   * promisedSoon warns for confirmed holds inside the horizon only;
 *   * the season edges and the ladder rungs.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '../src/db/node-driver.ts'
import { LOCAL_SCHEMA } from '../src/db/schema.ts'
import {
  DEFAULT_BOOKING_SETTINGS, ESCALATION_LADDER, HOUR_MS, DAY_MS,
  blockedPeriod, isLivePencil, pencilCountdown, overlaps, peakOverlap,
  bookingAvailability, extensionCollisions, promisedSoon, seasonFor,
  escalationStep, loadBooking, loadLines,
} from '../src/bookings.ts'

const ORG = 'org-1'
// A fixed clock: Thursday 10 Sep 2026, 09:00 local.
const NOW = new Date(2026, 8, 10, 9, 0).getTime()
const at = (dayOffset, hour = 10) => NOW + dayOffset * DAY_MS + (hour - 9) * HOUR_MS
const iso = (ms) => new Date(ms).toISOString()

let db
let n = 0
const id = (p) => `${p}-${++n}`

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  n = 0
  db.exec(`insert into products (id, org_id, display_name, category, tracking_mode)
           values ('p-fx9', ?, 'Sony FX9', 'camera', 'serialized'),
                  ('p-xlr', ?, 'XLR Cable 5m', 'cable', 'bulk')`, [ORG, ORG])
  for (const code of ['FX9-01', 'FX9-02', 'FX9-03']) {
    db.exec(`insert into assets (id, org_id, product_id, asset_code, presence, rentable)
             values (?, ?, 'p-fx9', ?, 'here', 1)`, [`a-${code}`, ORG, code])
  }
  db.exec(`insert into stock_lots (id, org_id, product_id, location_id, qty_on_hand)
           values ('lot-xlr', ?, 'p-xlr', null, 10)`, [ORG])
})

/** A booking in the mirror, with its blocked window from the defaults. */
function booking({ no, status, startMs, endMs, expiresMs = null, name = 'Client', blocked = null }) {
  const bid = id('bk')
  const b = blocked ?? blockedPeriod(startMs, endMs, DEFAULT_BOOKING_SETTINGS)
  db.exec(
    `insert into bookings (id, org_id, booking_no, customer_id, customer_name, status,
       customer_from, customer_until, blocked_from, blocked_until, pencil_expires_at)
     values (?, ?, ?, 'c-1', ?, ?, ?, ?, ?, ?, ?)`,
    [bid, ORG, no, name, status, iso(startMs), iso(endMs),
     iso(b.blockedStartMs), iso(b.blockedEndMs), expiresMs === null ? null : iso(expiresMs)],
  )
  return { id: bid, ...b }
}

function productLine(b, productId, qty) {
  const lid = id('ln')
  db.exec(`insert into booking_lines (id, org_id, booking_id, product_id, qty) values (?, ?, ?, ?, ?)`,
    [lid, ORG, b.id, productId, qty])
  return lid
}

function assetRes(b, lineId, assetId, state) {
  db.exec(
    `insert into asset_reservations (id, org_id, booking_id, booking_line_id, asset_id,
       blocked_from, blocked_until, state) values (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id('ar'), ORG, b.id, lineId, assetId, iso(b.blockedStartMs), iso(b.blockedEndMs), state],
  )
}

function stockRes(b, lineId, productId, qty, state) {
  db.exec(
    `insert into stock_reservations (id, org_id, booking_id, booking_line_id, product_id, qty,
       blocked_from, blocked_until, state) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id('sr'), ORG, b.id, lineId, productId, qty, iso(b.blockedStartMs), iso(b.blockedEndMs), state],
  )
}

describe('interval math', () => {
  test("'[)' — back-to-back 10:00/10:00 does not collide", () => {
    assert.equal(overlaps(at(1, 10), at(2, 10), at(2, 10), at(3, 10)), false)
    assert.equal(overlaps(at(1, 10), at(2, 11), at(2, 10), at(3, 10)), true)
    assert.equal(overlaps(at(2, 10), at(3, 10), at(1, 10), at(2, 10)), false)
  })

  test('peak overlap is the max simultaneous, not the sum', () => {
    // Two disjoint 4-unit claims inside the window: peak 4, never 8.
    assert.equal(peakOverlap([
      { startMs: at(1), endMs: at(2), qty: 4 },
      { startMs: at(3), endMs: at(4), qty: 4 },
    ], at(0), at(10)), 4)
    // Overlapping ones stack.
    assert.equal(peakOverlap([
      { startMs: at(1), endMs: at(3), qty: 4 },
      { startMs: at(2), endMs: at(4), qty: 3 },
    ], at(0), at(10)), 7)
    // Touching at one instant does not stack, and a claim outside the
    // window is invisible to it.
    assert.equal(peakOverlap([
      { startMs: at(1), endMs: at(2), qty: 4 },
      { startMs: at(2), endMs: at(3), qty: 5 },
      { startMs: at(20), endMs: at(21), qty: 9 },
    ], at(0), at(10)), 5)
    assert.equal(peakOverlap([], at(0), at(1)), 0)
  })

  test('the blocked window is customer ± the buffer defaults', () => {
    const b = blockedPeriod(at(1, 10), at(2, 10), DEFAULT_BOOKING_SETTINGS)
    assert.equal(b.blockedStartMs, at(1, 8))
    assert.equal(b.blockedEndMs, at(2, 14))
  })
})

describe('the pencil predicate', () => {
  test('live only while status is pencil and expiry is in the future', () => {
    assert.equal(isLivePencil({ status: 'pencil', pencilExpiresAtMs: NOW + 1 }, NOW), true)
    assert.equal(isLivePencil({ status: 'pencil', pencilExpiresAtMs: NOW }, NOW), false)
    assert.equal(isLivePencil({ status: 'pencil', pencilExpiresAtMs: NOW - 1 }, NOW), false)
    assert.equal(isLivePencil({ status: 'confirmed', pencilExpiresAtMs: NOW + 1 }, NOW), false)
    assert.equal(isLivePencil({ status: 'pencil', pencilExpiresAtMs: null }, NOW), false)
  })

  test('the countdown gives label-ready hours and minutes, never negative', () => {
    const c = pencilCountdown({ status: 'pencil', pencilExpiresAtMs: NOW + 5 * HOUR_MS + 7 * 60_000 }, NOW)
    assert.deepEqual(c, { expired: false, msLeft: 5 * HOUR_MS + 7 * 60_000, hours: 5, minutes: 7 })
    const gone = pencilCountdown({ status: 'pencil', pencilExpiresAtMs: NOW - HOUR_MS }, NOW)
    assert.deepEqual(gone, { expired: true, msLeft: 0, hours: 0, minutes: 0 })
  })
})

describe('serialized availability (D6)', () => {
  test('three layers: here-now, pencilled reported, confirmed subtracted', () => {
    const conf = booking({ no: 1, status: 'confirmed', startMs: at(3), endMs: at(5) })
    const line = productLine(conf, 'p-fx9', 1)
    assetRes(conf, line, 'a-FX9-01', 'confirmed')
    const pen = booking({ no: 2, status: 'pencil', startMs: at(3), endMs: at(4), expiresMs: NOW + HOUR_MS })
    productLine(pen, 'p-fx9', 2)

    const a = bookingAvailability(db, 'p-fx9', at(3), at(5), NOW)
    assert.equal(a.trackingMode, 'serialized')
    assert.equal(a.hereNow, 3)
    assert.equal(a.confirmedOverlap, 1)
    assert.equal(a.pencilledOverlap, 2, 'the pencil is reported…')
    assert.equal(a.available, 2, '…and never subtracted')
  })

  test('an expired pencil stops counting by the predicate alone', () => {
    const pen = booking({ no: 1, status: 'pencil', startMs: at(3), endMs: at(4), expiresMs: NOW - 1 })
    productLine(pen, 'p-fx9', 2)
    assert.equal(bookingAvailability(db, 'p-fx9', at(3), at(5), NOW).pencilledOverlap, 0)
    assert.equal(bookingAvailability(db, 'p-fx9', at(3), at(5), NOW - HOUR_MS).pencilledOverlap, 2,
      'an earlier clock still sees it live')
  })

  test('back-to-back windows do not count each other', () => {
    // Blocked windows touch exactly: first ends 14:00 day 2 (10:00 + 4h),
    // the asked-for window starts at 14:00 day 2.
    const conf = booking({ no: 1, status: 'confirmed', startMs: at(1, 10), endMs: at(2, 10) })
    const line = productLine(conf, 'p-fx9', 1)
    assetRes(conf, line, 'a-FX9-01', 'confirmed')
    assert.equal(bookingAvailability(db, 'p-fx9', at(2, 14), at(3, 10), NOW).confirmedOverlap, 0)
    assert.equal(bookingAvailability(db, 'p-fx9', at(2, 13), at(3, 10), NOW).confirmedOverlap, 1)
  })

  test('a unit out right now is not here for a window that starts now', () => {
    db.exec(`update assets set presence = 'out' where id = 'a-FX9-03'`)
    assert.equal(bookingAvailability(db, 'p-fx9', NOW - HOUR_MS, at(1), NOW).hereNow, 2)
    assert.equal(bookingAvailability(db, 'p-fx9', at(3), at(5), NOW).hereNow, 3,
      'a future window trusts the schedule')
  })

  test('gone, non-rentable and disposed units are not fleet', () => {
    db.exec(`update assets set presence = 'gone', disposition = 'lost' where id = 'a-FX9-03'`)
    db.exec(`update assets set rentable = 0 where id = 'a-FX9-02'`)
    assert.equal(bookingAvailability(db, 'p-fx9', at(3), at(5), NOW).hereNow, 1)
  })
})

describe('bulk availability (D6)', () => {
  test('confirmed peak is subtracted from stock on hand; pencil peak is reported', () => {
    const c1 = booking({ no: 1, status: 'confirmed', startMs: at(1), endMs: at(2) })
    stockRes(c1, productLine(c1, 'p-xlr', 4), 'p-xlr', 4, 'confirmed')
    const c2 = booking({ no: 2, status: 'confirmed', startMs: at(4), endMs: at(5) })
    stockRes(c2, productLine(c2, 'p-xlr', 5), 'p-xlr', 5, 'confirmed')
    const pen = booking({ no: 3, status: 'pencil', startMs: at(1), endMs: at(5), expiresMs: NOW + HOUR_MS })
    stockRes(pen, productLine(pen, 'p-xlr', 6), 'p-xlr', 6, 'pencil')

    const a = bookingAvailability(db, 'p-xlr', at(0), at(6), NOW)
    assert.equal(a.trackingMode, 'bulk')
    assert.equal(a.hereNow, 10)
    assert.equal(a.confirmedOverlap, 5, 'disjoint claims count at their max, not 9')
    assert.equal(a.pencilledOverlap, 6)
    assert.equal(a.available, 5)
  })

  test('a cancelled booking\'s claims are ignored even if a row lingers', () => {
    const c1 = booking({ no: 1, status: 'cancelled', startMs: at(1), endMs: at(2) })
    stockRes(c1, productLine(c1, 'p-xlr', 4), 'p-xlr', 4, 'confirmed')
    assert.equal(bookingAvailability(db, 'p-xlr', at(0), at(6), NOW).confirmedOverlap, 0)
  })
})

describe('extension collisions (D10)', () => {
  test('no downstream promise → an empty list', () => {
    const mine = booking({ no: 1, status: 'confirmed', startMs: at(1), endMs: at(2) })
    assetRes(mine, productLine(mine, 'p-fx9', 1), 'a-FX9-01', 'confirmed')
    assert.deepEqual(extensionCollisions(db, mine.id, at(3), NOW), [])
  })

  test('names exactly the booking, unit and customer the new end breaks', () => {
    const mine = booking({ no: 1, status: 'confirmed', startMs: at(1), endMs: at(2), name: 'Me' })
    assetRes(mine, productLine(mine, 'p-fx9', 1), 'a-FX9-01', 'confirmed')
    const theirs = booking({ no: 2, status: 'confirmed', startMs: at(4), endMs: at(5), name: 'Rafi Productions' })
    assetRes(theirs, productLine(theirs, 'p-fx9', 1), 'a-FX9-01', 'confirmed')
    const other = booking({ no: 3, status: 'confirmed', startMs: at(4), endMs: at(5), name: 'Unrelated' })
    assetRes(other, productLine(other, 'p-fx9', 1), 'a-FX9-02', 'confirmed')

    // Extending to day 3 10:00 — blocked tail ends 14:00 day 3, theirs
    // begins 08:00 day 4: still clear.
    assert.deepEqual(extensionCollisions(db, mine.id, at(3, 10), NOW), [])
    // To day 4 10:00 — now the tails overlap.
    const cs = extensionCollisions(db, mine.id, at(4, 10), NOW)
    assert.equal(cs.length, 1)
    assert.equal(cs[0].kind, 'asset')
    assert.equal(cs[0].bookingNo, 2)
    assert.equal(cs[0].customerName, 'Rafi Productions')
    assert.equal(cs[0].assetCode, 'FX9-01')
    assert.equal(cs[0].productName, 'Sony FX9')
    assert.equal(cs[0].theirFromMs, theirs.blockedStartMs)
  })

  test('the bulk shortfall names every rival and says how short', () => {
    const mine = booking({ no: 1, status: 'confirmed', startMs: at(1), endMs: at(2) })
    stockRes(mine, productLine(mine, 'p-xlr', 6), 'p-xlr', 6, 'confirmed')
    const theirs = booking({ no: 2, status: 'confirmed', startMs: at(3), endMs: at(4), name: 'Zindagi Films' })
    stockRes(theirs, productLine(theirs, 'p-xlr', 7), 'p-xlr', 7, 'confirmed')

    const cs = extensionCollisions(db, mine.id, at(3, 12), NOW)
    assert.equal(cs.length, 1)
    assert.equal(cs[0].kind, 'bulk')
    assert.equal(cs[0].bookingNo, 2)
    assert.equal(cs[0].customerName, 'Zindagi Films')
    assert.equal(cs[0].qty, 7)
    assert.equal(cs[0].wanted, 6)
    assert.equal(cs[0].shortBy, 3, '10 on hand − 7 theirs = 3 free, 6 wanted')
  })

  test('a pencil collides with nothing — it holds nothing', () => {
    const pen = booking({ no: 1, status: 'pencil', startMs: at(1), endMs: at(2), expiresMs: NOW + HOUR_MS })
    assetRes(pen, productLine(pen, 'p-fx9', 1), 'a-FX9-01', 'pencil')
    const theirs = booking({ no: 2, status: 'confirmed', startMs: at(2), endMs: at(3) })
    assetRes(theirs, productLine(theirs, 'p-fx9', 1), 'a-FX9-01', 'confirmed')
    assert.deepEqual(extensionCollisions(db, pen.id, at(9), NOW), [])
  })

  test('a shortened buffer tail survives the extension', () => {
    const mine = booking({
      no: 1, status: 'confirmed', startMs: at(1, 10), endMs: at(2, 10),
      blocked: { blockedStartMs: at(1, 10), blockedEndMs: at(2, 10) },   // no tail
    })
    assetRes(mine, productLine(mine, 'p-fx9', 1), 'a-FX9-01', 'confirmed')
    const theirs = booking({ no: 2, status: 'confirmed', startMs: at(4, 12), endMs: at(5) })
    assetRes(theirs, productLine(theirs, 'p-fx9', 1), 'a-FX9-01', 'confirmed')
    // With the default 4h tail an end at 10:00 day 4 would reach 14:00 and
    // collide with a hold beginning 10:00; with no tail it stops at 10:00.
    assert.deepEqual(extensionCollisions(db, mine.id, at(4, 10), NOW), [])
  })
})

describe('promised soon', () => {
  test('a confirmed hold inside the horizon warns; a pencil never does', () => {
    const soon = booking({ no: 7, status: 'confirmed', startMs: at(1, 10), endMs: at(2), name: 'Rafi Productions' })
    assetRes(soon, productLine(soon, 'p-fx9', 1), 'a-FX9-01', 'confirmed')
    const pen = booking({ no: 8, status: 'pencil', startMs: at(0, 12), endMs: at(1), expiresMs: NOW + HOUR_MS })
    assetRes(pen, productLine(pen, 'p-fx9', 1), 'a-FX9-02', 'pencil')

    const w = promisedSoon(db, 'a-FX9-01', NOW)
    assert.equal(w.bookingNo, 7)
    assert.equal(w.customerName, 'Rafi Productions')
    assert.equal(w.startsInMs, soon.blockedStartMs - NOW)
    assert.equal(promisedSoon(db, 'a-FX9-02', NOW), null)
  })

  test('the horizon: 48h by default, injectable', () => {
    const far = booking({ no: 1, status: 'confirmed', startMs: at(3, 10), endMs: at(4) })
    assetRes(far, productLine(far, 'p-fx9', 1), 'a-FX9-01', 'confirmed')
    assert.equal(promisedSoon(db, 'a-FX9-01', NOW), null, 'day-3 hold is beyond 48h')
    assert.equal(promisedSoon(db, 'a-FX9-01', NOW, 4 * DAY_MS).bookingNo, 1)
    assert.equal(promisedSoon(db, 'a-FX9-01', NOW + DAY_MS).bookingNo, 1, 'a day later it is inside')
  })

  test('a hold already under way warns with a non-positive startsIn; a finished one does not', () => {
    const now = booking({ no: 1, status: 'confirmed', startMs: NOW - HOUR_MS, endMs: at(1) })
    assetRes(now, productLine(now, 'p-fx9', 1), 'a-FX9-01', 'confirmed')
    assert.ok(promisedSoon(db, 'a-FX9-01', NOW).startsInMs <= 0)
    assert.equal(promisedSoon(db, 'a-FX9-01', at(2)), null)
  })
})

describe('season and the ladder', () => {
  test('Dec–Feb is wedding season; the edges are month boundaries', () => {
    assert.equal(seasonFor(new Date(2026, 11, 1).getTime()), 'wedding')
    assert.equal(seasonFor(new Date(2027, 1, 28, 23, 59).getTime()), 'wedding')
    assert.equal(seasonFor(new Date(2027, 2, 1, 0, 0).getTime()), 'normal')
    assert.equal(seasonFor(new Date(2026, 10, 30, 23, 59).getTime()), 'normal')
    assert.equal(seasonFor(new Date(2027, 0, 15).getTime()), 'wedding')
  })

  test('the rungs: 1 nudge, 3 call, 7 late fee, 14 manager + blacklist', () => {
    assert.equal(escalationStep(0), null)
    assert.equal(escalationStep(1).action, 'whatsapp_nudge')
    assert.equal(escalationStep(2).step, 1)
    assert.equal(escalationStep(3).action, 'call')
    assert.equal(escalationStep(6).step, 2)
    assert.equal(escalationStep(7).action, 'late_fee_draft')
    assert.equal(escalationStep(13).step, 3)
    assert.equal(escalationStep(14).action, 'manager_escalation')
    assert.equal(escalationStep(14).considerBlacklist, true)
    assert.equal(escalationStep(90).step, 4)
    assert.equal(ESCALATION_LADDER.filter((r) => r.considerBlacklist).length, 1)
  })
})

describe('mirror readers', () => {
  test('a booking round-trips with epoch-ms periods and a demanded line reads its product mode', () => {
    const b = booking({ no: 3, status: 'pencil', startMs: at(1), endMs: at(2), expiresMs: NOW + HOUR_MS })
    db.exec(`insert into booking_lines (id, org_id, booking_id, asset_id, qty) values ('ln-x', ?, ?, 'a-FX9-02', 1)`, [ORG, b.id])
    productLine(b, 'p-xlr', 4)
    const loaded = loadBooking(db, b.id)
    assert.equal(loaded.bookingNo, 3)
    assert.equal(loaded.customerStartMs, at(1))
    assert.equal(loaded.blockedEndMs, b.blockedEndMs)
    assert.equal(loaded.pencilExpiresAtMs, NOW + HOUR_MS)
    const lines = loadLines(db, b.id)
    assert.equal(lines[0].trackingMode, 'serialized')
    assert.equal(lines[1].trackingMode, 'bulk')
    assert.equal(loadBooking(db, 'nope'), null)
  })
})
