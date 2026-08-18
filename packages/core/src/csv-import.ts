import { normalise, similarity, type CatalogueItem } from './kit-list.ts'

/**
 * Header text, folded for comparison.
 *
 * NOT `normalise` from kit-list.ts, which strips a noise list built for a
 * client's message — and that list contains `qty`, `no`, `nos` and `pcs`.
 * Running it over headers reduced "Qty" and "Serial No" to the empty string,
 * so those columns were silently never mapped and every quantity in the file
 * fell back to 1. The importer looked like it worked.
 *
 * Header words carry meaning here precisely because they are the words a
 * spreadsheet uses for columns.
 */
function foldHeader(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/**
 * Importing the vendor's existing catalogue.
 *
 * THE ONBOARDING STEP EVERYTHING ELSE WAITS ON. The kit-list reader matches a
 * client's message against the house's OWN product names, so until real names
 * are loaded it is a toy. Nobody is going to type four hundred items into a
 * phone, and a house that cannot get its list in stays on the notebook — which
 * is the dual-running state the research names as the killer.
 *
 * ---------------------------------------------------------------------------
 * IT NEVER IMPORTS ANYTHING ON ITS OWN JUDGEMENT.
 *
 * Every row comes back classified, and anything short of an obvious match is
 * handed to a person. An importer that quietly merges "Canon C300" into
 * "Canon C500" because they are 92% similar corrupts the catalogue on day one,
 * in a way nobody notices until a client is sent the wrong body — and by then
 * the wrong name is in six months of history.
 * ---------------------------------------------------------------------------
 */

/** Real spreadsheets are not comma-only, and this is not worth a question. */
const DELIMITERS = [',', ';', '\t'] as const

export interface CsvTable {
  headers: string[]
  rows: string[][]
  delimiter: string
}

/**
 * Parse a delimited file.
 *
 * Hand-rolled rather than a dependency because `packages/core` must run
 * untranspiled under `node --test` with no build step and no dependencies —
 * the same constraint that keeps the offline engine testable.
 *
 * Handles the three things that actually appear in a rental house's export:
 * quoted fields containing the delimiter, doubled quotes inside a quoted
 * field, and CRLF line endings out of Excel.
 */
export function parseCsv(text: string): CsvTable {
  // A byte-order mark survives every round trip through Excel and turns the
  // first header into something that matches nothing, so the first column
  // silently fails to map.
  const src = text.replace(/^﻿/, '')
  const delimiter = pickDelimiter(src)

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < src.length; i++) {
    const c = src[i]

    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else { quoted = false }
      } else {
        field += c
      }
      continue
    }

    if (c === '"') { quoted = true; continue }
    if (c === delimiter) { row.push(field); field = ''; continue }
    if (c === '\r') continue
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue }
    field += c
  }
  row.push(field)
  rows.push(row)

  const cleaned = rows
    .map((r) => r.map((f) => f.trim()))
    .filter((r) => r.some((f) => f.length > 0))

  const headers = cleaned.shift() ?? []
  return { headers, rows: cleaned, delimiter }
}

function pickDelimiter(src: string): string {
  const firstLine = src.slice(0, src.indexOf('\n') === -1 ? src.length : src.indexOf('\n'))
  let best: string = ','
  let bestCount = -1
  for (const d of DELIMITERS) {
    const n = firstLine.split(d).length - 1
    if (n > bestCount) { best = d; bestCount = n }
  }
  return best
}

/** The columns the app can actually use. Everything else is ignored, not lost. */
export type FieldName = 'name' | 'code' | 'serial' | 'category' | 'quantity' | 'location'

/** Header spellings seen in real exports, lowercase and punctuation-free. */
const HEADER_HINTS: Record<FieldName, string[]> = {
  name: ['name', 'product', 'item', 'description', 'model', 'equipment', 'gear'],
  code: ['code', 'asset code', 'asset id', 'barcode', 'tag', 'ref', 'reference'],
  serial: ['serial', 'serial no', 'serial number', 'sn'],
  category: ['category', 'type', 'department', 'dept', 'group'],
  quantity: ['qty', 'quantity', 'count', 'units', 'nos', 'pcs'],
  location: ['location', 'shelf', 'rack', 'store', 'where', 'bin'],
}

