/**
 * Adversarial stress: the partner network's two books under random
 * sub-hire traffic.
 *
 * Hundreds of seeded-random cycles of borrowing IN and lending OUT with
 * the two seeded partner houses — priced and unpriced, with and without a
 * serial, scanned out and not, closed early, closed late, closed twice —
 * and after EVERY write the kharcha book and the khata are re-derived
 * beside the sub_hires rows (demo/network.ts; migration 0025):
 *
 *  - every in-hire WITH a cost has exactly one live sub_hire expense, for
 *    that amount, in the partner's name; one without has none
 *  - every out-hire WITH a charge has exactly one ledger charge on the
 *    partner's customer row, for that amount, on the sub-hire job; one
 *    without has none
 *  - closing never double-writes: no close moves either book, a second
 *    close is refused, and the close op chains behind the record op
 *  - the partner page's money line is the two books, re-summed
 *  - a borrowed unit is sub_rented_in while it is here and leaves as
 *    returned_to_owner (never 'retired'); a lent unit leaves on the
 *    sub-hire job and its close is refused while the unit is still out
 *
 * Seeded mulberry32, fixed 2031 clock, no Date.now in any assertion.
 * Reruns are identical.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA, DAY_MS, HOUR_MS, ScanSession, liveExpenses } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'
import { expenseRows } from '../src/demo/kharcha.ts'
import { customerView } from '../src/demo/khata.ts'
import {
  closeSubHire,
  partner,
  partnerCustomerId,
  partnerMoney,
  recordSubHireIn,
  recordSubHireOut,
  removePartner,
  subHire,
  subHires,
} from '../src/demo/network.ts'

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
const T0 = new Date(2031, 0, 6, 9).getTime()
const STEPS = 300
const PARTNERS = ['partner-kamran', 'partner-zeeshan']
const PRODUCTS = ['prod-fx9', 'prod-fx6', 'prod-ronin', 'prod-c300', 'prod-komodo']
const rs = (rupees) => rupees * 100

// ---------------------------------------------------------- the invariants

/** The sub_hires table as the books see it — the two money columns and
 *  the two links the row view folds into one `agreedMinor`. */
function subHireRows(db) {
  return db
    .all(
      `select id, direction, partner_house_id, asset_id, job_id, period_from, returned_at,
              agreed_cost_minor, agreed_charge_minor, expense_id, ledger_entry_id
         from sub_hires order by created_at, rowid`,
    )
    .map((r) => ({
      id: r.id,
      direction: r.direction,
      partnerId: r.partner_house_id,
      assetId: r.asset_id,
      jobId: r.job_id,
      returned: r.returned_at !== null,
      costMinor: r.agreed_cost_minor === null ? null : Number(r.agreed_cost_minor),
      chargeMinor: r.agreed_charge_minor === null ? null : Number(r.agreed_charge_minor),
      expenseId: r.expense_id,
      ledgerEntryId: r.ledger_entry_id,
    }))
}

/** What the seed already put on the books before this desk touched them
 *  (one sub-hire bill on the drama job), so the deltas are what is compared. */
function baselineOf(db) {
  return {
    subHireExpenses: liveExpenses(expenseRows(db)).filter((e) => e.kind === 'sub_hire').length,
    weOwe: new Map(PARTNERS.map((id) => [id, partnerMoney(db, id).weOweMinor])),
  }
}

/** Re-derive both books from the sub_hires rows and compare. Every lookup
 *  is one query into a map — the check runs after all 300 steps, so a
 *  per-row query would make the test quadratic in its own traffic. */
