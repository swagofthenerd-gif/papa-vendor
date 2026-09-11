/**
 * The thermal parchi's byte stream — golden-tested (escpos.ts).
 *
 * Hardware is unverified (no printer was connected; see the module
 * header and docs/production-readiness.md), so the exact bytes are the
 * contract: the init header, the QR command block with its pL pH length
 * bytes computed correctly, the cut at the very end, width-32 wrapping,
 * and the ASCII fold. The full-stream golden below is spelled out by
 * hand from the ESC/POS reference, NOT derived from the function — the
 * whole point is that a future edit cannot quietly move a byte.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildParchiEscPos,
  parchiDocFromText,
  qrCommands,
  toAscii,
  wrapLine,
  ESCPOS_INIT,
  ESCPOS_CUT,
} from '../src/escpos.ts'

const A = (s) => [...s].map((c) => c.charCodeAt(0))
const LF = 0x0a

/** A tiny parchi: everything fits on one line each, one-byte QR payload. */
const tiny = {
  title: 'PARCHI - Ravi',
  subtitle: 'Job',
  lines: ['OUT (1):', 'FX9-01  Sony FX9'],
  qrText: 'X',
}

/** The stream for `tiny`, by hand from the reference. */
const TINY_GOLDEN = [
  0x1b, 0x40,                 // ESC @  init
  0x1b, 0x61, 0x01,           // ESC a 1  centre
  0x1b, 0x45, 0x01,           // ESC E 1  bold on
  0x1d, 0x21, 0x11,           // GS ! 0x11  double height + width
  ...A('PARCHI - Ravi'), LF,
  0x1d, 0x21, 0x00,           // GS ! 0  normal size
  ...A('Job'), LF,
  0x1b, 0x45, 0x00,           // bold off
  LF,
  0x1b, 0x61, 0x00,           // left
  ...A('OUT (1):'), LF,
  ...A('FX9-01  Sony FX9'), LF,
  LF,
  0x1b, 0x61, 0x01,           // centre for the QR
  0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,   // model 2
  0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x06,         // module size 6
  0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,         // EC level M
  0x1d, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x50, 0x30, ...A('X'), // store: k = 1 + 3
  0x1d, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,         // print
  LF,
  0x1b, 0x61, 0x00,
  LF, LF, LF,
  0x1d, 0x56, 0x42, 0x00,     // GS V 66 0  feed + partial cut
]

describe('the full stream', () => {
  test('matches the hand-written golden byte for byte', () => {
    const bytes = buildParchiEscPos(tiny, { width: 32 })
    assert.ok(bytes instanceof Uint8Array)
    assert.deepEqual([...bytes], TINY_GOLDEN)
  })

  test('starts with ESC @ and ends with the cut', () => {
    const bytes = [...buildParchiEscPos(tiny, { width: 32 })]
    assert.deepEqual(bytes.slice(0, 2), [...ESCPOS_INIT])
    assert.deepEqual(bytes.slice(-4), [...ESCPOS_CUT])
  })

  test('a pinned code page rides ESC t right after init', () => {
    const bytes = [...buildParchiEscPos(tiny, { width: 32, codepage: 16 })]
    assert.deepEqual(bytes.slice(0, 5), [0x1b, 0x40, 0x1b, 0x74, 16])
  })

  test('no QR block when qrText is null', () => {
    const bytes = [...buildParchiEscPos({ ...tiny, qrText: null }, { width: 32 })]
    const hasQr = bytes.some((b, i) => b === 0x1d && bytes[i + 1] === 0x28 && bytes[i + 2] === 0x6b)
    assert.equal(hasQr, false)
    assert.deepEqual(bytes.slice(-4), [...ESCPOS_CUT])
  })
})

describe('the QR command block', () => {
  test('pL pH count the data plus the three function bytes', () => {
    const payload = 'A'.repeat(300)          // k = 303 = 0x012F
    const cmd = qrCommands(payload)
    const store = cmd.indexOf(0x50, 30) - 6  // the GS before the store fn
    assert.deepEqual(cmd.slice(store, store + 8), [0x1d, 0x28, 0x6b, 0x2f, 0x01, 0x31, 0x50, 0x30])
    assert.deepEqual(cmd.slice(store + 8, store + 8 + 300), A(payload))
  })

  test('refuses a payload no QR symbol can hold', () => {
    assert.throws(() => qrCommands('x'.repeat(7090)), /too long/)
  })

  test('the payload is folded to ASCII like the text', () => {
    const cmd = qrCommands('PARCHI — Ravi')
    const store = cmd.indexOf(0x50, 30) + 2
    assert.deepEqual(cmd.slice(store, store + 13), A('PARCHI - Ravi'))
  })
})

