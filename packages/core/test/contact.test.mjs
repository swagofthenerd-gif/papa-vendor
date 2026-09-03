/**
 * Getting from "whatever got typed in the contact field" to a tappable
 * WhatsApp or dialer link. The test that matters most is the refusal: a
 * number we are not sure about must come back null, because a polite nudge
 * sent to a stranger's phone in the vendor's name is worse than no link.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  parsePhoneNumber,
  whatsAppNudgeUrl,
  whatsAppChatUrl,
  telUrl,
  overdueNudgeMessage,
  OVERDUE_NUDGE_TEMPLATE,
} from '../src/share.ts'

describe('parsing a Pakistani mobile out of free text', () => {
  test('the review example: name, role in brackets, spaced number', () => {
    assert.equal(parsePhoneNumber('Bilal (prod) 0300 4412233'), '923004412233')
  })

  test('every common way the same number gets written', () => {
    for (const v of [
      '03004412233',
      '0300-4412233',
      '0300 441 2233',
      '+923004412233',
      '+92 300 4412233',
      '+92-300-4412233',
      '923004412233',
      '00923004412233',
      '0092 300 4412233',
    ]) {
      assert.equal(parsePhoneNumber(v), '923004412233', v)
    }
  })

  test('the number is found wherever it sits in the text', () => {
    assert.equal(parsePhoneNumber('call krlena 0300 4412233 shukriya'), '923004412233')
    assert.equal(parsePhoneNumber('Shan Foods / Areeb +92 301 2345678'), '923012345678')
  })

  test('no number means null, not a guess', () => {
    assert.equal(parsePhoneNumber('Bilal from production'), null)
    assert.equal(parsePhoneNumber(''), null)
    assert.equal(parsePhoneNumber(null), null)
    assert.equal(parsePhoneNumber(undefined), null)
  })

  test('wrong shapes are refused: landlines, short codes, truncated mobiles', () => {
    assert.equal(parsePhoneNumber('042 35761234'), null, 'Lahore landline')
    assert.equal(parsePhoneNumber('rescue 1122'), null, 'short code')
    assert.equal(parsePhoneNumber('0300 441223'), null, 'a digit short')
    assert.equal(parsePhoneNumber('0300 44122334'), null, 'a digit long')
    assert.equal(parsePhoneNumber('+92 42 35761234'), null, '+92 landline is still not a mobile')
  })

  test('two numbers run together are ambiguous, so: null', () => {
    assert.equal(parsePhoneNumber('0300 4412233 0301 1234567'), null)
  })

  test('a number embedded amongst other digits does not half-match', () => {
    assert.equal(parsePhoneNumber('invoice 2026-4412233'), null)
  })
})

describe('the links built from a parsed number', () => {
  test('wa.me link carries the number bare and the message encoded', () => {
    const url = whatsAppNudgeUrl('923004412233', 'Salam — FX9 wapis?')
    assert.ok(url.startsWith('https://wa.me/923004412233?text='))
    assert.ok(!url.includes(' '), 'no raw spaces in a url')
    const back = decodeURIComponent(url.split('?text=')[1])
    assert.equal(back, 'Salam — FX9 wapis?')
  })

  test('tel link puts the + back for the dialer', () => {
    assert.equal(telUrl('923004412233'), 'tel:+923004412233')
  })

  test('plain chat link carries the number and nothing else', () => {
    // No ?text= at all: this is "open the thread", not "send our sentence".
    assert.equal(whatsAppChatUrl('923004412233'), 'https://wa.me/923004412233')
  })
})

describe('the overdue nudge message', () => {
  test('fills every placeholder from the template', () => {
    const msg = overdueNudgeMessage({
      jobLabel: 'Shan Foods TVC',
      itemsSummary: '2x Sony FX9, 1x Sachtler Tripod',
      dueLabel: '3 days late',
    })
    assert.ok(msg.startsWith('Salam — '), 'lens-4 register: opens with Salam')
    assert.ok(msg.includes('Shan Foods TVC'))
    assert.ok(msg.includes('2x Sony FX9, 1x Sachtler Tripod'))
    assert.ok(msg.includes('3 days late'))
    assert.ok(!msg.includes('{'), 'no placeholder survives filling')
  })

  test('the wording lives in one editable constant, as data', () => {
    assert.equal(typeof OVERDUE_NUDGE_TEMPLATE, 'string')
    for (const ph of ['{jobLabel}', '{itemsSummary}', '{dueLabel}']) {
      assert.ok(OVERDUE_NUDGE_TEMPLATE.includes(ph), ph)
    }
  })

  test('stays polite when the honest label is "no date"', () => {
    const msg = overdueNudgeMessage({
      jobLabel: 'Mehndi shoot',
      itemsSummary: '1x V-Mount Battery',
      dueLabel: 'no date',
    })
    assert.ok(msg.includes('no date'), 'never invents a due date for the client')
  })

  test('template, message and links compose into one send action', () => {
    const number = parsePhoneNumber('Bilal (prod) 0300 4412233')
    const msg = overdueNudgeMessage({
      jobLabel: 'Shan Foods TVC',
      itemsSummary: '1x Sony FX9',
      dueLabel: '1 day late',
    })
    const url = whatsAppNudgeUrl(number, msg)
    assert.ok(url.startsWith('https://wa.me/923004412233?text=Salam'))
  })
})