function assertBooks(db, seed, base, label) {
  const expenses = liveExpenses(expenseRows(db))
  const expenseById = new Map(expenses.map((e) => [e.id, e]))
  const rows = subHireRows(db)
  const partnerById = new Map(PARTNERS.map((id) => [id, partner(db, id)]))
  const customerOf = new Map(PARTNERS.map((id) => [id, partnerCustomerId(db, id)]))
  const jobById = new Map(db.all(`select id, status, customer_id, label from jobs`).map((j) => [j.id, j]))
  const ledgerById = new Map(
    db.all(`select id, kind, amount_minor, customer_id, job_id from customer_ledger_entries`).map((e) => [e.id, e]),
  )
  const assetById = new Map(
    db.all(`select id, ownership, presence, disposition from assets where ownership = 'sub_rented_in'`).map((a) => [a.id, a]),
  )
  for (const s of rows) {
    const p = partnerById.get(s.partnerId)
    assert.ok(p, `${label}: sub-hire ${s.id} names a partner that is gone`)
    if (s.direction === 'in') {
      if (s.costMinor !== null) {
        assert.ok(s.expenseId, `${label}: priced in-hire ${s.id} has no expense`)
        const e = expenseById.get(s.expenseId)
        assert.ok(e, `${label}: expense ${s.expenseId} is not a live row`)
        assert.equal(e.kind, 'sub_hire', label)
        assert.equal(e.amountMinor, s.costMinor, `${label}: expense amount drifted`)
        assert.equal(e.counterparty, p.name, label)
        assert.equal(e.assetId, s.assetId, label)
      } else {
        assert.equal(s.expenseId, null, `${label}: unpriced in-hire wrote an expense`)
      }
      if (s.assetId) {
        const a = assetById.get(s.assetId)
        assert.ok(a, `${label}: a borrowed unit is not sub_rented_in`)
        if (!s.returned) assert.equal(a.disposition, null, `${label}: an open in-hire's unit left the fleet`)
        else {
          assert.equal(a.disposition, 'returned_to_owner', `${label}: a returned unit reads ${a.disposition}`)
          assert.equal(a.presence, 'gone', label)
        }
      }
    } else {
      assert.ok(s.jobId, `${label}: out-hire ${s.id} has no job`)
      const job = jobById.get(s.jobId)
      assert.equal(job.label, `Sub-hire → ${p.name}`, label)
      assert.equal(job.customer_id, customerOf.get(s.partnerId), label)
      if (s.chargeMinor !== null) {
        assert.ok(s.ledgerEntryId, `${label}: priced out-hire ${s.id} has no ledger line`)
        const e = ledgerById.get(s.ledgerEntryId)
        assert.ok(e, label)
        assert.equal(e.kind, 'charge', label)
        assert.equal(Number(e.amount_minor), s.chargeMinor, `${label}: charge amount drifted`)
        assert.equal(e.customer_id, customerOf.get(s.partnerId), label)
        assert.equal(e.job_id, s.jobId, label)
      } else {
        assert.equal(s.ledgerEntryId, null, `${label}: unpriced out-hire wrote a charge`)
      }
      if (s.returned) assert.equal(job.status, 'closed', `${label}: a closed out-hire's job is still open`)
    }
  }

  // Counts, both ways round: nothing on either book but what the sub-hires say.
  const pricedIns = rows.filter((s) => s.direction === 'in' && s.costMinor !== null)
  const subHireExpenses = expenses.filter((e) => e.kind === 'sub_hire')
  assert.equal(subHireExpenses.length - base.subHireExpenses, pricedIns.length, `${label}: sub-hire expenses ≠ priced in-hires`)
  const jobIds = new Set(rows.filter((s) => s.direction === 'out').map((s) => s.jobId))
  const charges = [...ledgerById.values()].filter((e) => e.kind === 'charge' && jobIds.has(e.job_id))
  const pricedOuts = rows.filter((s) => s.direction === 'out' && s.chargeMinor !== null)
  assert.equal(charges.length, pricedOuts.length, `${label}: sub-hire charges ≠ priced out-hires`)

  // The partner page's money line IS the two books.
  for (const partnerId of PARTNERS) {
    const money = partnerMoney(db, partnerId)
    const mine = rows.filter((s) => s.partnerId === partnerId)
    assert.equal(
      money.weOweMinor - base.weOwe.get(partnerId),
      mine.filter((s) => s.direction === 'in' && s.costMinor !== null).reduce((n, s) => n + s.costMinor, 0),
      `${label}: we-owe for ${partnerId}`,
    )
    const theirs = mine.filter((s) => s.direction === 'out' && s.chargeMinor !== null).reduce((n, s) => n + s.chargeMinor, 0)
    if (money.customerId) {
      assert.equal(money.theyOweMinor, theirs, `${label}: they-owe for ${partnerId}`)
      assert.equal(customerView(db, money.customerId).balanceMinor, theirs, label)
    } else {
      assert.equal(theirs, 0, `${label}: charges with no customer row`)
      assert.equal(mine.filter((s) => s.direction === 'out').length, 0, `${label}: an out-hire made no customer`)
    }
  }
  // One customer row per partner that ever borrowed, never a second.
  assert.equal(
    Number(db.get(`select count(*) as n from partner_customer_links`).n),
    PARTNERS.filter((id) => customerOf.get(id) !== null).length,
    label,
  )
  assert.equal(seed.orgId, ORG)
}

