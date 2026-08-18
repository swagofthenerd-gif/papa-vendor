/**
 * A label, decoded.
 *
 * The demo has two halves that must agree and are written against different
 * libraries: the Labels page encodes a tag with `qrcode`, and the camera reads
 * it back with `jsQR` (or the browser's own decoder, where it exists). If the
 * two ever disagree — an encoding option that produces something jsQR will not
 * read, a tag code with a character that changes the encoding mode — every
 * scan fails and it looks exactly like a broken camera.
 *
 * This checks the whole path except the optics: encode the real seeded tags,
 * rasterise them, decode, and require the original code back.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import QRCode from 'qrcode'
import jsQR from 'jsqr'
import { NodeSqliteDriver } from '@papa/core/node-driver'
import { LOCAL_SCHEMA } from '@papa/core'
import { seedDemo } from '../src/demo/seed.ts'

/** The QR's module grid, blown up and painted into an RGBA buffer for jsQR. */
function rasterise(text, scale = 4, quiet = 4) {
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

test('every demo label decodes back to the tag it encodes', () => {
  const db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  const seed = seedDemo(db)

  for (const tag of seed.tags) {
    const { rgba, side } = rasterise(tag.tagCode)
    const found = jsQR(rgba, side, side, { inversionAttempts: 'dontInvert' })
    assert.ok(found, `label for ${tag.assetCode} did not decode at all`)
    assert.equal(found.data, tag.tagCode, `label for ${tag.assetCode} decoded to the wrong code`)
  }
})

test('a decoded label resolves to the right asset', () => {
  // The half that matters to a person: the sticker on the FX9 has to open the
  // FX9, not merely decode to some string.
  const db = new NodeSqliteDriver()
  db.exec(LOCAL_SCHEMA)
  const seed = seedDemo(db)

  const tag = seed.tags.find((t) => t.assetCode === 'FX9-01')
  assert.ok(tag, 'the seed still has an FX9')

  const { rgba, side } = rasterise(tag.tagCode)
  const decoded = jsQR(rgba, side, side, { inversionAttempts: 'dontInvert' })

  const row = db.get(
    `select a.asset_code from asset_tags t join assets a on a.id = t.asset_id
      where t.tag_code = ?`,
    [decoded.data],
  )
  assert.equal(row.asset_code, 'FX9-01')
})
