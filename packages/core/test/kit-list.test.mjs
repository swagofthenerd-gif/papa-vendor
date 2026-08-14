/**
 * Reading a kit list pasted from WhatsApp.
 *
 * The tests that matter are the REFUSALS. A parser that always produces an
 * answer is worse than one that asks, because a confidently wrong match puts
 * the wrong camera on a truck and nobody looks again until the client calls.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'

import {
  parseKitList,
  matchKitList,
  normalise,
  similarity,
} from '../src/kit-list.ts'

// A plausible Lahore rental house catalogue.
const CATALOGUE = [
  { id: 'p1', name: 'Sony FX9' },
  { id: 'p2', name: 'ARRI Alexa Mini' },
  { id: 'p3', name: 'Sachtler Tripod' },
  { id: 'p4', name: 'Aputure 600D' },
  { id: 'p5', name: 'V-Mount Battery' },
  { id: 'p6', name: 'Canon C300 Mark III' },
  { id: 'p7', name: 'Canon C500 Mark II' },
]

const byRaw = (rows, needle) => rows.find((r) => r.raw.toLowerCase().includes(needle))

describe('splitting a pasted message into items', () => {
  test('one item per line', () => {
    const rows = parseKitList('Sony FX9\nSachtler Tripod\nAputure 600D')
    assert.equal(rows.length, 3)
  })

  test('quantities however they were written', () => {
    const rows = parseKitList([
      '2x Sony FX9',
      'Sachtler Tripod x3',
      '4 nos V-Mount Battery',
      '(2) Aputure 600D',
      'ARRI Alexa Mini - 2',
    ].join('\n'))

    assert.equal(rows.length, 5)
    assert.deepEqual(rows.map((r) => r.quantity), [2, 3, 4, 2, 2])
  })

  test('numbering is not mistaken for a quantity', () => {
    // "1. Sony FX9" means one line, not one camera — and by luck that is
    // usually the same answer, which is what makes the bug survive.
    const rows = parseKitList('1. Sony FX9\n2. 3x Sachtler Tripod')
    assert.equal(rows[0].quantity, 1)
    assert.equal(rows[1].quantity, 3, 'the real quantity still wins')
  })

  test('greetings and chatter are dropped', () => {
    const rows = parseKitList([
      'Assalam o alaikum',
      'Sir need for shoot',
      '2x Sony FX9',
      'Please confirm',
      'Thanks',
    ].join('\n'))

    assert.equal(rows.length, 1)
    assert.equal(rows[0].quantity, 2)
  })

  test('a comma list on one line is split', () => {
    const rows = parseKitList('2x Sony FX9, Sachtler Tripod, 4 batteries')
    assert.equal(rows.length, 3)
  })

  test('bullets and dashes are decoration, not content', () => {
    const rows = parseKitList('- Sony FX9\n• Sachtler Tripod\n* Aputure 600D')
    assert.equal(rows.length, 3)
    assert.equal(rows[0].text, 'sony fx9')
  })

  test('the original text is always kept', () => {
    // The UI must be able to show exactly what the client sent, whatever the
    // parser decided about it.
    const rows = parseKitList('2x  Sony   FX9')
    assert.match(rows[0].raw, /Sony/)
  })
})

describe('matching, including misspellings', () => {
  test('an exact name is exact', () => {
    const [row] = matchKitList(parseKitList('Sony FX9'), CATALOGUE)
    assert.equal(row.confidence, 'exact')
    assert.equal(row.productId, 'p1')
  })

  test('case and punctuation do not matter', () => {
    const [row] = matchKitList(parseKitList('sony fx-9'), CATALOGUE)
    assert.equal(row.productId, 'p1')
  })

  test('word order does not matter', () => {
    const [row] = matchKitList(parseKitList('FX9 Sony'), CATALOGUE)
    assert.equal(row.productId, 'p1')
  })

  // The point of the whole exercise: people type quickly on a phone.
  for (const [typo, expected] of [
    ['Sachdeva Tripod', 'p3'],
    ['sachtlar tripod', 'p3'],
    ['Aputre 600D', 'p4'],
    ['Arri Alexa Minni', 'p2'],
    ['v mount battry', 'p5'],
  ]) {
    test(`"${typo}" still finds the right item`, () => {
      const [row] = matchKitList(parseKitList(typo), CATALOGUE)
      assert.ok(
        row.confidence === 'exact' || row.confidence === 'strong',
        `expected a confident match, got ${row.confidence}`,
      )
      assert.equal(row.productId, expected)
    })
  }

  test('a partial name still matches', () => {
    const [row] = matchKitList(parseKitList('alexa mini'), CATALOGUE)
    assert.equal(row.productId, 'p2')
  })
})

describe('what it refuses to guess', () => {
  // The most important test here. C300 and C500 differ by ONE character and
  // are different cameras at different day rates. A parser that picks one has
  // put the wrong body on a truck.
  test('two products that differ by one character are not auto-matched', () => {
    const [row] = matchKitList(parseKitList('Canon C300'), CATALOGUE)
    assert.notEqual(row.confidence, 'exact')
    if (row.confidence === 'strong') {
      assert.equal(row.productId, 'p6', 'if it commits at all, it must commit correctly')
    }
  })

  test('a vague line is offered for a tap, never applied', () => {
    const [row] = matchKitList(parseKitList('4 batteries'), CATALOGUE)
    assert.ok(
      row.confidence === 'unsure' || row.confidence === 'none',
      `"batteries" is not a product; got ${row.confidence}`,
    )
    assert.equal(row.productId, undefined, 'an unsure line must NOT carry an id to apply')
    assert.ok(row.candidates.length > 0, 'but it must suggest something tappable')
  })

  test('something not in the catalogue at all is not forced onto the nearest item', () => {
    const [row] = matchKitList(parseKitList('smoke machine'), CATALOGUE)
    assert.equal(row.productId, undefined)
  })

  test('an unsure line keeps its quantity, so nothing is lost when it is resolved', () => {
    const [row] = matchKitList(parseKitList('4 batteries'), CATALOGUE)
    assert.equal(row.quantity, 4)
  })
})

describe('a whole realistic message', () => {
  const MESSAGE = `Assalam o alaikum bhai
Need following for shoot on 14th:

1. 2x Sony FX9
2. Sachdeva tripod x2
3. 4 nos V-Mount Battery
4. Aputre 600D
5. smoke machine

Please confirm availability
Thanks`

  test('every real item is picked up and the chatter is not', () => {
    const rows = matchKitList(parseKitList(MESSAGE), CATALOGUE)
    assert.equal(rows.length, 5)
  })

  test('quantities survive the whole pipeline', () => {
    const rows = matchKitList(parseKitList(MESSAGE), CATALOGUE)
    assert.equal(byRaw(rows, 'fx9').quantity, 2)
    assert.equal(byRaw(rows, 'sachdeva').quantity, 2)
    assert.equal(byRaw(rows, 'battery').quantity, 4)
  })

  test('the misspellings resolve and the unknown item does not', () => {
    const rows = matchKitList(parseKitList(MESSAGE), CATALOGUE)
    assert.equal(byRaw(rows, 'sachdeva').productId, 'p3')
    assert.equal(byRaw(rows, 'aputre').productId, 'p4')
    assert.equal(byRaw(rows, 'smoke').productId, undefined)
  })
})

describe('the pieces underneath', () => {
  test('normalise strips the noise that carries no meaning', () => {
    assert.equal(normalise('2x  Sony FX-9!!'), '2x sony fx 9')
    assert.equal(normalise('TRIPOD nos'), 'tripod')
  })

  test('similarity is length-relative, so a typo in a short word costs more', () => {
    assert.ok(similarity('battery', 'battry') > 0.8)
    assert.ok(similarity('c300', 'c500') < 0.8)
  })
})
