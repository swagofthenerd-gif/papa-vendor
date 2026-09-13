/**
 * The network against a real SQLite — partners, sub-hire in and out, crew,
 * the stolen broadcast, the money line (demo/network.ts; migration 0025).
 *
 * Every door's refusals are the RPC's, every write is one transaction
 * beside its outbox op, and the money lands on the book it belongs to:
 * an in-hire's cost on the kharcha book (so the job's margin sees it),
 * an out-hire's charge on the partner's khata. The borrowed unit joins the
 * mirror as sub_rented_in and leaves it as returned_to_owner — never
 * 'retired' — through the plain retire verb.
 */
import { test, describe, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, ScanSession, formatRupees } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import {
  askTheMarket,
  assignAttendant,
  attendantNames,
  closeSubHire,
  crewFor,
  ensurePartnerCustomer,
  nextAssetCode,
  partner,
  partnerMoney,
  partners,
  recordSubHireIn,
  recordSubHireOut,
  removePartner,
  setPublicPhone,
  setPublicTagUrlBase,
  staff,
  stolenBroadcast,
  stolenBroadcastFacts,
  subHire,
  subHireForAsset,
  subHireForJob,
  subHireJobLabel,
  subHires,
  unassignAttendant,
  upsertPartner,
} from '../src/demo/network.ts'
import { openJob, openJobs, closeJob, stillOutCount } from '../src/demo/read-model.ts'
import { customerView } from '../src/demo/khata.ts'
import { jobMargin, expenseRows } from '../src/demo/kharcha.ts'
import { markTerminal } from '@papa/core'

let db
let seed
let seq
const ids = () => ({ now: () => NOW, newId: () => `id-${++seq}` })

const NOW = new Date(2026, 10, 10, 12).getTime()   // local 2026-11-10 12:00
const SAT = new Date(2026, 10, 21, 6).getTime()
const MON = new Date(2026, 10, 23, 18).getTime()
const rs = (rupees) => rupees * 100

const ops = (op) => db.all(`select id, payload, depends_on from outbox where op = ? order by seq`, [op])
  .map((r) => ({ id: r.id, dependsOn: r.depends_on, ...JSON.parse(r.payload) }))

beforeEach(() => {
  db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  seed = seedDemo(db)
  seq = 0
})

describe('partner houses', () => {
  test('the seed carries two, by name, with no open sub-hires', () => {
    const list = partners(db)
    assert.deepEqual(list.map((p) => p.name), ['Kamran Rentals', 'Zeeshan Cine Hire'])
    assert.deepEqual(list.map((p) => [p.openIn, p.openOut]), [[0, 0], [0, 0]])
    assert.equal(list[0].city, 'Lahore')
  })

  test('add: trimmed name, city defaults to Lahore, one op with the client id', () => {
    const r = upsertPartner(db, seed.orgId, { name: '  Faisal Films ', phone: '0300 1112223' }, NOW, ids())
    assert.equal(r.ok, true)
    const p = partner(db, r.id)
    assert.equal(p.name, 'Faisal Films')
    assert.equal(p.city, 'Lahore')
    const [op] = ops('upsert_partner_house')
    assert.equal(op.client_partner_id, r.id)
    assert.equal(op.p_name, 'Faisal Films')
    assert.equal(op.p_id, undefined, 'a create carries no p_id')
  })

  test('a blank name and a second spelling of an existing name are refused', () => {
    assert.deepEqual(upsertPartner(db, seed.orgId, { name: '  ' }, NOW, ids()), { ok: false, reason: 'blank_name' })
    assert.deepEqual(upsertPartner(db, seed.orgId, { name: 'kamran rentals' }, NOW, ids()), { ok: false, reason: 'duplicate_name' })
    assert.equal(ops('upsert_partner_house').length, 0, 'refusals write nothing')
  })

  test('edit: blank fields keep, the op chains behind the last op on this partner', () => {
    const made = upsertPartner(db, seed.orgId, { name: 'Faisal Films', phone: '0300 1112223', notes: 'Fast' }, NOW, ids())
    const edited = upsertPartner(db, seed.orgId, { id: made.id, name: 'Faisal Films & Co', phone: '' }, NOW + 1, ids())
    assert.equal(edited.ok, true)
    const p = partner(db, made.id)
    assert.equal(p.name, 'Faisal Films & Co')
    assert.equal(p.phone, '0300 1112223', 'a blank phone keeps the old one')
    assert.equal(p.notes, 'Fast')
    const [create, edit] = ops('upsert_partner_house')
    assert.equal(edit.p_id, made.id)
    assert.equal(edit.dependsOn, create.id)
    // Renaming onto another partner's name is still a twin.
    assert.deepEqual(
      upsertPartner(db, seed.orgId, { id: made.id, name: 'Kamran Rentals' }, NOW + 2, ids()),
      { ok: false, reason: 'duplicate_name' },
    )
  })

  test('remove: soft-deletes, queues the op, refused while a sub-hire is open', () => {
    const r = recordSubHireIn(db, seed.orgId, { partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: SAT, endMs: MON }, NOW, ids())
    assert.equal(r.ok, true)
    assert.deepEqual(removePartner(db, 'partner-kamran', NOW, ids()), { ok: false, reason: 'open_sub_hires', open: 1 })
    assert.equal(closeSubHire(db, r.subHireId, NOW, NOW, ids()).ok, false, 'not before the period began')
    assert.equal(closeSubHire(db, r.subHireId, SAT + 3600_000, MON, ids()).ok, true)
    assert.deepEqual(removePartner(db, 'partner-kamran', MON, ids()), { ok: true })
    assert.equal(partner(db, 'partner-kamran'), null)
    assert.deepEqual(partners(db).map((p) => p.name), ['Zeeshan Cine Hire'])
    assert.equal(ops('remove_partner_house').length, 1)
    assert.deepEqual(removePartner(db, 'partner-kamran', MON, ids()), { ok: false, reason: 'not_found' })
  })
})

