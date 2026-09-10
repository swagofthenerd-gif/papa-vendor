/**
 * Adversarial stress: the udhaar ledger's projection under hundreds of
 * random books, plus the hostile inputs a projection must survive.
 *
 * DETERMINISTIC ON PURPOSE. Every random book is derived from a fixed seed
 * via mulberry32, so a failure reproduces exactly — rerun the file, get the
 * same book. No Date.now anywhere in test logic; all timestamps grow from a
 * fixed local-time base (the ledger.test.mjs convention, so the suite passes
 * identically in any timezone).
 *
 * WHAT COUNTS AS THE CONTRACT HERE. The client type system plus migration
 * 0017's constraints: sign is a property of the kind (charge-side positive,
 * payment-side negative, adjustment nonzero), the deposit pot never goes
 * negative on a well-formed book, and the balance is ALWAYS a signed sum.
 * The generator produces only books the server would accept; the hostile
 * section then feeds the projection what the server would refuse, and PINS
 * the observed behaviour rather than inventing policy — see the comments on
 * each pin for what is a fact and what is a finding.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  projectLedger,
  oldestUnpaidMs,
  lateFeeDraft,
  paybackPercent,
  monthBounds,
  balanceCardText,
  monthlyStatementText,
} from '../src/ledger.ts'

// ---------------------------------------------------------------- the dice

/** mulberry32 — tiny, seedable, good enough for fuzz. */
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

function shuffled(r, xs) {
  const out = [...xs]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Local-time base — 1 Jan 2026, 00:00 local, like ledger.test.mjs's at(). */
const BASE_MS = new Date(2026, 0, 1).getTime()

/**
 * A random VALID book: a sequence the server's 0017 constraints would accept.
 * Sign per kind, adjustments nonzero, and the deposit pot never overdrawn —
 * apply/refund amounts are capped at what is actually held at that point.
 * Timestamps strictly increase from BASE_MS.
 */
function validBook(r, n) {
  const entries = []
  let pot = 0
  let t = BASE_MS
  for (let i = 0; i < n; i++) {
    t += int(r, 1, 3 * 24 * 3_600_000) // up to 3 days between lines
    const roll = r()
    let kind
    let amount
    if (roll < 0.35) {
      kind = pick(r, ['charge', 'late_fee', 'damage_charge'])
      amount = int(r, 1, 2_000_000) * 100
    } else if (roll < 0.6) {
      kind = 'payment'
      amount = -int(r, 1, 2_000_000) * 100
    } else if (roll < 0.7) {
      kind = 'adjustment'
      amount = (r() < 0.5 ? 1 : -1) * int(r, 1, 500_000) * 100
    } else if (roll < 0.85) {
      kind = 'deposit_hold'
      amount = int(r, 1, 1_000_000) * 100
      pot += amount
    } else if (pot > 0 && r() < 0.7) {
      kind = pick(r, ['deposit_apply', 'deposit_refund'])
      amount = -int(r, 1, pot / 100) * 100
      pot += amount
    } else {
      kind = 'charge'
      amount = int(r, 1, 2_000_000) * 100
    }
    entries.push({ kind, amountMinor: amount, createdAt: t })
  }
  return entries
}

/**
 * The reference projection, written as a DIFFERENT fold on purpose: filter
 * then reduce per rule, instead of one loop with branches. If the two ever
 * disagree the implementation drifted from the stated sign convention.
 */
function referenceProjection(entries) {
  const deposit = entries
    .filter((e) => ['deposit_hold', 'deposit_apply', 'deposit_refund'].includes(e.kind))
    .reduce((n, e) => n + e.amountMinor, 0)
  const balance = entries
    .filter((e) => !['deposit_hold', 'deposit_refund'].includes(e.kind))
    .reduce((n, e) => n + e.amountMinor, 0)
  return { balanceMinor: balance, depositHeldMinor: deposit }
}

const L = {
  balanceTitle: (name) => `Hisaab — ${name}`,
  statementTitle: (name, month) => `Statement — ${name} · ${month}`,
  balanceLine: (rupees) => `Balance: ${rupees}`,
  closingLine: (rupees) => `Closing balance: ${rupees}`,
  nothingOwed: 'Nothing owed',
  houseOwes: (rupees) => `You owe them ${rupees}`,
  owedSince: (date) => `Owed since ${date}`,
  kindLabel: (kind) => kind,
  nothingThisMonth: 'Nothing recorded this month.',
}

// ------------------------------------------------- projection invariants

describe('projection invariants over random valid books', () => {
  test('balance is the signed sum, on 200 random books', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed)
      const book = validBook(r, int(r, 0, 120))
      const got = projectLedger(book)
      const want = referenceProjection(book)
      assert.equal(got.balanceMinor, want.balanceMinor, `seed ${seed}: balance`)
      assert.equal(got.depositHeldMinor, want.depositHeldMinor, `seed ${seed}: pot`)
    }
  })

  test('order never matters: shuffled book, same projection', () => {
    for (let seed = 201; seed <= 260; seed++) {
      const r = rng(seed)
      const book = validBook(r, int(r, 2, 100))
      const base = projectLedger(book)
      for (let k = 0; k < 3; k++) {
        assert.deepEqual(projectLedger(shuffled(r, book)), base, `seed ${seed}`)
      }
    }
  })

  test('the deposit pot never goes negative at any prefix of a valid book', () => {
    for (let seed = 300; seed <= 380; seed++) {
      const r = rng(seed)
      const book = validBook(r, int(r, 1, 120))
      for (let i = 1; i <= book.length; i++) {
        const { depositHeldMinor } = projectLedger(book.slice(0, i))
        assert.ok(
          depositHeldMinor >= 0,
          `seed ${seed}: pot ${depositHeldMinor} negative after ${i} entries`,
        )
      }
    }
  })

  test('projection is prefix-incremental: adding one line moves the sums by exactly that line', () => {
    const r = rng(9001)
    const book = validBook(r, 150)
    let prev = { balanceMinor: 0, depositHeldMinor: 0 }
    for (let i = 0; i < book.length; i++) {
      const cur = projectLedger(book.slice(0, i + 1))
      const e = book[i]
      const isDeposit = ['deposit_hold', 'deposit_apply', 'deposit_refund'].includes(e.kind)
      const balanceDelta = isDeposit && e.kind !== 'deposit_apply' ? 0 : e.amountMinor
      const potDelta = isDeposit ? e.amountMinor : 0
      assert.equal(cur.balanceMinor - prev.balanceMinor, balanceDelta, `entry ${i} balance delta`)
      assert.equal(cur.depositHeldMinor - prev.depositHeldMinor, potDelta, `entry ${i} pot delta`)
      prev = cur
    }
  })
})

