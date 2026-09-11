/**
 * The partner broadcasts — golden texts in both languages (partners.ts).
 *
 * These leave the app on WhatsApp, so the exact wording is the contract:
 * the ask-the-market message from shortage lines, and the partner-group
 * stolen line with and without the public tag page.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { askTheMarketText, stolenBroadcastText, windowLabel } from '../src/partners.ts'

// Local 2026-11-21 06:00 → 2026-11-23 18:00, and a one-day window.
const sat = new Date(2026, 10, 21, 6).getTime()
const mon = new Date(2026, 10, 23, 18).getTime()
const tueMidnight = new Date(2026, 10, 25, 0).getTime()

const org = { name: 'Ravi Light & Grip', phone: '0300 1234567' }

describe('the window label', () => {
  test('two days read as a range', () => {
    assert.equal(windowLabel(sat, mon), 'Sat 21 Nov – Mon 23 Nov')
  })
  test("a '[)' window ending at midnight names the day before", () => {
    assert.equal(windowLabel(mon, tueMidnight), 'Mon 23 Nov – Tue 24 Nov')
  })
  test('a same-day window is one day', () => {
    assert.equal(windowLabel(sat, sat + 3_600_000), 'Sat 21 Nov')
  })
})

describe('ask the market', () => {
  const shortage = [
    { productName: 'Sony FX9', qty: 1, fromMs: sat, untilMs: mon },
    { productName: 'Aputure 600D Pro', qty: 2, fromMs: sat, untilMs: mon },
  ]

  test('English golden', () => {
    assert.equal(
      askTheMarketText(shortage, org, 'en'),
      [
        'Ravi Light & Grip — looking for gear',
        '',
        '1 x Sony FX9 · Sat 21 Nov – Mon 23 Nov',
        '2 x Aputure 600D Pro · Sat 21 Nov – Mon 23 Nov',
        '',
        'If you have it, please let us know on 0300 1234567. Thank you.',
      ].join('\n'),
    )
  })

  test('Roman Urdu golden', () => {
    assert.equal(
      askTheMarketText(shortage, org, 'ur'),
      [
        'Ravi Light & Grip — kuch gear chahiye',
        '',
        '1 x Sony FX9 · Sat 21 Nov – Mon 23 Nov',
        '2 x Aputure 600D Pro · Sat 21 Nov – Mon 23 Nov',
        '',
        'Agar kisi ke paas ho to 0300 1234567 par bata dein. Shukriya.',
      ].join('\n'),
    )
  })

  test('no phone: the reply goes back to the thread', () => {
    const en = askTheMarketText(shortage.slice(0, 1), { name: 'Ravi', phone: null }, 'en')
    assert.match(en, /please reply here\. Thank you\.$/)
    const ur = askTheMarketText(shortage.slice(0, 1), { name: 'Ravi', phone: null }, 'ur')
    assert.match(ur, /yahin reply kar dein\. Shukriya\.$/)
  })
})

describe('the stolen broadcast', () => {
  const facts = {
    assetCode: 'FX9-01',
    serialNumber: 'SN-7781',
    productName: 'Sony FX9',
    tagCode: 'v1ABCDEFGH',
    publicUrl: 'https://tags.example/v1ABCDEFGH',
    orgName: 'Ravi Light & Grip',
    orgPhone: '0300 1234567',
  }

  test('Roman Urdu first for the partner group, link last', () => {
    assert.equal(
      stolenBroadcastText(facts, 'ur'),
      'CHORI / STOLEN — Sony FX9 (FX9-01), serial SN-7781, tag v1ABCDEFGH. '
        + 'Yeh Ravi Light & Grip ka saman hai aur chori ho gaya hai. '
        + 'Agar koi bechne ya rent par dene aaye to please 0300 1234567 par call karein. '
        + '/ This item was stolen from Ravi Light & Grip. If you are offered it, please call 0300 1234567. '
        + 'https://tags.example/v1ABCDEFGH',
    )
  })

  test('English first when the app speaks English', () => {
    const t = stolenBroadcastText(facts, 'en')
    assert.match(t, /^CHORI \/ STOLEN — Sony FX9 \(FX9-01\), serial SN-7781, tag v1ABCDEFGH\. This item was stolen from/)
    assert.match(t, /\/ Yeh Ravi Light & Grip ka saman hai/)
    assert.match(t, / https:\/\/tags\.example\/v1ABCDEFGH$/)
  })

  test('no public page, no serial, no phone: the honest short form', () => {
    const t = stolenBroadcastText(
      { ...facts, publicUrl: null, serialNumber: null, tagCode: null, orgPhone: null },
      'ur',
    )
    assert.equal(
      t,
      'CHORI / STOLEN — Sony FX9 (FX9-01). '
        + 'Yeh Ravi Light & Grip ka saman hai aur chori ho gaya hai. '
        + 'Agar koi bechne ya rent par dene aaye to please humein par call karein. '
        + '/ This item was stolen from Ravi Light & Grip. If you are offered it, please call us.',
    )
    assert.doesNotMatch(t, /https?:/)
  })
})
