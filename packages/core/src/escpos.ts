/**
 * The thermal parchi — the paper gate pass, finally on paper.
 *
 * A 58mm thermal receipt printer (the Rs 3,000 Bluetooth kind every Lahore
 * shop has beside the till) speaks ESC/POS: a byte stream of text and
 * escape commands. This module turns the parchi (apps/app/src/parchi.ts
 * builds the text; this file only knows a title, lines and a QR payload)
 * into that byte stream. Nothing here touches a printer — it is a pure
 * function, bytes in, bytes out, so the exact stream is golden-tested
 * (test/escpos.test.mjs) and the app's ThermalPrinter seam (apps/app/src/
 * print/thermal.ts) decides where the bytes go.
 *
 * HARDWARE IS UNVERIFIED. No printer was connected while this was written:
 * the bytes follow the Epson ESC/POS reference that every clone honours
 * (ESC @, ESC a, ESC E, GS !, GS ( k for the QR, GS V for the cut), and the
 * golden test pins them. The Bluetooth SPP transport that carries them to
 * a real printer is the Capacitor wave — see docs/production-readiness.md
 * ("thermal printing"). Until a printer has actually fed paper, treat this
 * as "bytes golden-tested, hardware unverified".
 *
 * ASCII-SAFE BY CONSTRUCTION. Roman Urdu is Latin, so the parchi never
 * needs a code page; the few typographic characters the text builders use
 * (the em dash, the ellipsis, curly quotes, the middle dot) are folded to
 * their ASCII cousins and anything else outside 0x20–0x7E becomes '?'. A
 * printer fed a UTF-8 em dash prints three garbage glyphs — a challan the
 * gate cannot read is a challan that does not exist.
 *
 * WIDTH IS THE PAPER'S. 58mm paper at the default font is 32 characters;
 * 80mm is 48. Lines are word-wrapped to the width (a word longer than the
 * width is hard-broken) so nothing the printer would silently truncate is
 * silently truncated — the counts on the challan are what the gate reads.
 */

export interface ParchiDoc {
  /** The letterhead line — bold, double height, centred. */
  title: string
  /** The job label — bold, centred, normal size. Omitted when null. */
  subtitle?: string | null
  /** The body, one entry per printed line (already in reading order). */
  lines: string[]
  /** The gate-pass payload — the same text the on-screen QR carries —
   *  printed as a QR at the foot. null prints no code. */
  qrText?: string | null
}

export interface EscPosOptions {
  /** Characters per line: 32 for 58mm paper, 48 for 80mm. */
  width: 32 | 48
  /**
   * ESC t n — the printer's character code page. Unused by the text path
   * (everything is ASCII by construction) and emitted only when given, so
   * a house whose printer defaults to a non-Latin table can pin one.
   */
  codepage?: number
}

const ESC = 0x1b
const GS = 0x1d
const LF = 0x0a

/** ESC @ — initialise: clears the buffer and every mode. Always first. */
export const ESCPOS_INIT = [ESC, 0x40] as const
/** GS V 66 0 — feed then partial cut (the mode every clone honours). */
export const ESCPOS_CUT = [GS, 0x56, 0x42, 0x00] as const

/** QR module size in dots (1–16). 6 reads from a phone at arm's length on
 *  58mm paper; the on-screen parchi test pins the same payload's version. */
export const ESCPOS_QR_MODULE_SIZE = 6

/** The typographic characters the text builders emit, folded to ASCII. */
const FOLD: Record<string, string> = {
  '—': '-',   // em dash
  '–': '-',   // en dash
  '…': '...', // ellipsis
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '·': '.',   // middle dot
  '×': 'x',   // multiplication sign (the '×N' markers)
  '→': '->',  // arrow (the 'Sub-hire → X' label)
  ' ': ' ',
}

/** Fold to printable ASCII: known typography to its cousin, the rest '?'.
 *  LF survives — the QR payload is the whole challan, line breaks and all,
 *  and a gate guard's phone must read it as lines. */
export function toAscii(text: string): string {
  let out = ''
  for (const ch of text) {
    const folded = FOLD[ch]
    if (folded !== undefined) { out += folded; continue }
    const code = ch.codePointAt(0) ?? 0
    out += (code >= 0x20 && code <= 0x7e) || code === LF ? ch : '?'
  }
  return out
}