// ------------------------------------------------ the debt clock, fuzzed

describe('oldestUnpaidMs invariants over random valid books', () => {
  test('null exactly when nothing is owed; otherwise the timestamp of a real entry', () => {
    for (let seed = 400; seed <= 520; seed++) {
      const r = rng(seed)
      const book = validBook(r, int(r, 0, 100))
      const since = oldestUnpaidMs(book)
      const { balanceMinor } = projectLedger(book)
      if (balanceMinor <= 0) {
        assert.equal(since, null, `seed ${seed}: clean book must have no clock`)
      } else {
        assert.notEqual(since, null, `seed ${seed}: debt with no clock`)
        assert.ok(
          book.some((e) => e.createdAt === since),
          `seed ${seed}: 'since' must be an actual entry's timestamp`,
        )
      }
    }
  })

  test('order of the input array never matters', () => {
    for (let seed = 600; seed <= 650; seed++) {
      const r = rng(seed)
      const book = validBook(r, int(r, 2, 80))
      const base = oldestUnpaidMs(book)
      assert.equal(oldestUnpaidMs(shuffled(r, book)), base, `seed ${seed}`)
    }
  })

  test('monotonicity: a later charge never REWINDS the clock, a non-clearing payment never moves it', () => {
    for (let seed = 700; seed <= 800; seed++) {
      const r = rng(seed)
      const book = validBook(r, int(r, 1, 60))
      const before = oldestUnpaidMs(book)
      const balBefore = projectLedger(book).balanceMinor
      const lastT = book.length ? book[book.length - 1].createdAt : BASE_MS

      // Append a charge strictly later than everything.
      const charged = [...book, { kind: 'charge', amountMinor: 5_000_00, createdAt: lastT + 1000 }]
      const afterCharge = oldestUnpaidMs(charged)
      if (balBefore > 0) {
        assert.equal(afterCharge, before, `seed ${seed}: charge on live debt moved the clock`)
      } else if (balBefore + 5_000_00 > 0) {
        assert.equal(afterCharge, lastT + 1000, `seed ${seed}: charge that opens a debt starts the clock at itself`)
      } else {
        // Deep credit: the charge merely shrinks what the house owes THEM.
        assert.equal(afterCharge, null, `seed ${seed}: still in credit, no clock`)
      }

      // Append a payment that does NOT clear the (positive) balance.
      if (balBefore > 100) {
        const partial = [
          ...book,
          { kind: 'payment', amountMinor: -(balBefore - 100), createdAt: lastT + 2000 },
        ]
        assert.equal(oldestUnpaidMs(partial), before, `seed ${seed}: partial payment reset the clock`)
        // And one that clears it exactly: the clock must reset.
        const cleared = [
          ...book,
          { kind: 'payment', amountMinor: -balBefore, createdAt: lastT + 2000 },
        ]
        assert.equal(oldestUnpaidMs(cleared), null, `seed ${seed}: exact clearing left the clock running`)
      }
    }
  })
})

