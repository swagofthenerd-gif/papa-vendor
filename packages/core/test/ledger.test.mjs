/**
 * The udhaar ledger — the projection and the two money documents.
 *
 * The ledger is append-only and the balance is a PROJECTION; these tests pin
 * the sign convention (positive = owed, negative = received), the deposit
 * pot's separation from the debt, the "owed since" clock reset, the late-fee
 * draft's honesty about rateless items, and the exact text of the balance
 * card and the monthly statement — the two messages a client actually reads.
 *
 * All timestamps are built with the local-time Date constructor so the suite
 * passes identically in any timezone.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  projectLedger,
  oldestUnpaidMs,
  lateFeeDraft,
  paybackPercent,
  signedRupees,
  ledgerDate,
  monthBounds,
  balanceCardText,
  monthlyStatementText,
} from '../src/ledger.ts'

const at = (y, m, d) => new Date(y, m - 1, d).getTime()

/** A ledger line with only what the projection needs. */
const e = (kind, rupees, createdAt, extra = {}) => ({
  kind,
  amountMinor: rupees * 100,
  createdAt,
  ...extra,
})

/** Plain English-shaped labels for the document tests that are not about
 *  language — the both-language goldens live in the app's khata tests,
 *  rendered from the real string tables. */
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

describe('projectLedger', () => {
  test('charges add, payments subtract, in any order', () => {
    const p = projectLedger([
      e('payment', -30_000, at(2026, 8, 12)),
      e('charge', 60_000, at(2026, 8, 9)),
      e('late_fee', 5_000, at(2026, 8, 20)),
      e('damage_charge', 8_000, at(2026, 8, 21)),
      e('adjustment', -3_000, at(2026, 8, 22)),
    ])
    assert.equal(p.balanceMinor, 40_000 * 100)
    assert.equal(p.depositHeldMinor, 0)
  })

  test('an empty book owes nothing and holds nothing', () => {
    assert.deepEqual(projectLedger([]), { balanceMinor: 0, depositHeldMinor: 0 })
  })

  test('deposits live in their own pot, never in the balance', () => {
    const p = projectLedger([
      e('charge', 40_000, at(2026, 9, 1)),
      e('deposit_hold', 50_000, at(2026, 9, 1)),
      e('payment', -40_000, at(2026, 9, 3)),
    ])
    // Paid up — the held cheque is the customer's money, not a credit.
    assert.equal(p.balanceMinor, 0)
    assert.equal(p.depositHeldMinor, 50_000 * 100)
  })

  test('deposit_apply drains the pot AND pays the debt', () => {
    const p = projectLedger([
      e('charge', 40_000, at(2026, 9, 1)),
      e('deposit_hold', 50_000, at(2026, 9, 1)),
      e('deposit_apply', -30_000, at(2026, 9, 5)),
    ])
    assert.equal(p.balanceMinor, 10_000 * 100)
    assert.equal(p.depositHeldMinor, 20_000 * 100)
  })

  test('deposit_refund drains only the pot', () => {
    const p = projectLedger([
      e('deposit_hold', 50_000, at(2026, 9, 1)),
      e('deposit_refund', -50_000, at(2026, 9, 9)),
    ])
    assert.equal(p.balanceMinor, 0)
    assert.equal(p.depositHeldMinor, 0)
  })

  test('overpayment goes negative: the house owes THEM, said plainly', () => {
    const p = projectLedger([
      e('charge', 20_000, at(2026, 9, 1)),
      e('payment', -25_000, at(2026, 9, 2)),
    ])
    assert.equal(p.balanceMinor, -5_000 * 100)
  })
})

