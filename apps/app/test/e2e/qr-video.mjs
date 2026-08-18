/**
 * A QR code, as a video file Chromium will accept as a camera.
 *
 * Chromium's `--use-file-for-fake-video-capture` takes an uncompressed Y4M
 * file and loops it as a webcam. That is the only way to exercise the decode
 * path on a machine with no camera — which is every CI runner, and this
 * development machine too.
 *
 * Written by hand rather than shelled out to ffmpeg: Y4M is a header, a plane
 * of luma and two half-size chroma planes, and generating it here keeps the
 * check dependency-free and deterministic.
 */
import QRCode from 'qrcode'
import { writeFileSync } from 'node:fs'

/** Rec.601 studio-swing black and white. Full-range 0/255 decodes too, but
 *  studio swing is what a real camera produces and is what the decoder in the
 *  browser will be tuned against. */
const BLACK = 16
const WHITE = 235
const NEUTRAL_CHROMA = 128

/**
 * Render `text` as a QR code into a Y4M file.
 *
 * The code is drawn large and centred on a white field, because the app's
 * decoder looks at the whole frame and a small code in a corner is the case
 * that fails intermittently — exactly the flakiness an end-to-end check must
 * not have.
 */
export function writeQrVideo(path, text, { width = 640, height = 480, frames = 4 } = {}) {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' })
  const modules = qr.modules.size
  const bits = qr.modules.data

  // A quiet zone is part of the spec, not decoration: without it the decoder
  // cannot find the code's edge against the frame.
  const quiet = 4
  const total = modules + quiet * 2
  const scale = Math.max(1, Math.floor(Math.min(width, height) / total))
  const drawn = total * scale
  const offsetX = Math.floor((width - drawn) / 2)
  const offsetY = Math.floor((height - drawn) / 2)

  const luma = new Uint8Array(width * height).fill(WHITE)
  for (let my = 0; my < modules; my++) {
    for (let mx = 0; mx < modules; mx++) {
      if (!bits[my * modules + mx]) continue
      const x0 = offsetX + (mx + quiet) * scale
      const y0 = offsetY + (my + quiet) * scale
      for (let dy = 0; dy < scale; dy++) {
        const row = (y0 + dy) * width
        for (let dx = 0; dx < scale; dx++) luma[row + x0 + dx] = BLACK
      }
    }
  }

  const chromaSize = (width / 2) * (height / 2)
  const chroma = new Uint8Array(chromaSize).fill(NEUTRAL_CHROMA)

  const parts = [Buffer.from(`YUV4MPEG2 W${width} H${height} F30:1 Ip A1:1 C420jpeg\n`)]
  for (let i = 0; i < frames; i++) {
    parts.push(Buffer.from('FRAME\n'), Buffer.from(luma), Buffer.from(chroma), Buffer.from(chroma))
  }

  writeFileSync(path, Buffer.concat(parts))
  return { width, height, modules, scale }
}