describe('sub-hire in', () => {
  test('with a serial: the unit joins the mirror as sub_rented_in with a local code, the expense on the kharcha book, one op', () => {
    const r = recordSubHireIn(db, seed.orgId, {
      partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: SAT, endMs: MON,
      serial: 'FX9-SN-7781', agreedCostMinor: rs(30_000), note: 'Shaadi weekend',
    }, NOW, ids())
    assert.equal(r.ok, true)
    assert.equal(r.partnerName, 'Kamran Rentals')
    assert.equal(r.assetCode, 'FX9-03', 'next after the seeded FX9-01/02')
    const a = db.get(`select * from assets where id = ?`, [r.assetId])
    assert.equal(a.ownership, 'sub_rented_in')
    assert.equal(a.presence, 'here')
    assert.equal(a.serial_number, 'FX9-SN-7781')
    assert.equal(a.current_location_id, 'loc-rack-a', 'on its siblings\' shelf')
    assert.match(a.notes, /Sub-hired from Kamran Rentals/)
    // The expense: kind sub_hire, counterparty the partner, naming the unit.
    const e = expenseRows(db).find((x) => x.id === r.expenseId)
    assert.equal(e.kind, 'sub_hire')
    assert.equal(e.counterparty, 'Kamran Rentals')
    assert.equal(e.assetId, r.assetId)
    assert.equal(e.amountMinor, rs(30_000))
    // The row and the op tie the three together.
    const s = subHire(db, r.subHireId)
    assert.equal(s.direction, 'in')
    assert.equal(s.assetId, r.assetId)
    assert.equal(s.agreedMinor, rs(30_000))
    assert.equal(s.returnedAtMs, null)
    assert.equal(subHireForAsset(db, r.assetId).id, r.subHireId)
    const [op] = ops('record_sub_hire_in')
    assert.equal(op.client_sub_hire_id, r.subHireId)
    assert.equal(op.client_asset_id, r.assetId)
    assert.equal(op.p_serial_number, 'FX9-SN-7781')
    assert.equal(op.p_agreed_cost_minor, rs(30_000))
    assert.match(op.p_period, /^\[2026-11-21T.*,2026-11-23T.*\)$/)
    assert.equal(partner(db, 'partner-kamran').openIn, 1)
  })

  test('unpriced: no expense row, the sub-hire is the counted fact (ASSUMPTION #sub-hire-unpriced)', () => {
    const before = expenseRows(db).length
    const r = recordSubHireIn(db, seed.orgId, { partnerId: 'partner-kamran', productId: 'prod-cstand', startMs: SAT, endMs: MON, qty: 4 }, NOW, ids())
    assert.equal(r.ok, true)
    assert.equal(r.expenseId, null)
    assert.equal(r.assetId, null, 'no serial, no unit')
    assert.equal(expenseRows(db).length, before)
    assert.equal(subHire(db, r.subHireId).qty, 4)
    assert.equal(subHire(db, r.subHireId).agreedMinor, null)
  })

  test('the refusals are the RPC\'s', () => {
    const base = { partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: SAT, endMs: MON }
    const refuse = (input) => recordSubHireIn(db, seed.orgId, { ...base, ...input }, NOW, ids())
    assert.deepEqual(refuse({ partnerId: 'nope' }), { ok: false, reason: 'no_partner' })
    assert.deepEqual(refuse({ productId: 'nope' }), { ok: false, reason: 'no_product' })
    assert.deepEqual(refuse({ endMs: SAT }), { ok: false, reason: 'bad_period' })
    assert.deepEqual(refuse({ qty: 0 }), { ok: false, reason: 'bad_qty' })
    assert.deepEqual(refuse({ agreedCostMinor: 0 }), { ok: false, reason: 'bad_cost' })
    assert.deepEqual(refuse({ serial: 'X1', qty: 2 }), { ok: false, reason: 'serial_needs_one' })
    db.exec(`update products set tracking_mode = 'bulk' where id = 'prod-cstand'`)
    assert.deepEqual(refuse({ productId: 'prod-cstand', serial: 'X1' }), { ok: false, reason: 'not_serialized' })
    const seededSerial = db.get(`select serial_number as s from assets where serial_number is not null limit 1`)?.s
    if (seededSerial) assert.deepEqual(refuse({ serial: seededSerial.toLowerCase() }), { ok: false, reason: 'serial_in_fleet' })
    assert.equal(ops('record_sub_hire_in').length, 0)
    assert.equal(subHires(db).length, 0)
  })

  test('a rescue for a booking chains behind that booking\'s ops and rides the job\'s margin', () => {
    // A job the loaner will serve: its margin subtracts the sub-hire cost.
    const r = recordSubHireIn(db, seed.orgId, {
      partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: SAT, endMs: MON,
      serial: 'FX9-SN-1', agreedCostMinor: rs(20_000), jobId: 'job-wedding', bookingId: 'bk-1',
    }, NOW, ids())
    assert.equal(r.ok, true)
    assert.equal(jobMargin(db, 'job-wedding').expenseMinor, rs(20_000))
    const [op] = ops('record_sub_hire_in')
    assert.equal(op.p_booking_id, 'bk-1')
    assert.equal(op.p_job_id, 'job-wedding')
  })

  test('nextAssetCode: the product prefix continues; a product with no units names itself', () => {
    assert.equal(nextAssetCode(db, 'prod-fx9'), 'FX9-03')
    db.exec(`insert into products (id, org_id, display_name, tracking_mode) values ('prod-new', ?, 'Alexa Mini LF', 'serialized')`, [seed.orgId])
    assert.equal(nextAssetCode(db, 'prod-new'), 'ALEXA-01')
  })
})