describe('width-32 wrapping', () => {
  test('a 40-char body line wraps at a word boundary inside 32', () => {
    const long = 'Sigma 18-35mm f1.8 lens with the matte box' // 42 chars
    assert.deepEqual(wrapLine(long, 32), ['Sigma 18-35mm f1.8 lens with the', 'matte box'])
    for (const l of wrapLine(long, 32)) assert.ok(l.length <= 32)
  })

  test('a word longer than the width is hard-broken', () => {
    const word = 'x'.repeat(70)
    assert.deepEqual(wrapLine(word, 32), ['x'.repeat(32), 'x'.repeat(32), 'x'.repeat(6)])
  })

  test('the double-width title wraps at half the paper', () => {
    const doc = { title: 'A Rental House With A Long Name', lines: [], qrText: null }
    const bytes = buildParchiEscPos(doc, { width: 32 })
    const text = String.fromCharCode(...bytes)
    // 31 chars at double width is two printed lines of at most 16.
    assert.match(text, /A Rental House\nWith A Long Name\n/)
  })

  test('the wrapped body shows in the stream, every line inside the width', () => {
    const doc = { title: 'T', lines: ['Sigma 18-35mm f1.8 lens with the matte box'], qrText: null }
    const text = String.fromCharCode(...buildParchiEscPos(doc, { width: 32 }))
    assert.match(text, /Sigma 18-35mm f1\.8 lens with the\nmatte box\n/)
    // 48-column paper keeps it on one line.
    const wide = String.fromCharCode(...buildParchiEscPos(doc, { width: 48 }))
    assert.match(wide, /Sigma 18-35mm f1\.8 lens with the matte box\n/)
  })

  test('an empty body line prints as one blank line', () => {
    assert.deepEqual(wrapLine('', 32), [''])
  })
})

describe('the ASCII fold', () => {
  test('known typography folds to its ASCII cousin', () => {
    assert.equal(toAscii('PARCHI — Ravi · 1×2 … “ok” → x'), 'PARCHI - Ravi . 1x2 ... "ok" -> x')
  })

  test('anything else outside 0x20–0x7E becomes ?', () => {
    assert.equal(toAscii('chai ☕ 中'), 'chai ? ?')
    assert.equal(toAscii('tab\there'), 'tab?here')
    assert.equal(toAscii('two\nlines'), 'two\nlines', 'LF is the one control that survives')
  })

  test('every byte of a real parchi is printable ASCII or a control we emit', () => {
    const text = [
      'PARCHI — Ravi Light & Grip',
      'Shan Foods TVC — Ghazi Studios',
      'OUT 2026-09-03 06:14',
      '',
      'OUT (2):',
      'FX9-01  Sony FX9',
      'AP600-01  Aputure 600D Pro…',
      '',
      'Lines: 2 out, 0 short',
    ].join('\n')
    const bytes = buildParchiEscPos(parchiDocFromText(text), { width: 32 })
    const stream = String.fromCharCode(...bytes)
    // The folded text is what prints; the raw typography never does.
    assert.match(stream, /PARCHI - Ravi\nLight & Grip\n/, 'the letterhead wraps at 16 at double width')
    assert.match(stream, /Shan Foods TVC - Ghazi Studios\n/)
    // The QR payload keeps its line breaks — the guard reads a challan,
    // not one run-on line — and folds the same typography.
    assert.match(stream, /1P0PARCHI - Ravi Light & Grip\nShan Foods TVC - Ghazi Studios\nOUT 2026/)
    assert.match(stream, /AP600-01  Aputure 600D Pro\.\.\.\n/)
    // The only bytes above 0x7E are command arguments (here: the QR block's
    // length byte, pL = 158 + 3), never text.
    const above = [...bytes].filter((b) => b > 0x7e)
    assert.deepEqual(above, [text.length + 3])
  })
})

describe('parchiDocFromText', () => {
  test('letterhead, job label, body, and the whole text as the QR payload', () => {
    const text = 'PARCHI — Ravi\nWedding — DHA\nOUT 2026-09-03 06:14\n\nOUT (0):'
    const doc = parchiDocFromText(text)
    assert.equal(doc.title, 'PARCHI — Ravi')
    assert.equal(doc.subtitle, 'Wedding — DHA')
    assert.deepEqual(doc.lines, ['OUT 2026-09-03 06:14', '', 'OUT (0):'])
    assert.equal(doc.qrText, text)
  })
})