// -------------------------------------------------- month-edge statements

describe('statements at month boundaries', () => {
  const NAMES = { customerName: 'Bilal Hussain', houseName: 'Lightcraft Rentals' }

  test('23:59:59.999 on the last day is IN the month; 00:00 on the 1st is the NEXT month', () => {
    const lastTick = new Date(2026, 8, 30, 23, 59, 59, 999).getTime() // 30 Sep
    const firstTick = new Date(2026, 9, 1, 0, 0, 0, 0).getTime() // 1 Oct
    const entries = [
      { kind: 'charge', amountMinor: 10_000_00, createdAt: lastTick },
      { kind: 'charge', amountMinor: 77_000_00, createdAt: firstTick },
    ]
    const sep = monthlyStatementText(
      { ...NAMES, entries, nowMs: new Date(2026, 8, 15).getTime(), paymentLine: null },
      L,
    )
    assert.ok(sep.includes('30 Sep'), 'the last-millisecond charge is on the September statement')
    assert.ok(!sep.includes('77,000'), 'the midnight charge is not')
    assert.ok(sep.includes('Closing balance: Rs 10,000'), 'and the October line stays out of the closing sum')

    const oct = monthlyStatementText(
      { ...NAMES, entries, nowMs: new Date(2026, 9, 15).getTime(), paymentLine: null },
      L,
    )
    assert.ok(oct.includes('1 Oct'), 'the midnight charge opens October')
    assert.ok(oct.includes('Closing balance: Rs 87,000'), "October's closing carries September's debt")
  })

  test('closing balance always equals the projection up to month end, over random books', () => {
    for (let seed = 900; seed <= 960; seed++) {
      const r = rng(seed)
      const book = validBook(r, int(r, 1, 90))
      const nowMs = pick(r, book).createdAt
      const { endMs } = monthBounds(nowMs)
      const upToEnd = book.filter((e) => e.createdAt < endMs)
      const want = projectLedger(upToEnd).balanceMinor
      const text = monthlyStatementText({ ...NAMES, entries: book, nowMs, paymentLine: null }, L)
      const line = text.split('\n').find((l) => l.startsWith('Closing balance:'))
      assert.ok(line, `seed ${seed}: no closing line`)
      // Reproduce the projection's own formatting rather than parsing rupees
      // back out of the string — the assertion is about WHICH sum was closed.
      assert.equal(line, `Closing balance: ${formatLikeCard(want)}`, `seed ${seed}`)
    }
  })

  test('December and January statements agree about the year boundary', () => {
    const dec31 = new Date(2026, 11, 31, 23, 59).getTime()
    const jan1 = new Date(2027, 0, 1, 0, 0).getTime()
    const entries = [
      { kind: 'charge', amountMinor: 5_000_00, createdAt: dec31 },
      { kind: 'payment', amountMinor: -5_000_00, createdAt: jan1 },
    ]
    const dec = monthlyStatementText({ ...NAMES, entries, nowMs: dec31, paymentLine: null }, L)
    assert.ok(dec.includes('Dec 2026'))
    assert.ok(dec.includes('Closing balance: Rs 5,000'), 'the Jan payment must not leak into Dec')
    const jan = monthlyStatementText({ ...NAMES, entries, nowMs: jan1, paymentLine: null }, L)
    assert.ok(jan.includes('Jan 2027'))
    assert.ok(jan.includes('Closing balance: Rs 0'))
  })
})

/** Mirror of money.ts formatRupees, minimal, for closing-line assertions. */
function formatLikeCard(minor) {
  const rupees = Math.round(minor / 100)
  const sign = rupees < 0 ? '-' : ''
  return `Rs ${sign}${String(Math.abs(rupees)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`
}

// ------------------------------------------------------- hostile inputs

