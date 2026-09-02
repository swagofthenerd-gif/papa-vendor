/**
 * The parchi — the phone-to-phone gate pass.
 *
 * Two families of assertion. CONTENT: the challan carries what a gate guard
 * counts — house, job, timestamp, item lines, shortfall lines, the trust
 * count, and a total line that survives every truncation. CAPACITY: the text
 * must stay inside what a phone screen can show ANOTHER phone reliably —
 * a runaway QR version is a gate pass that does not scan, which is a gate
 * pass that does not exist. The encoder itself is the referee here (it
 * counts bytes, not chars), and jsQR proves the worst case reads back.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import QRCode from 'qrcode'
import jsQR from 'jsqr'
import {
  buildParchi,
  PARCHI_MAX_CHARS,
  PARCHI_MAX_ITEM_ROWS,
  PARCHI_MAX_SHORT_ROWS,
} from '../src/parchi.ts'

const WHEN = new Date(2026, 8, 3, 6, 14).getTime() // local 2026-09-03 06:14

const small = () => ({
  houseName: 'Ravi Light & Grip',
  jobLabel: 'Shan Foods TVC — Ghazi Studios',
  mode: 'out',
  whenMs: WHEN,
  items: [
    { code: 'FX9-01', name: 'Sony FX9' },
    { code: 'CINE18-01', name: 'Aputure 600d' },
  ],
  assumedCount: 1,
  shortfall: [{ code: 'TRI-04', name: 'Manfrotto 546B' }],
})

/** A brutal session: long names, many items, big shortfall. */
const huge = () => ({
  houseName: 'A Rental House With A Very Long Registered Trading Name',
  jobLabel: 'A wedding with an unreasonably long label that someone typed at the desk in a hurry',
  mode: 'out',
  whenMs: WHEN,
  items: Array.from({ length: 500 }, (_, i) => ({
    code: `LONGCODE-${String(i).padStart(4, '0')}`,
    name: `Extremely Verbose Product Display Name Number ${i} Deluxe Edition`,
  })),
  assumedCount: 137,
  shortfall: Array.from({ length: 120 }, (_, i) => ({
    code: `MISSING-${i}`,
    name: `Another Long Missing Item Name ${i}`,
  })),
})

/** The QR module grid painted into RGBA for jsQR — same recipe as the label
 *  round-trip test. */
function rasterise(text, scale = 3, quiet = 4) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const size = qr.modules.size
  const data = qr.modules.data
  const side = (size + quiet * 2) * scale
  const rgba = new Uint8ClampedArray(side * side * 4).fill(255)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!data[y * size + x]) continue
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = ((y + quiet) * scale + dy) * side + ((x + quiet) * scale + dx)
          rgba[px * 4] = 0
          rgba[px * 4 + 1] = 0
          rgba[px * 4 + 2] = 0
        }
      }
    }
  }
  return { rgba, side }
}

describe('what the challan says', () => {
  test('carries the letterhead, the job, and a deterministic timestamp', () => {
    const text = buildParchi(small())
    assert.match(text, /^PARCHI — Ravi Light & Grip/)
    assert.match(text, /Shan Foods TVC — Ghazi Studios/)
    // Local-time stamp, no locale: same input, same challan, everywhere.
    assert.match(text, /OUT 2026-09-03 06:14/)
  })

  test('lists items with code and name, and shortfall under its own heading', () => {
    const text = buildParchi(small())
    assert.match(text, /OUT \(2\):/)
    assert.match(text, /FX9-01 {2}Sony FX9/)
    assert.match(text, /SHORT \(1\):/)
    assert.match(text, /TRI-04 {2}Manfrotto 546B/)
  })

  test('counts trust separately — a belief must not pass as an observation', () => {
    const text = buildParchi(small())
    assert.match(text, /1 taken on trust, not seen/)
    // …and only when there is any: zero would print noise on every pass.
    const none = buildParchi({ ...small(), assumedCount: 0 })
    assert.doesNotMatch(none, /taken on trust/)
  })

  test('always ends with the total line the gate actually counts', () => {
    assert.match(buildParchi(small()), /Lines: 2 out, 1 short$/)
    // No shortfall: the section disappears, the total still says 0 short —
    // "no short line" and "0 short" read differently at a gate.
    const clean = buildParchi({ ...small(), shortfall: [] })
    assert.doesNotMatch(clean, /SHORT/)
    assert.match(clean, /Lines: 2 out, 0 short$/)
  })

  test('a return reads as a return', () => {
    const text = buildParchi({ ...small(), mode: 'in' })
    assert.match(text, /BACK 2026-09-03 06:14/)
    assert.match(text, /BACK \(2\):/)
    // On the way back a gap is gear at a client's site, not "short".
    assert.match(text, /STILL OUT \(1\):/)
    assert.match(text, /Lines: 2 back, 1 short$/)
  })

  test('is deterministic — same facts, same challan, same QR', () => {
    assert.equal(buildParchi(huge()), buildParchi(huge()))
  })
})

describe('capacity — the QR must actually scan', () => {
  test('a brutal session is capped, with the caps declared as +N more', () => {
    const text = buildParchi(huge())
    assert.ok(text.length <= PARCHI_MAX_CHARS, `challan is ${text.length} chars`)
    assert.match(text, new RegExp(`\\+${500 - PARCHI_MAX_ITEM_ROWS} more`))
    assert.match(text, new RegExp(`\\+${120 - PARCHI_MAX_SHORT_ROWS} more`))
    // The COUNTS survive every truncation — counting is what the gate does.
    assert.match(text, /OUT \(500\):/)
    assert.match(text, /SHORT \(120\):/)
    assert.match(text, /Lines: 500 out, 120 short$/)
  })

  test('the worst case stays inside a phone-scannable QR version', () => {
    // The encoder is the referee: it counts BYTES, so clipped names that
    // landed multi-byte characters are measured honestly. Version 21 is
    // 101x101 modules — reliably read full-screen by another phone; beyond
    // that, phone-to-phone starts failing in warehouse light.
    const qr = QRCode.create(buildParchi(huge()), { errorCorrectionLevel: 'M' })
    assert.ok(qr.version <= 21, `QR version ${qr.version} is too dense to scan off a screen`)
  })

  test('the worst-case challan decodes back, whole, with a stock decoder', () => {
    // The claim on the screen is "any camera app reads this". jsQR is the
    // stand-in for that camera: encode, rasterise, decode, compare.
    const text = buildParchi(huge())
    const { rgba, side } = rasterise(text)
    const found = jsQR(rgba, side, side, { inversionAttempts: 'dontInvert' })
    assert.ok(found, 'the gate pass did not decode at all')
    assert.equal(found.data, text, 'the gate pass decoded to different text')
  })
})