describe('oldestUnpaidMs', () => {
  test('null when nothing is owed now', () => {
    assert.equal(oldestUnpaidMs([]), null)
    assert.equal(
      oldestUnpaidMs([
        e('charge', 10_000, at(2026, 8, 1)),
        e('payment', -10_000, at(2026, 8, 5)),
      ]),
      null,
    )
  })

  test('a clearing payment resets the clock; the next charge starts it', () => {
    const since = oldestUnpaidMs([
      e('charge', 10_000, at(2026, 7, 1)),
      e('payment', -10_000, at(2026, 7, 10)),
      e('charge', 20_000, at(2026, 8, 9)),
    ])
    assert.equal(since, at(2026, 8, 9))
  })

  test('a partial payment does NOT reset the clock', () => {
    const since = oldestUnpaidMs([
      e('charge', 60_000, at(2026, 8, 9)),
      e('payment', -30_000, at(2026, 8, 12)),
      e('charge', 45_000, at(2026, 9, 10)),
    ])
    // Still owed since the first charge — the debt never touched zero.
    assert.equal(since, at(2026, 8, 9))
  })

  test('entry order in the array does not matter', () => {
    const entries = [
      e('charge', 20_000, at(2026, 8, 9)),
      e('charge', 10_000, at(2026, 7, 1)),
      e('payment', -10_000, at(2026, 7, 10)),
    ]
    assert.equal(oldestUnpaidMs(entries), at(2026, 8, 9))
    assert.equal(oldestUnpaidMs([...entries].reverse()), at(2026, 8, 9))
  })

  test('held deposits neither start nor stop the debt clock', () => {
    const since = oldestUnpaidMs([
      e('deposit_hold', 50_000, at(2026, 8, 1)),
      e('charge', 20_000, at(2026, 8, 9)),
    ])
    assert.equal(since, at(2026, 8, 9))
  })
})

describe('lateFeeDraft', () => {
  test('days × the summed day rates', () => {
    const draft = lateFeeDraft(3, [25_000_00, 8_000_00])
    assert.equal(draft.totalMinor, 3 * 33_000_00)
    assert.equal(draft.priced, 2)
    assert.equal(draft.unpriced, 0)
  })

  test('rateless items are counted, never priced at zero', () => {
    const draft = lateFeeDraft(2, [25_000_00, null, undefined])
    assert.equal(draft.totalMinor, 2 * 25_000_00)
    assert.equal(draft.unpriced, 2)
  })

  test('nothing priced means no figure — the caller must not say Rs 0', () => {
    const draft = lateFeeDraft(4, [null, null])
    assert.equal(draft.priced, 0)
    assert.equal(draft.totalMinor, 0)
  })

  test('zero or negative days draft nothing', () => {
    assert.equal(lateFeeDraft(0, [25_000_00]).totalMinor, 0)
    assert.equal(lateFeeDraft(-2, [25_000_00]).totalMinor, 0)
  })
})

describe('paybackPercent', () => {
  test('earned over replacement, rounded', () => {
    assert.equal(paybackPercent(105_000_00, 3_500_000_00), 3)
    assert.equal(paybackPercent(1_750_000_00, 3_500_000_00), 50)
  })

  test('past 100% is reported, not clamped — that is the celebration', () => {
    assert.equal(paybackPercent(4_550_000_00, 3_500_000_00), 130)
  })

  test('no replacement value means no bar, never a made-up denominator', () => {
    assert.equal(paybackPercent(105_000_00, null), null)
    assert.equal(paybackPercent(105_000_00, undefined), null)
    assert.equal(paybackPercent(105_000_00, 0), null)
  })
})

describe('signedRupees and ledgerDate', () => {
  test('the signed voice of the ledger column', () => {
    assert.equal(signedRupees(40_000_00), '+Rs 40,000')
    assert.equal(signedRupees(-20_000_00), '-Rs 20,000')
    assert.equal(signedRupees(0), 'Rs 0')
  })

  test('the row date is deterministic, no locale', () => {
    assert.equal(ledgerDate(at(2026, 8, 9)), '9 Aug')
    assert.equal(ledgerDate(at(2026, 12, 31)), '31 Dec')
  })
})

describe('monthBounds', () => {
  test('the local calendar month, labelled', () => {
    const m = monthBounds(at(2026, 9, 11))
    assert.equal(m.startMs, at(2026, 9, 1))
    assert.equal(m.endMs, at(2026, 10, 1))
    assert.equal(m.label, 'Sep 2026')
  })

  test('December rolls into January without arithmetic drift', () => {
    const m = monthBounds(at(2026, 12, 15))
    assert.equal(m.endMs, at(2027, 1, 1))
  })
})