describe('hostile books — pinned behaviour, not policy', () => {
  test('PIN: an unknown kind is treated as a plain balance line, silently', () => {
    // The client does NOT validate kinds — the server's ledger_kind_check
    // (migration 0017) is the gate, and rowsFor casts whatever the local
    // table holds. Pinned so a future validation layer is a CONSCIOUS
    // change: today a bogus kind flows straight into the balance.
    const p = projectLedger([
      { kind: 'bogus_kind', amountMinor: 4_000_00, createdAt: BASE_MS },
    ])
    assert.equal(p.balanceMinor, 4_000_00)
    assert.equal(p.depositHeldMinor, 0)
  })

  test("PIN: the server's 'write_off' kind — absent from the client type — projects correctly by that same fallthrough", () => {
    // 0017 allows 'write_off' (negative, note required). The client union
    // does not include it, but because unknown kinds land in the balance,
    // a synced write_off row reduces the debt exactly as it should. The
    // type gap is reported as a finding; the arithmetic is correct today.
    const p = projectLedger([
      { kind: 'charge', amountMinor: 10_000_00, createdAt: BASE_MS },
      { kind: 'write_off', amountMinor: -10_000_00, createdAt: BASE_MS + 1 },
    ])
    assert.equal(p.balanceMinor, 0)
  })

  test('PIN: zero-amount lines are accepted and change nothing (the server would refuse them)', () => {
    const book = [
      { kind: 'charge', amountMinor: 7_000_00, createdAt: BASE_MS },
      { kind: 'adjustment', amountMinor: 0, createdAt: BASE_MS + 1 },
      { kind: 'payment', amountMinor: 0, createdAt: BASE_MS + 2 },
    ]
    assert.equal(projectLedger(book).balanceMinor, 7_000_00)
    // And a zero line never resets the debt clock.
    assert.equal(oldestUnpaidMs(book), BASE_MS)
  })

  test('PIN: wrong-signed lines are summed as given — sign enforcement is 0017, not the projection', () => {
    const p = projectLedger([
      { kind: 'payment', amountMinor: 5_000_00, createdAt: BASE_MS }, // positive "payment"
      { kind: 'charge', amountMinor: -3_000_00, createdAt: BASE_MS + 1 }, // negative "charge"
    ])
    assert.equal(p.balanceMinor, 2_000_00)
  })

  test('huge but realistic amounts stay exact: a crore book in paisa never loses a paisa', () => {
    // Rs 1 crore = 10^9 paisa; a thousand such lines is 10^12, well inside
    // Number.MAX_SAFE_INTEGER (9×10^15). Every sum must stay integral.
    const r = rng(31337)
    const entries = []
    let t = BASE_MS
    let want = 0
    for (let i = 0; i < 1000; i++) {
      t += 1000
      const amount = (r() < 0.5 ? 1 : -1) * int(r, 1, 10_000_000) * 100
      want += amount
      entries.push({ kind: r() < 0.5 ? 'charge' : 'payment', amountMinor: amount, createdAt: t })
    }
    const p = projectLedger(entries)
    assert.equal(p.balanceMinor, want)
    assert.ok(Number.isSafeInteger(p.balanceMinor))
  })

  test('the balance card survives an empty book and a negative (house-owes-them) book', () => {
    const empty = balanceCardText(
      { customerName: 'N', houseName: 'H', entries: [], paymentLine: 'JazzCash: 0300 0000000' },
      L,
    )
    assert.ok(empty.includes('Nothing owed'))
    assert.ok(!empty.includes('JazzCash'), 'no debt, no payment nag')

    // RESOLVED-with-default (POLICY, owner may overrule): when the HOUSE
    // owes the CUSTOMER, the card says so plainly — the headline is the
    // houseOwes line naming the credit, never a shrugged 'Nothing owed'.
    const credit = balanceCardText(
      {
        customerName: 'N',
        houseName: 'H',
        entries: [{ kind: 'payment', amountMinor: -9_000_00, createdAt: BASE_MS }],
        paymentLine: null,
      },
      L,
    )
    assert.ok(credit.includes('You owe them Rs 9,000'))
    assert.ok(!credit.includes('Nothing owed'))
    assert.ok(!credit.includes('Balance:'), 'the credit is not disguised as a debt balance')
  })

  test('payback with zero, negative, and missing replacement values refuses a made-up denominator', () => {
    assert.equal(paybackPercent(50_000_00, 0), null)
    assert.equal(paybackPercent(50_000_00, -100), null)
    assert.equal(paybackPercent(50_000_00, null), null)
    assert.equal(paybackPercent(50_000_00, undefined), null)
    // Zero earned against a real denominator is an honest 0%.
    assert.equal(paybackPercent(0, 100_00), 0)
  })

  test('late-fee draft with zero/negative days and empty rate lists never invents money', () => {
    assert.equal(lateFeeDraft(0, []).totalMinor, 0)
    assert.equal(lateFeeDraft(-5, [10_000_00]).totalMinor, 0)
    const none = lateFeeDraft(3, [])
    assert.equal(none.totalMinor, 0)
    assert.equal(none.priced, 0, 'nothing priced — the caller must render silence, not Rs 0')
  })
})