/**
 * Word-wrap one line to `width` characters. Words longer than the width
 * are hard-broken; an empty line stays one empty line (it is spacing on
 * the challan, not nothing).
 */
export function wrapLine(text: string, width: number): string[] {
  if (text.length <= width) return [text]
  const out: string[] = []
  let current = ''
  for (const word of text.split(' ')) {
    let w = word
    while (w.length > width) {
      if (current.length > 0) { out.push(current); current = '' }
      out.push(w.slice(0, width))
      w = w.slice(width)
    }
    if (current.length === 0) current = w
    else if (current.length + 1 + w.length <= width) current += ` ${w}`
    else { out.push(current); current = w }
  }
  if (current.length > 0) out.push(current)
  return out
}

function ascii(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) out.push(text.charCodeAt(i) & 0x7f)
  return out
}

/**
 * GS ( k — the QR block, model 2, the given module size, error level M,
 * then the data (pL pH count the bytes AFTER them: cn fn m + data, so
 * k = data.length + 3), then the print command. Payloads over 7089 bytes
 * do not fit any QR; the builder refuses rather than printing a partial.
 */
export function qrCommands(payload: string, moduleSize: number = ESCPOS_QR_MODULE_SIZE): number[] {
  const data = ascii(toAscii(payload))
  if (data.length > 7089) throw new Error(`QR payload too long: ${data.length} bytes`)
  const k = data.length + 3
  return [
    // Function 165: select model 2.
    GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00,
    // Function 167: module size.
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize & 0xff,
    // Function 169: error correction level M (49 = 0x31).
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31,
    // Function 180: store the data. pL pH = k mod 256, k div 256.
    GS, 0x28, 0x6b, k & 0xff, (k >> 8) & 0xff, 0x31, 0x50, 0x30, ...data,
    // Function 181: print the stored symbol.
    GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30,
  ]
}

/**
 * Build the byte stream for one parchi.
 *
 * Layout, top to bottom: init (and the code page when pinned); the title
 * centred, bold, double height and width; the subtitle centred, bold; a
 * blank line; the body left-aligned in the normal font, each entry
 * wrapped to the width; the QR centred with a blank line either side;
 * three feed lines so the cut lands clear of the print head; the cut.
 */
export function buildParchiEscPos(parchi: ParchiDoc, opts: EscPosOptions): Uint8Array {
  const width = opts.width
  const bytes: number[] = [...ESCPOS_INIT]
  if (opts.codepage !== undefined) bytes.push(ESC, 0x74, opts.codepage & 0xff)

  const line = (text: string) => { bytes.push(...ascii(text), LF) }
  const align = (n: 0 | 1 | 2) => { bytes.push(ESC, 0x61, n) }
  const bold = (on: boolean) => { bytes.push(ESC, 0x45, on ? 1 : 0) }
  const size = (n: number) => { bytes.push(GS, 0x21, n) }

  // The letterhead: centred, bold, double height + width (GS ! 0x11).
  // Double width halves the line, so the title wraps at width / 2.
  align(1)
  bold(true)
  size(0x11)
  for (const l of wrapLine(toAscii(parchi.title), Math.floor(width / 2))) line(l)
  size(0x00)
  if (parchi.subtitle) {
    for (const l of wrapLine(toAscii(parchi.subtitle), width)) line(l)
  }
  bold(false)
  bytes.push(LF)

  // The body, left-aligned, the paper's width.
  align(0)
  for (const entry of parchi.lines) {
    for (const l of wrapLine(toAscii(entry), width)) line(l)
  }

  if (parchi.qrText) {
    bytes.push(LF)
    align(1)
    bytes.push(...qrCommands(parchi.qrText))
    bytes.push(LF)
    align(0)
  }

  bytes.push(LF, LF, LF)
  bytes.push(...ESCPOS_CUT)
  return Uint8Array.from(bytes)
}

/**
 * A parchi's plain text (apps/app/src/parchi.ts's output) as a ParchiDoc:
 * the first line is the letterhead, the second the job label, the rest
 * the body, and the whole text is the QR payload — exactly what the
 * on-screen gate pass encodes, so the paper and the phone carry one code.
 */
export function parchiDocFromText(text: string): ParchiDoc {
  const lines = text.split('\n')
  return {
    title: lines[0] ?? '',
    subtitle: lines[1] ?? null,
    lines: lines.slice(2),
    qrText: text,
  }
}