describe('coming home (close, direction in)', () => {
  test('a retire event stamps returned_to_owner — never retired — and the row closes', () => {
    const r = recordSubHireIn(db, seed.orgId, { partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: SAT, endMs: MON, serial: 'SN-1' }, NOW, ids())
    const closed = closeSubHire(db, r.subHireId, MON, MON, ids())
    assert.deepEqual(closed, { ok: true, jobClosed: false, returnedToOwner: true })
    const a = db.get(`select presence, disposition, current_job_id from assets where id = ?`, [r.assetId])
    assert.equal(a.presence, 'gone')
    assert.equal(a.disposition, 'returned_to_owner')
    assert.equal(subHire(db, r.subHireId).returnedAtMs, MON)
    // The retire op is the plain verb; the close op chains behind the record op.
    const retire = db.all(`select payload from outbox where op = 'submit_scan_batch'`).map((x) => JSON.parse(x.payload)).at(-1)
    assert.equal(retire.event_type, 'retire')
    assert.equal(retire.asset_id, r.assetId)
    const [rec] = ops('record_sub_hire_in')
    const [close] = ops('close_sub_hire')
    assert.equal(close.dependsOn, rec.id)
    assert.equal(close.p_sub_hire_id, r.subHireId)
    assert.equal(partner(db, 'partner-kamran').openIn, 0)
  })

  test('refused while the borrowed unit is still out on a job', () => {
    const r = recordSubHireIn(db, seed.orgId, { partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: SAT, endMs: MON, serial: 'SN-1' }, NOW, ids())
    // Scan it out onto the wedding job, the way the desk would.
    db.exec(`insert into asset_tags (tag_code, asset_id, status) values ('v1LOANER', ?, 'active')`, [r.assetId])
    const session = new ScanSession(db, { deviceId: 'd', jobId: 'job-wedding', expected: new Set(), now: () => SAT })
    // Off the job's list, so 'unexpected' — recorded all the same (reality
    // outranks the schedule), which is what the close rule reads.
    assert.equal(session.scan('v1LOANER', 'check_out').outcome, 'unexpected')
    assert.deepEqual(closeSubHire(db, r.subHireId, MON, MON, ids()), { ok: false, reason: 'unit_out' })
    assert.equal(subHire(db, r.subHireId).returnedAtMs, null)
    assert.ok(['accepted', 'unexpected'].includes(session.scan('v1LOANER', 'check_in').outcome))
    assert.equal(closeSubHire(db, r.subHireId, MON, MON, ids()).ok, true)
  })

  test('already closed, a future return, and a return before the start are refused', () => {
    const r = recordSubHireIn(db, seed.orgId, { partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: SAT, endMs: MON }, NOW, ids())
    assert.deepEqual(closeSubHire(db, r.subHireId, MON + 1, MON, ids()), { ok: false, reason: 'future' })
    assert.deepEqual(closeSubHire(db, r.subHireId, SAT - 1, MON, ids()), { ok: false, reason: 'before_start' })
    assert.equal(closeSubHire(db, r.subHireId, MON, MON, ids()).ok, true)
    assert.deepEqual(closeSubHire(db, r.subHireId, MON, MON, ids()), { ok: false, reason: 'already_closed' })
    assert.deepEqual(closeSubHire(db, 'nope', MON, MON, ids()), { ok: false, reason: 'not_found' })
  })
})