export type ColumnMapping = Partial<Record<FieldName, number>>

/**
 * Guess which column is which.
 *
 * A GUESS, and it is shown to the person before anything is imported. Silent
 * mapping is how a serial number column ends up as the product name for four
 * hundred items.
 */
export function guessMapping(headers: string[]): ColumnMapping {
  const map: ColumnMapping = {}
  const taken = new Set<number>()
  const keys = normaliseHeaders(headers)

  for (const field of Object.keys(HEADER_HINTS) as FieldName[]) {
    let bestIndex = -1
    let bestScore = 0
    keys.forEach((key, i) => {
      if (taken.has(i) || key.length === 0) return
      for (const hint of HEADER_HINTS[field]) {
        const score = scoreHeader(key, hint)
        if (score > bestScore) { bestScore = score; bestIndex = i }
      }
    })
    // 0.8 rather than the matcher's 0.55: a wrong column is four hundred wrong
    // rows, where a wrong kit-list line is one tap to fix.
    if (bestIndex >= 0 && bestScore >= 0.8) {
      map[field] = bestIndex
      taken.add(bestIndex)
    }
  }
  return map
}

function normaliseHeaders(headers: string[]): string[] {
  return headers.map(foldHeader)
}

/**
 * How well one header matches one hint.
 *
 * WORD CONTAINMENT BEFORE EDIT DISTANCE. Real headers are phrases — "Item
 * Description", "Serial No", "Asset Code" — and edit distance between a phrase
 * and a single word is dominated by the length difference: "item description"
 * against "item" scores 0.25 and fails, so the most common product-name header
 * in the wild mapped to nothing and the whole import stalled on step two.
 *
 * A hint appearing as a WHOLE WORD is deliberately not a perfect score, so an
 * exact header still wins when both are present.
 */
function scoreHeader(key: string, hint: string): number {
  if (key === hint) return 1
  const words = key.split(' ')
  const hintWords = hint.split(' ')
  const containsAll = hintWords.every((w) => words.includes(w))
  if (containsAll) return 0.95
  // A single-word hint against one word of the header, so a typo in
  // "Quanity" still lands.
  const best = Math.max(...words.map((w) => similarity(w, hint)))
  return Math.max(best, similarity(key, hint))
}

export interface ImportRow {
  /** 1-based line in the file, so an error message points at something real. */
  line: number
  name: string
  code: string | null
  serial: string | null
  category: string | null
  quantity: number
  location: string | null
}

export type RowVerdict =
  /** No product like this exists. Safe to create. */
  | { kind: 'new' }
  /** Same name as something already in the catalogue. Add units to it. */
  | { kind: 'existing'; productId: string; productName: string }
  /** Close to something, but not close enough to decide without a person. */
  | { kind: 'ambiguous'; candidates: CatalogueItem[] }
  /** Unusable — no name, or a quantity that is not a number. */
  | { kind: 'rejected'; reason: string }

export interface ReviewedRow {
  row: ImportRow
  verdict: RowVerdict
}

export interface ImportPlan {
  rows: ReviewedRow[]
  newProducts: number
  existingProducts: number
  ambiguous: number
  rejected: number
  /** Units that would be created if this plan were applied as it stands. */
  unitsToCreate: number
}

export interface ReadOptions {
  /** Rows whose quantity exceeds this are rejected rather than believed. */
  maxQuantity?: number
}