describe('balanceCardText', () => {
  const entries = [
    e('charge', 60_000, at(2026, 8, 9), { jobLabel: 'Shan Foods stills' }),
    e('payment', -30_000, at(2026, 8, 12)),
    e('charge', 45_000, at(2026, 9, 10), { jobLabel: 'Shan Foods TVC' }),
  ]

  test('what is owed, the last three lines, since when, how to pay', () => {
    const text = balanceCardText(
      {
        customerName: 'Bilal Hussain',
        houseName: 'Lightcraft Rentals',
        entries,
        paymentLine: 'JazzCash: 0300 1234567',
      },
      L,
    )
    assert.equal(
      text,
      [
        'Hisaab — Bilal Hussain',
        'Lightcraft Rentals',
        '',
        'Balance: Rs 75,000',
        '',
        '9 Aug  charge  +Rs 60,000',
        '12 Aug  payment  -Rs 30,000',
        '10 Sep  charge  +Rs 45,000',
        '',
        'Owed since 9 Aug',
        'JazzCash: 0300 1234567',
      ].join('\n'),
    )
  })

  test('a clean khata says so, and carries no payment line', () => {
    const text = balanceCardText(
      {
        customerName: 'Hamza Saeed',
        houseName: 'Lightcraft Rentals',
        entries: [
          e('charge', 80_000, at(2026, 8, 22)),
          e('payment', -80_000, at(2026, 8, 24)),
        ],
        paymentLine: 'JazzCash: 0300 1234567',
      },
      L,
    )
    assert.ok(text.includes('Nothing owed'))
    assert.ok(!text.includes('Owed since'))
    // Nothing is owed, so asking how to pay would read as a threat.
    assert.ok(!text.includes('JazzCash'))
  })

  test('no configured payment line, no payment line', () => {
    const text = balanceCardText(
      { customerName: 'B', houseName: 'H', entries, paymentLine: null },
      L,
    )
    assert.ok(!text.includes('JazzCash'))
  })

  test('only the LAST three entries are recited', () => {
    const busy = [
      e('charge', 1_000, at(2026, 6, 1)),
      e('charge', 2_000, at(2026, 7, 1)),
      ...entries,
    ]
    const text = balanceCardText(
      { customerName: 'B', houseName: 'H', entries: busy, paymentLine: null },
      L,
    )
    // Three signed rows, and they are the newest three. 'Owed since 1 Jun'
    // still appears below — the debt clock is a separate, honest fact.
    const rows = text.split('\n').filter((l) => /[+-]Rs /.test(l))
    assert.equal(rows.length, 3)
    assert.ok(rows[0].startsWith('9 Aug'))
    assert.ok(rows[2].startsWith('10 Sep'))
    assert.ok(text.includes('Owed since 1 Jun'))
  })
})

describe('monthlyStatementText', () => {
  const entries = [
    e('charge', 60_000, at(2026, 8, 9), { jobLabel: 'Shan Foods stills' }),
    e('payment', -30_000, at(2026, 8, 12)),
    e('charge', 45_000, at(2026, 9, 10), { jobLabel: 'Shan Foods TVC' }),
  ]

  test('the month shown, the whole account closed', () => {
    const text = monthlyStatementText(
      {
        customerName: 'Bilal Hussain',
        houseName: 'Lightcraft Rentals',
        entries,
        nowMs: at(2026, 9, 11),
        paymentLine: 'JazzCash: 0300 1234567',
      },
      L,
    )
    assert.equal(
      text,
      [
        'Statement — Bilal Hussain · Sep 2026',
        'Lightcraft Rentals',
        '',
        '10 Sep  charge — Shan Foods TVC  +Rs 45,000',
        '',
        // Rs 75,000, not Rs 45,000: last month's unpaid Rs 30,000 is part of
        // the account — a closing line that ignored it would be a lie.
        'Closing balance: Rs 75,000',
        'JazzCash: 0300 1234567',
      ].join('\n'),
    )
  })

  test('a quiet month still closes the account honestly', () => {
    const text = monthlyStatementText(
      {
        customerName: 'B',
        houseName: 'H',
        entries,
        nowMs: at(2026, 10, 5),
        paymentLine: null,
      },
      L,
    )
    assert.ok(text.includes('Nothing recorded this month.'))
    assert.ok(text.includes('Closing balance: Rs 75,000'))
  })

  test('entries after month end do not leak into the closing balance', () => {
    const withFuture = [...entries, e('charge', 99_000, at(2026, 10, 2))]
    const text = monthlyStatementText(
      {
        customerName: 'B',
        houseName: 'H',
        entries: withFuture,
        nowMs: at(2026, 9, 11),
        paymentLine: null,
      },
      L,
    )
    assert.ok(text.includes('Closing balance: Rs 75,000'))
    assert.ok(!text.includes('99,000'))
  })
})