describe('sub-hire out (lend)', () => {
  test('a named unit: the partner becomes a customer, the job is born with the unit promised, the charge lands on their khata', () => {
    const r = recordSubHireOut(db, seed.orgId, {
      partnerId: 'partner-zeeshan', startMs: SAT, endMs: MON, assetId: 'asset-komodo-1', agreedChargeMinor: rs(18_000),
    }, NOW, ids())
    assert.equal(r.ok, true)
    assert.equal(r.jobLabel, 'Sub-hire → Zeeshan Cine Hire')
    assert.equal(r.jobLabel, subHireJobLabel('Zeeshan Cine Hire'))
    const job = openJob(db, r.jobId)
    assert.ok(job, 'on the board')
    assert.deepEqual(job.expected, ['asset-komodo-1'])
    assert.equal(job.customer.id, r.customerId)
    assert.equal(job.customer.name, 'Zeeshan Cine Hire')
    assert.equal(job.contact, '0322 1122334')
    assert.equal(job.expectedBack, '2026-11-23')
    // The khata: a new customer row, one charge.
    const c = customerView(db, r.customerId)
    assert.equal(c.balanceMinor, rs(18_000))
    assert.equal(c.entries[0].jobId, r.jobId)
    assert.equal(c.entries[0].assetId, 'asset-komodo-1')
    assert.equal(subHireForJob(db, r.jobId).id, r.subHireId)
    const [op] = ops('record_sub_hire_out')
    assert.equal(op.p_asset_id, 'asset-komodo-1')
    assert.equal(op.p_agreed_charge_minor, rs(18_000))
    assert.equal(op.client_job_id, r.jobId)
    assert.equal(partner(db, 'partner-zeeshan').openOut, 1)
  })

  test('a partner with the same name as an existing customer gets THAT khata, flagged, not a second one (ASSUMPTION #partner-is-customer)', () => {
    const made = upsertPartner(db, seed.orgId, { name: 'hamza saeed' }, NOW, ids())
    assert.equal(ensurePartnerCustomer(db, seed.orgId, made.id), 'cust-hamza')
    const r = recordSubHireOut(db, seed.orgId, { partnerId: made.id, startMs: SAT, endMs: MON, productId: 'prod-fx6', qty: 1, agreedChargeMinor: rs(10_000) }, NOW, ids())
    assert.equal(r.customerId, 'cust-hamza')
    assert.equal(customerView(db, 'cust-hamza').balanceMinor, rs(10_000), 'Hamza was clean; the loan is now on his book')
    assert.equal(db.all(`select id from customers where lower(name) = 'hamza saeed'`).length, 1)
  })

  test('unpriced: no ledger line; a product count promises that many units', () => {
    const r = recordSubHireOut(db, seed.orgId, { partnerId: 'partner-kamran', startMs: SAT, endMs: MON, productId: 'prod-vmount', qty: 3 }, NOW, ids())
    assert.equal(r.ok, true)
    assert.equal(r.ledgerEntryId, null)
    assert.equal(customerView(db, r.customerId).balanceMinor, 0)
    assert.equal(openJob(db, r.jobId).expected.length, 3)
  })

  test('the refusals: a gone unit, a borrowed unit, a bad period', () => {
    const base = { partnerId: 'partner-kamran', startMs: SAT, endMs: MON }
    const refuse = (input) => recordSubHireOut(db, seed.orgId, { ...base, ...input }, NOW, ids())
    markTerminal(db, { assetId: 'asset-komodo-1', disposition: 'sold', newId: () => 'x1' })
    assert.deepEqual(refuse({ assetId: 'asset-komodo-1' }), { ok: false, reason: 'asset_gone' })
    const loan = recordSubHireIn(db, seed.orgId, { partnerId: 'partner-zeeshan', productId: 'prod-fx9', startMs: SAT, endMs: MON, serial: 'SN-9' }, NOW, ids())
    assert.deepEqual(refuse({ assetId: loan.assetId }), { ok: false, reason: 'asset_borrowed' })
    assert.deepEqual(refuse({ assetId: 'asset-fx6-1', qty: 2 }), { ok: false, reason: 'asset_needs_one' })
    assert.deepEqual(refuse({ assetId: 'asset-fx6-1', productId: 'prod-fx9' }), { ok: false, reason: 'no_product' })
    assert.deepEqual(refuse({ productId: 'prod-fx6', endMs: SAT }), { ok: false, reason: 'bad_period' })
    assert.deepEqual(refuse({ productId: 'prod-fx6', agreedChargeMinor: -1 }), { ok: false, reason: 'bad_charge' })
    assert.deepEqual(refuse({}), { ok: false, reason: 'no_product' })
    assert.equal(ops('record_sub_hire_out').length, 0)
    assert.equal(openJobs(db).length, 3, 'no job was born by a refusal')
  })

  test('coming back: refused while the unit still projects onto the job, then the job closes', () => {
    const r = recordSubHireOut(db, seed.orgId, { partnerId: 'partner-kamran', startMs: SAT, endMs: MON, assetId: 'asset-fx6-1' }, NOW, ids())
    const tag = seed.tags.find((t) => t.assetId === 'asset-fx6-1').tagCode
    const out = new ScanSession(db, { deviceId: 'd', jobId: r.jobId, expected: new Set(['asset-fx6-1']), now: () => SAT })
    assert.equal(out.scan(tag, 'check_out').outcome, 'accepted')
    assert.equal(stillOutCount(db, r.jobId), 1)
    assert.deepEqual(closeSubHire(db, r.subHireId, MON, MON, ids()), { ok: false, reason: 'job_still_out', stillOut: 1 })
    const back = new ScanSession(db, { deviceId: 'd', jobId: r.jobId, expected: new Set(['asset-fx6-1']), now: () => MON })
    assert.equal(back.scan(tag, 'check_in').outcome, 'accepted')
    assert.deepEqual(closeSubHire(db, r.subHireId, MON, MON, ids()), { ok: true, jobClosed: true, returnedToOwner: false })
    assert.equal(openJob(db, r.jobId), null, 'off the board')
    assert.equal(db.get(`select status from jobs where id = ?`, [r.jobId]).status, 'closed')
    assert.equal(partner(db, 'partner-kamran').openOut, 0)
  })

  test('closing the job by hand first still lets the sub-hire close', () => {
    const r = recordSubHireOut(db, seed.orgId, { partnerId: 'partner-kamran', startMs: SAT, endMs: MON, productId: 'prod-cstand', qty: 2 }, NOW, ids())
    assert.deepEqual(closeJob(db, r.jobId, MON), { ok: true })
    assert.deepEqual(closeSubHire(db, r.subHireId, MON, MON, ids()), { ok: true, jobClosed: false, returnedToOwner: false })
  })
})