/** Turn a parsed table plus a mapping into typed rows. */
export function readRows(
  table: CsvTable,
  mapping: ColumnMapping,
  opts: ReadOptions = {},
): { rows: ImportRow[]; rejected: { line: number; reason: string; raw: string[] }[] } {
  const maxQuantity = opts.maxQuantity ?? 500
  const rows: ImportRow[] = []
  const rejected: { line: number; reason: string; raw: string[] }[] = []

  table.rows.forEach((raw, i) => {
    const line = i + 2 // +1 for the header, +1 because people count from one
    const at = (f: FieldName): string | null => {
      const idx = mapping[f]
      if (idx === undefined) return null
      const v = raw[idx]
      return v === undefined || v.trim() === '' ? null : v.trim()
    }

    const name = at('name')
    if (!name) {
      rejected.push({ line, reason: 'No product name in this row', raw })
      return
    }

    let quantity = 1
    const rawQty = at('quantity')
    if (rawQty !== null) {
      // Excel writes "1.0" and people write "2 nos". Anything that is not a
      // plain count is rejected rather than guessed at, because a silently
      // misread quantity creates units that do not exist.
      const n = Number(rawQty.replace(/[, ]/g, ''))
      if (!Number.isFinite(n) || n < 1 || !Number.isInteger(n)) {
        rejected.push({ line, reason: `"${rawQty}" is not a whole number of units`, raw })
        return
      }
      if (n > maxQuantity) {
        rejected.push({ line, reason: `${n} units in one row looks like a mistake`, raw })
        return
      }
      quantity = n
    }

    rows.push({
      line,
      name,
      code: at('code'),
      serial: at('serial'),
      category: at('category'),
      quantity,
      location: at('location'),
    })
  })

  return { rows, rejected }
}

/**
 * Decide what each row would do, without doing any of it.
 *
 * The thresholds are deliberately far apart. An exact normalised match is the
 * same product; anything from 0.72 up is a CANDIDATE to be confirmed by a
 * person; below that it is simply new. There is no band in which this merges
 * two products on its own.
 */
export function planImport(
  rows: ImportRow[],
  catalogue: CatalogueItem[],
  rejected: { line: number; reason: string }[] = [],
): ImportPlan {
  const prepared = catalogue.map((c) => ({ item: c, key: normalise(c.name) }))
  const reviewed: ReviewedRow[] = []

  // Rows already thrown out by readRows carry through, so the totals on the
  // screen describe the whole file rather than the part that survived.
  for (const r of rejected) {
    reviewed.push({
      row: { line: r.line, name: '', code: null, serial: null, category: null, quantity: 0, location: null },
      verdict: { kind: 'rejected', reason: r.reason },
    })
  }

  const seenInFile = new Map<string, number>()

  for (const row of rows) {
    const key = normalise(row.name)

    // A file that lists the same product twice is common — one line per shelf.
    // The second line is an addition to the first, not a new product.
    const earlier = seenInFile.get(key)
    if (earlier !== undefined) {
      reviewed.push({
        row,
        verdict: { kind: 'existing', productId: `file:${key}`, productName: row.name },
      })
      continue
    }
    seenInFile.set(key, row.line)

    const exact = prepared.find((p) => p.key === key)
    if (exact) {
      reviewed.push({
        row,
        verdict: { kind: 'existing', productId: exact.item.id, productName: exact.item.name },
      })
      continue
    }

    const near = prepared
      .map((p) => ({ item: p.item, score: similarity(key, p.key) }))
      .filter((c) => c.score >= 0.72)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)

    reviewed.push({
      row,
      verdict: near.length > 0
        ? { kind: 'ambiguous', candidates: near.map((c) => c.item) }
        : { kind: 'new' },
    })
  }

  reviewed.sort((a, b) => a.row.line - b.row.line)

  const count = (kind: RowVerdict['kind']) =>
    reviewed.filter((r) => r.verdict.kind === kind).length

  return {
    rows: reviewed,
    newProducts: count('new'),
    existingProducts: count('existing'),
    ambiguous: count('ambiguous'),
    rejected: count('rejected'),
    unitsToCreate: reviewed
      .filter((r) => r.verdict.kind === 'new' || r.verdict.kind === 'existing')
      .reduce((n, r) => n + r.row.quantity, 0),
  }
}
