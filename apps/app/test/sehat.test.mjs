/**
 * The Sehat reads (read-model.ts; migration 0021) against the demo seed.
 *
 * The seed promises every living-fleet surface a real number: FX9-01 over
 * its service threshold, FX9-02 near (not over) the cycle ceiling, and two
 * dead-stock units — one priced (the Xeen set), one honestly unpriced (a
 * Sachdeva tripod). These tests pin that promise, the group edges, and the
 * Serviced flow end to end: threshold crossed → surfaced → serviced with a
 * cost → meter reset, repair on the book, link on the event.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, recordServiced, moneyLabel } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { decodeScanOps, sehat, serviceFacts } from '../src/demo/read-model.ts'
import { recordExpense, assetCosts } from '../src/demo/kharcha.ts'
import { dayAccount, dayAccountText } from '../src/demo/hisaab.ts'

let db
let seed

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
})

describe('the seeded fleet health', () => {
  test('FX9-01 is over its service threshold and surfaces as due', () => {
    const facts = serviceFacts(db, 'asset-fx9-1')
    assert.equal(facts.daysSinceService, 120)
    assert.equal(facts.dueAfter, 100)
    assert.equal(facts.due, true)

    const health = sehat(db, Date.now())
    assert.deepEqual(
      health.serviceDue.map((r) => r.id),
      ['asset-fx9-1'],
      'exactly the over-threshold unit is due',
    )
    assert.equal(health.serviceDue[0].days, 120)
    assert.equal(health.serviceDue[0].dueAfter, 100)
  })

  test('FX9-02 is NEAR the cycle ceiling — counted, flagged, not over', () => {
    const facts = serviceFacts(db, 'asset-fx9-2')
    assert.equal(facts.countCycles, true)
    assert.equal(facts.cycleCount, 28)
    assert.equal(facts.retireAfterCycles, 30)
    assert.equal(facts.cyclesOver, false)

    assert.deepEqual(sehat(db, Date.now()).cyclesOver, [], 'nothing has crossed yet')
  })

  test('a unit pushed past the ceiling joins the cycle group — and nothing else changes', () => {
    db.exec(`update assets set cycle_count = 31 where id = 'asset-fx9-2'`)
    const over = sehat(db, Date.now()).cyclesOver
    assert.deepEqual(over.map((r) => r.id), ['asset-fx9-2'])
    assert.equal(over[0].cycles, 31)
    assert.equal(over[0].ceiling, 30)
    const a = db.get(`select presence, health from assets where id = 'asset-fx9-2'`)
    assert.equal(a.presence, 'here', 'a crossed ceiling never moves state')
    assert.equal(a.health, 'ok')
  })

  test('dead stock is exactly the two idle units, value split honestly', () => {
    const health = sehat(db, Date.now())
    assert.deepEqual(
      health.deadStock.map((r) => r.id).sort(),
      ['asset-sachdeva-3', 'asset-samyang-1'],
    )
    // The Xeen set is priced (Rs 4.5M); the Sachdeva is honestly unpriced —
    // counted, never folded in as zero.
    assert.equal(health.deadStockValue.totalMinor, 4_500_000 * 100)
    assert.equal(health.deadStockValue.priced, 1)
    assert.equal(health.deadStockValue.unpriced, 1)
    assert.equal(moneyLabel(health.deadStockValue), 'Rs 4,500,000 +1 unpriced')
    for (const r of health.deadStock) assert.ok(r.idleDays >= 119, `${r.id} idle ${r.idleDays}`)
  })

  test('terminal and freshly-arrived gear never read as dead stock', () => {
    // Terminal: gone gear is gone, not sick.
    db.exec(`update assets set presence = 'gone', disposition = 'sold' where id = 'asset-samyang-1'`)
    // New: an anchor inside the window protects a recent arrival.
    db.exec(
      `update assets set last_scanned_at = ?, updated_at = ? where id = 'asset-sachdeva-3'`,
      [new Date().toISOString(), new Date().toISOString()],
    )
    assert.deepEqual(sehat(db, Date.now()).deadStock, [])
  })
})

describe('the serviced flow, end to end', () => {
  test('threshold crossed → surfaced → serviced with cost → reset, booked, linked', () => {
    assert.equal(sehat(db, Date.now()).serviceDue.length, 1)

    // The one flow the sheet performs: the repair on the kharcha book,
    // named to the unit, and the serviced event carrying the link.
    const expenseId = recordExpense(db, {
      orgId: seed.orgId,
      kind: 'repair',
      amountMinor: 12_000_00,
      assetId: 'asset-fx9-1',
      counterparty: 'Sharif Camera Works',
      note: 'Full service',
      createdAt: Date.now(),
    })
    recordServiced(db, { assetId: 'asset-fx9-1', note: 'Full service', expenseId })

    const facts = serviceFacts(db, 'asset-fx9-1')
    assert.equal(facts.daysSinceService, 0, 'the meter reset')
    assert.equal(facts.due, false)
    assert.deepEqual(sehat(db, Date.now()).serviceDue, [], 'the nudge stands down')

    // The money landed where the payback bar reads it…
    assert.equal(assetCosts(db, 'asset-fx9-1').repairMinor, 12_000_00 + 45_000_00)

    // …and the queued op carries the event type and the link the server
    // validates (0021 D2).
    const op = decodeScanOps(db).find((o) => o.eventType === 'serviced')
    assert.ok(op, 'the serviced op queued')
    const raw = JSON.parse(
      db.get(`select payload from outbox where id = ?`, [op.outboxId]).payload,
    )
    assert.deepEqual(raw.payload, { expense_id: expenseId })
  })
})

describe('the day’s account carries the dead-stock line', () => {
  test('when dead stock exists, the hisaab says so in one line — count and money', () => {
    const account = dayAccount(db, Date.now())
    assert.equal(account.deadStock.items, 2)
    assert.equal(account.deadStock.days, 90)
    assert.match(
      dayAccountText(account),
      /Idle 90\+ days: 2 items · Rs 4,500,000 \+1 unpriced/,
    )
  })

  test('and stays silent when there is none — no row, not a zero', () => {
    db.exec(
      `update assets set last_scanned_at = ?, updated_at = ?
        where id in ('asset-samyang-1', 'asset-sachdeva-3')`,
      [new Date().toISOString(), new Date().toISOString()],
    )
    const account = dayAccount(db, Date.now())
    assert.equal(account.deadStock.items, 0)
    assert.doesNotMatch(dayAccountText(account), /Idle \d+\+ days/)
  })
})