describe('the list and the money line', () => {
  test('subHires filters by open, direction and partner; open first, newest first', () => {
    const a = recordSubHireIn(db, seed.orgId, { partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: SAT, endMs: MON }, NOW, ids())
    const b = recordSubHireOut(db, seed.orgId, { partnerId: 'partner-kamran', startMs: SAT, endMs: MON, productId: 'prod-cstand' }, NOW + 1000, ids())
    const c = recordSubHireIn(db, seed.orgId, { partnerId: 'partner-zeeshan', productId: 'prod-fx6', startMs: SAT, endMs: MON }, NOW + 2000, ids())
    closeSubHire(db, a.subHireId, MON, MON, ids())
    assert.deepEqual(subHires(db).map((s) => s.id), [c.subHireId, b.subHireId, a.subHireId])
    assert.deepEqual(subHires(db, { open: true }).map((s) => s.id), [c.subHireId, b.subHireId])
    assert.deepEqual(subHires(db, { direction: 'out' }).map((s) => s.id), [b.subHireId])
    assert.deepEqual(subHires(db, { partnerId: 'partner-kamran', open: false }).map((s) => s.id), [a.subHireId])
    assert.equal(subHires(db)[0].productName, 'Sony FX6')
    assert.equal(subHires(db)[1].jobLabel, 'Sub-hire → Kamran Rentals')
  })

  test('what we owe them rides the kharcha book, what they owe us rides their khata', () => {
    assert.deepEqual(partnerMoney(db, 'partner-kamran'), { weOweMinor: 0, weOweCount: 0, theyOweMinor: null, customerId: null })
    recordSubHireIn(db, seed.orgId, { partnerId: 'partner-kamran', productId: 'prod-fx9', startMs: SAT, endMs: MON, agreedCostMinor: rs(30_000) }, NOW, ids())
    recordSubHireIn(db, seed.orgId, { partnerId: 'partner-kamran', productId: 'prod-fx6', startMs: SAT, endMs: MON, agreedCostMinor: rs(12_000) }, NOW, ids())
    const lend = recordSubHireOut(db, seed.orgId, { partnerId: 'partner-kamran', startMs: SAT, endMs: MON, productId: 'prod-cstand', agreedChargeMinor: rs(5_000) }, NOW, ids())
    const m = partnerMoney(db, 'partner-kamran')
    assert.equal(m.weOweMinor, rs(42_000))
    assert.equal(m.weOweCount, 2)
    assert.equal(m.theyOweMinor, rs(5_000))
    assert.equal(m.customerId, lend.customerId)
    assert.equal(formatRupees(m.weOweMinor), 'Rs 42,000')
  })
})

