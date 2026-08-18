/**
 * Importing a real catalogue.
 *
 * This runs once per customer, over a file nobody will read line by line
 * afterwards. Everything it gets wrong becomes permanent: a serial column
 * mistaken for the product name, a quantity misread as 10 instead of 1.0, two
 * different cameras merged because their names are one character apart. None
 * of it surfaces as an error — it surfaces months later as gear that cannot be
 * found under the name someone is searching for.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import { parseCsv, guessMapping, readRows, planImport } from '../src/csv-import.ts'

const CATALOGUE = [
  { id: 'p1', name: 'Sony FX9' },
  { id: 'p2', name: 'Canon C300 Mark III' },
  { id: 'p3', name: 'Aputure 600D Pro' },
]

describe('parsing what a spreadsheet actually exports', () => {
  test('quoted fields containing the delimiter stay whole', () => {
    const t = parseCsv('name,qty\n"Sigma 18-35mm, f1.8",3')
    assert.deepEqual(t.rows[0], ['Sigma 18-35mm, f1.8', '3'])
  })

  test('doubled quotes inside a quoted field', () => {
    const t = parseCsv('name\n"Sachtler 75"" bowl"')
    assert.equal(t.rows[0][0], 'Sachtler 75" bowl')
  })

  test('CRLF out of Excel does not leave carriage returns in the data', () => {
    const t = parseCsv('name,qty\r\nSony FX9,2\r\n')
    assert.deepEqual(t.headers, ['name', 'qty'])
    assert.deepEqual(t.rows, [['Sony FX9', '2']])
  })

  test('a byte-order mark does not poison the first header', () => {
    // Survives every round trip through Excel, and without stripping it the
    // first column silently maps to nothing.
    const t = parseCsv('﻿name,qty\nSony FX9,1')
    assert.equal(t.headers[0], 'name')
    assert.equal(guessMapping(t.headers).name, 0)
  })

  test('semicolons and tabs are recognised as delimiters', () => {
    assert.equal(parseCsv('name;qty\nSony FX9;2').rows[0][1], '2')
    assert.equal(parseCsv('name\tqty\nSony FX9\t2').rows[0][1], '2')
  })

  test('blank lines are dropped rather than becoming empty products', () => {
    const t = parseCsv('name,qty\nSony FX9,1\n\n\nCanon C300 Mark III,1\n')
    assert.equal(t.rows.length, 2)
  })
})

describe('guessing the columns', () => {
  test('recognises the usual spellings', () => {
    const m = guessMapping(['Item Description', 'Asset Code', 'Serial No', 'Qty', 'Shelf'])
    assert.equal(typeof m.code, 'number')
    assert.equal(typeof m.serial, 'number')
    assert.equal(typeof m.quantity, 'number')
    assert.equal(typeof m.location, 'number')
  })

  test('never assigns one column to two fields', () => {
    const m = guessMapping(['name', 'code', 'serial'])
    const used = Object.values(m)
    assert.equal(new Set(used).size, used.length)
  })

  test('a phrase header maps to a single-word hint', () => {
    // THE REGRESSION. "Item Description" is the most common product-name
    // header there is, and edit distance against "item" scores 0.25 — so the
    // import stalled on step two saying it could not find a product name.
    const m = guessMapping(['Item Description', 'Qty', 'Asset Code', 'Shelf'])
    assert.equal(m.name, 0)
    assert.equal(m.quantity, 1)
    assert.equal(m.code, 2)
    assert.equal(m.location, 3)
  })

  test('a typo in a header still maps', () => {
    assert.equal(typeof guessMapping(['Product', 'Quanity']).quantity, 'number')
  })

  test('leaves a column unmapped rather than forcing a bad guess', () => {
    // A wrong column is four hundred wrong rows. Unmapped is recoverable by a
    // person looking at the preview; wrong is not, because it looks fine.
    const m = guessMapping(['zzz', 'qqq'])
    assert.equal(m.name, undefined)
  })
})

describe('reading rows', () => {
  const read = (csv) => {
    const t = parseCsv(csv)
    return readRows(t, guessMapping(t.headers))
  }

  test('a row with no name is rejected and says which line', () => {
    const { rows, rejected } = read('name,qty\nSony FX9,1\n,4\n')
    assert.equal(rows.length, 1)
    assert.equal(rejected.length, 1)
    assert.equal(rejected[0].line, 3, 'counts the header, and counts from one')
  })

  test('a quantity that is not a whole number is rejected, never rounded', () => {
    // "2 nos" and "1.5" both mean the file is not what the importer thinks it
    // is. Guessing here creates units that do not exist.
    const { rejected } = read('name,qty\nSony FX9,2 nos\nCanon C300 Mark III,1.5\n')
    assert.equal(rejected.length, 2)
  })

  test('an absurd quantity is rejected rather than believed', () => {
    const { rejected } = read('name,qty\nXLR Cable,99999\n')
    assert.equal(rejected.length, 1)
    assert.match(rejected[0].reason, /mistake/)
  })

  test('a missing quantity column means one unit per row', () => {
    const { rows } = read('name\nSony FX9\nRED Komodo 6K\n')
    assert.deepEqual(rows.map((r) => r.quantity), [1, 1])
  })
})

describe('planning the import', () => {
  const plan = (csv) => {
    const t = parseCsv(csv)
    const m = guessMapping(t.headers)
    const { rows, rejected } = readRows(t, m)
    return planImport(rows, CATALOGUE, rejected)
  }

  test('an exact name matches the existing product', () => {
    const p = plan('name,qty\nSony FX9,2\n')
    assert.equal(p.existingProducts, 1)
    assert.equal(p.newProducts, 0)
  })

  test('case and spacing do not create a duplicate product', () => {
    const p = plan('name,qty\n  sony   fx9 ,1\n')
    assert.equal(p.existingProducts, 1)
  })

  test('a genuinely new product is new', () => {
    const p = plan('name,qty\nZeiss Supreme Prime Set,1\n')
    assert.equal(p.newProducts, 1)
  })

  test('C300 vs C500 is handed to a person, never merged', () => {
    // THE ONE THAT MATTERS. Merging these corrupts the catalogue on day one
    // and nobody notices until a client is sent the wrong body.
    const p = plan('name,qty\nCanon C500 Mark II,1\n')
    assert.equal(p.ambiguous, 1)
    assert.equal(p.existingProducts, 0)
    const row = p.rows.find((r) => r.verdict.kind === 'ambiguous')
    assert.ok(row.verdict.candidates.some((c) => c.name === 'Canon C300 Mark III'))
  })

  test('the same product twice in one file adds units rather than duplicating', () => {
    // One line per shelf is how these files are actually written.
    const p = plan('name,qty\nZeiss Supreme Prime Set,1\nZeiss Supreme Prime Set,2\n')
    assert.equal(p.newProducts, 1)
    assert.equal(p.existingProducts, 1)
    assert.equal(p.unitsToCreate, 3)
  })

  test('rejected rows stay in the totals, so the count describes the whole file', () => {
    const p = plan('name,qty\nSony FX9,1\n,9\n')
    assert.equal(p.rejected, 1)
    assert.equal(p.rows.length, 2)
  })

  test('rows come back in file order, whatever happened to them', () => {
    const p = plan('name,qty\n,1\nSony FX9,1\nZeiss Supreme Prime Set,1\n')
    const lines = p.rows.map((r) => r.row.line)
    assert.deepEqual(lines, [...lines].sort((a, b) => a - b))
  })

  test('units to create counts quantities, not rows', () => {
    const p = plan('name,qty\nZeiss Supreme Prime Set,4\nSony FX9,2\n')
    assert.equal(p.unitsToCreate, 6)
  })
})