// ------------------------------------------------------------- the desk

describe('the partner network under random sub-hire traffic', () => {
  test(`${STEPS} cycles × 2 seeds: the kharcha book, the khata and the sub-hire rows never disagree`, () => {
    for (const seedN of [11, 4242]) {
      const db = new NodeSqliteDriver()
      db.exec(LOCAL_SCHEMA)
      const seed = seedDemo(db)
      const tagOf = new Map(seed.tags.map((t) => [t.assetId, t.tagCode]))
      const base = baselineOf(db)
      const r = rng(seedN)
      let n = 0
      let now = T0
      const ids = () => ({ now: () => now, newId: () => `n${seedN}-${++n}` })
      const label = () => `seed ${seedN} step ${step}`
      const counts = {
        inPriced: 0, inUnpriced: 0, inWithUnit: 0, outByUnit: 0, outByProduct: 0, outPriced: 0, outUnpriced: 0,
        closedIn: 0, closedOut: 0, returnedToOwner: 0, refusedUnitOut: 0, refusedJobOut: 0,
        refusedBeforeStart: 0, refusedFuture: 0, refusedTwice: 0, refusedRemove: 0, scannedOut: 0,
      }
      const expenseCount = () => Number(db.get(`select count(*) as n from org_expenses`).n)
      const ledgerCount = () => Number(db.get(`select count(*) as n from customer_ledger_entries`).n)
      const opCount = (op) => Number(db.get(`select count(*) as n from outbox where op = ?`, [op]).n)
      /** Units currently out on a job through a scan of this test's own. */
      const scannedOut = new Map() // assetId -> jobId
      let step = 0

      /** Scan a unit out on (or back in from) a job, through the real session. */
      const scan = (assetId, jobId, eventType) => {
        const s = new ScanSession(db, { deviceId: 'stress-device', jobId, now: () => now, newId: ids().newId })
        const res = s.scan(tagOf.get(assetId), eventType)
        assert.ok(['accepted', 'unexpected'].includes(res.outcome), `${label()}: ${eventType} of ${assetId} was ${res.outcome}`)
        if (eventType === 'check_out') scannedOut.set(assetId, jobId); else scannedOut.delete(assetId)
      }

      for (step = 0; step < STEPS; step++) {
        now += int(r, HOUR_MS, 2 * DAY_MS)
        const roll = r()
        const partnerId = pick(r, PARTNERS)

        if (roll < 0.3) {
          // ---- borrow IN ------------------------------------------------------
          const serial = r() < 0.6 ? `SN-${seedN}-${step}` : null
          const cost = r() < 0.7 ? rs(int(r, 50, 600) * 100) : null
          const startMs = now + int(r, -DAY_MS, 3 * DAY_MS)
          const before = [expenseCount(), ledgerCount()]
          const res = recordSubHireIn(db, ORG, {
            partnerId, productId: pick(r, PRODUCTS), startMs, endMs: startMs + int(r, DAY_MS, 6 * DAY_MS),
            serial, agreedCostMinor: cost, qty: 1,
          }, now, ids())
          assert.equal(res.ok, true, `${label()}: in refused ${res.reason}`)
          assert.equal(expenseCount(), before[0] + (cost === null ? 0 : 1), `${label()}: an in-hire wrote the wrong number of expenses`)
          assert.equal(ledgerCount(), before[1], `${label()}: an in-hire touched the khata`)
          if (cost === null) counts.inUnpriced++; else counts.inPriced++
          if (serial) {
            counts.inWithUnit++
            assert.ok(res.assetId && res.assetCode, label())
            const code = `v1STRESS${seedN}${String(step).padStart(4, '0')}AAAAAAAAAA`.slice(0, 24)
            db.exec(`insert into asset_tags (tag_code, asset_id, status) values (?, ?, 'active')`, [code, res.assetId])
            tagOf.set(res.assetId, code)
            // Sometimes the loaner rides a truck straight away.
            if (r() < 0.5) { scan(res.assetId, 'job-shan', 'check_out'); counts.scannedOut++ }
          } else {
            assert.equal(res.assetId, null, label())
          }
        } else if (roll < 0.55) {
          // ---- lend OUT ---------------------------------------------------------
          const byUnit = r() < 0.7
          const charge = r() < 0.7 ? rs(int(r, 50, 600) * 100) : null
          const startMs = now + int(r, -DAY_MS, 3 * DAY_MS)
          const unit = byUnit
            ? db.get(
                `select id from assets where product_id in (${PRODUCTS.map(() => '?').join(',')})
                  and ownership = 'owned' and disposition is null and presence = 'here'
                  and id not in (select coalesce(asset_id, '') from sub_hires where direction = 'out' and returned_at is null)
                  order by id limit 1 offset ?`,
                [...PRODUCTS, int(r, 0, 3)],
              )
            : null
          if (byUnit && !unit) continue
          const before = [expenseCount(), ledgerCount()]
          const res = recordSubHireOut(db, ORG, {
            partnerId, startMs, endMs: startMs + int(r, DAY_MS, 6 * DAY_MS),
            assetId: unit?.id ?? null, productId: unit ? null : pick(r, PRODUCTS), qty: unit ? 1 : int(r, 1, 2),
            agreedChargeMinor: charge,
          }, now, ids())
          assert.equal(res.ok, true, `${label()}: out refused ${res.reason}`)
          assert.equal(ledgerCount(), before[1] + (charge === null ? 0 : 1), `${label()}: an out-hire wrote the wrong number of ledger lines`)
          assert.equal(expenseCount(), before[0], `${label()}: an out-hire touched the kharcha book`)
          if (charge === null) counts.outUnpriced++; else counts.outPriced++
          if (unit) {
            counts.outByUnit++
            assert.deepEqual(
              db.all(`select asset_id from job_expected where job_id = ? order by asset_id`, [res.jobId]).map((x) => x.asset_id),
              [unit.id],
              `${label()}: the lent unit is promised on the sub-hire job`,
            )
            // Sometimes the desk scans it out onto the job before the truck goes.
            if (r() < 0.6) { scan(unit.id, res.jobId, 'check_out'); counts.scannedOut++ }
          } else {
            counts.outByProduct++
          }
        } else if (roll < 0.85) {
          // ---- close one ------------------------------------------------------------
          const open = subHires(db).filter((s) => s.returnedAtMs === null)
          if (open.length === 0) continue
          const s = pick(r, open)
          const before = [expenseCount(), ledgerCount(), opCount('close_sub_hire')]
          const attempt = r()
          if (attempt < 0.1) {
            const res = closeSubHire(db, s.id, s.fromMs - HOUR_MS, now, ids())
            assert.deepEqual(res, { ok: false, reason: 'before_start' }, label())
            counts.refusedBeforeStart++
          } else if (attempt < 0.2) {
            const res = closeSubHire(db, s.id, now + HOUR_MS, now, ids())
            assert.deepEqual(res, { ok: false, reason: 'future' }, label())
            counts.refusedFuture++
          } else if (s.fromMs > now) {
            const res = closeSubHire(db, s.id, now, now, ids())
            assert.deepEqual(res, { ok: false, reason: 'before_start' }, `${label()}: closed before the period began`)
            counts.refusedBeforeStart++
          } else {
            const returnedAt = int(r, s.fromMs, now)
            let res = closeSubHire(db, s.id, returnedAt, now, ids())
            if (s.direction === 'in' && s.assetId && scannedOut.has(s.assetId)) {
              assert.deepEqual(res, { ok: false, reason: 'unit_out' }, `${label()}: a borrowed unit went home from a truck`)
              counts.refusedUnitOut++
              scan(s.assetId, scannedOut.get(s.assetId), 'check_in')
              res = closeSubHire(db, s.id, returnedAt, now, ids())
            } else if (s.direction === 'out' && s.assetId && scannedOut.has(s.assetId)) {
              assert.deepEqual(res, { ok: false, reason: 'job_still_out', stillOut: 1 }, `${label()}: a lent unit's job closed with the unit out`)
              counts.refusedJobOut++
              scan(s.assetId, s.jobId, 'check_in')
              res = closeSubHire(db, s.id, returnedAt, now, ids())
            }
            assert.equal(res.ok, true, `${label()}: close refused ${res.reason}`)
            assert.equal(res.jobClosed, s.direction === 'out', label())
            assert.equal(res.returnedToOwner, s.direction === 'in' && s.assetId !== null, label())
            if (s.direction === 'in') counts.closedIn++; else counts.closedOut++
            if (res.returnedToOwner) counts.returnedToOwner++
            assert.equal(subHire(db, s.id).returnedAtMs, returnedAt, label())
            assert.equal(opCount('close_sub_hire'), before[2] + 1, label())
            const closeOp = db.get(`select depends_on from outbox where op = 'close_sub_hire' order by seq desc limit 1`)
            assert.ok(closeOp.depends_on, `${label()}: the close op chains behind nothing`)
            assert.match(
              db.get(`select payload from outbox where id = ?`, [closeOp.depends_on]).payload,
              new RegExp(`"client_sub_hire_id":"${s.id}"`),
              `${label()}: the close chains behind another sub-hire's op`,
            )
            // The second close is refused, and the books did not move either time.
            assert.deepEqual(closeSubHire(db, s.id, returnedAt, now, ids()), { ok: false, reason: 'already_closed' }, label())
            counts.refusedTwice++
          }
          assert.equal(expenseCount(), before[0], `${label()}: a close moved the kharcha book`)
          assert.equal(ledgerCount(), before[1], `${label()}: a close moved the khata`)
        } else {
          // ---- try to remove a partner with open sub-hires --------------------------
          const open = subHires(db).filter((s) => s.returnedAtMs === null && s.partnerId === partnerId).length
          const res = removePartner(db, partnerId, now, ids())
          if (open > 0) {
            assert.deepEqual(res, { ok: false, reason: 'open_sub_hires', open }, label())
            counts.refusedRemove++
          } else {
            // A partner with nothing open may go — but this desk needs both,
            // so the removal is verified and the soft-delete undone by hand.
            assert.deepEqual(res, { ok: true }, label())
            db.exec(`update partner_houses set deleted_at = null where id = ?`, [partnerId])
            assert.ok(partner(db, partnerId), `${label()}: the partner did not come back`)
          }
        }

        assertBooks(db, seed, base, label())
      }

      // ---- the queue told the same story ----------------------------------------
      assert.equal(opCount('record_sub_hire_in'), counts.inPriced + counts.inUnpriced, `seed ${seedN}: one op per in-hire`)
      assert.equal(opCount('record_sub_hire_out'), counts.outPriced + counts.outUnpriced, `seed ${seedN}: one op per out-hire`)
      assert.equal(opCount('close_sub_hire'), counts.closedIn + counts.closedOut, `seed ${seedN}: refused closes queue nothing`)
      assert.equal(
        Number(db.get(`select count(*) as n from assets where disposition = 'retired'`).n), 0,
        `seed ${seedN}: a borrowed unit went home as 'retired'`,
      )
      assert.equal(
        Number(db.get(`select count(*) as n from assets where disposition = 'returned_to_owner'`).n),
        counts.returnedToOwner, `seed ${seedN}: returned_to_owner count`,
      )

      // ---- the run exercised every door -------------------------------------------
      for (const [k, v] of Object.entries(counts)) assert.ok(v > 0, `seed ${seedN}: ${k} never happened`)
    }
  })
})