describe('crew on the job', () => {
  test('the seed puts a tech and a driver on the wedding truck', () => {
    assert.deepEqual(attendantNames(db, 'job-wedding'), ['Usman', 'Saqib'])
    assert.deepEqual(attendantNames(db, 'job-shan'), [])
    assert.deepEqual(openJob(db, 'job-wedding').attendantNames, ['Usman', 'Saqib'])
    assert.deepEqual(staff(db).map((s) => s.name), ['Danish', 'Saqib', 'Usman'])
  })

  test('assign writes the row, rewrites the projection, queues the op; a second call changes the role', () => {
    const r = assignAttendant(db, seed.orgId, 'job-shan', 'user-danish', 'attendant', NOW, ids())
    assert.deepEqual(r, { ok: true, attendantNames: ['Danish'] })
    assert.deepEqual(openJob(db, 'job-shan').attendantNames, ['Danish'])
    const again = assignAttendant(db, seed.orgId, 'job-shan', 'user-danish', 'driver', NOW + 1, ids())
    assert.deepEqual(again.attendantNames, ['Danish'])
    assert.deepEqual(crewFor(db, 'job-shan'), [{ userId: 'user-danish', name: 'Danish', role: 'driver' }])
    assert.equal(ops('assign_attendant').length, 2)
    assert.equal(ops('assign_attendant')[1].p_role, 'driver')
  })

  test('unassign removes and rewrites; not on the crew writes nothing', () => {
    const r = unassignAttendant(db, 'job-wedding', 'user-usman', NOW, ids())
    assert.deepEqual(r, { ok: true, attendantNames: ['Saqib'] })
    assert.deepEqual(unassignAttendant(db, 'job-wedding', 'user-usman', NOW, ids()), { ok: true, attendantNames: ['Saqib'] })
    assert.equal(ops('unassign_attendant').length, 1)
  })

  test('refusals: no such job, no such person, a bad role', () => {
    assert.deepEqual(assignAttendant(db, seed.orgId, 'nope', 'user-usman', 'attendant', NOW, ids()), { ok: false, reason: 'no_job' })
    assert.deepEqual(assignAttendant(db, seed.orgId, 'job-shan', 'nobody', 'attendant', NOW, ids()), { ok: false, reason: 'no_user' })
    assert.deepEqual(assignAttendant(db, seed.orgId, 'job-shan', 'user-usman', 'pilot', NOW, ids()), { ok: false, reason: 'bad_role' })
    assert.deepEqual(unassignAttendant(db, 'nope', 'user-usman', NOW, ids()), { ok: false, reason: 'no_job' })
  })
})

describe('the stolen broadcast and the ask', () => {
  test('null unless the unit is marked stolen; the link needs both the base and a tag', () => {
    assert.equal(stolenBroadcastFacts(db, 'asset-fx9-1', seed.houseName), null)
    markTerminal(db, { assetId: 'asset-fx9-1', disposition: 'stolen', newId: () => 'st1' })
    const bare = stolenBroadcastFacts(db, 'asset-fx9-1', seed.houseName)
    assert.equal(bare.assetCode, 'FX9-01')
    assert.equal(bare.productName, 'Sony FX9')
    assert.ok(bare.tagCode)
    assert.equal(bare.publicUrl, null, 'no base set: no link (ASSUMPTION #public-tag-url)')
    assert.equal(bare.orgPhone, null)
    setPublicTagUrlBase(db, 'https://tags.papa.pk/')
    setPublicPhone(db, '0300 1234567')
    const facts = stolenBroadcastFacts(db, 'asset-fx9-1', seed.houseName)
    assert.equal(facts.publicUrl, `https://tags.papa.pk/${bare.tagCode}`)
    assert.equal(facts.orgPhone, '0300 1234567')
    const text = stolenBroadcast(db, 'asset-fx9-1', seed.houseName, 'ur')
    assert.match(text, /^CHORI \/ STOLEN — Sony FX9 \(FX9-01\)/)
    assert.match(text, /Ravi Light & Grip/)
    assert.match(text, new RegExp(` https://tags\\.papa\\.pk/${bare.tagCode}$`))
    assert.equal(stolenBroadcast(db, 'asset-fx9-2', seed.houseName, 'ur'), null)
  })

  test('the ask carries the org phone when set, the shortage lines always', () => {
    const lines = [{ productName: 'Sony FX9', qty: 1, fromMs: SAT, untilMs: MON }]
    assert.match(askTheMarket(db, lines, seed.houseName, 'en'), /please reply here/)
    setPublicPhone(db, '0300 1234567')
    const t = askTheMarket(db, lines, seed.houseName, 'en')
    assert.match(t, /^Ravi Light & Grip — looking for gear/)
    assert.match(t, /1 x Sony FX9 · Sat 21 Nov – Mon 23 Nov/)
    assert.match(t, /0300 1234567/)
  })
})
