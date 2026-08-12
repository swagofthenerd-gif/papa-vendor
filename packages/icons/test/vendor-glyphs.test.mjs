/**
 * Papa Vendor's own glyphs, and the merged renderer.
 *
 * Parity with the marketplace lives in @papa/design, which owns the shared
 * set. What is defended HERE is that vendor additions stay in the same visual
 * grammar and never shadow a shared glyph.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src')
const vendor = readFileSync(join(srcDir, 'vendor-glyphs.tsx'), 'utf8')
const index = readFileSync(join(srcDir, 'index.tsx'), 'utf8')

// The shared set, read from the installed package — so this test fails if the
// dependency is missing or the export is renamed, rather than silently
// comparing against nothing.
const shared = readFileSync(
  join(here, '..', '..', '..', 'node_modules', '@papa', 'design', 'src', 'icons', 'core.tsx'),
  'utf8',
)

function unionNames(source, typeName) {
  const m = source.match(new RegExp(`export type ${typeName} =([\\s\\S]*?)\\n\\nexport`))
  assert.ok(m, `could not find the ${typeName} union`)
  return [...m[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1])
}

function mapKeys(source, constName) {
  const start = source.indexOf(`export const ${constName}`)
  assert.notEqual(start, -1, `could not find ${constName}`)
  const open = source.indexOf('{', start)
  const close = source.indexOf('\n}', open)
  const body = source.slice(open, close)
  return [...body.matchAll(/^ {2}'?([\w-]+)'?:[ \t]*(?=[(<])/gm)].map((m) => m[1])
}

describe('the shared package is actually installed', () => {
  test('and exports the glyph map this package merges', () => {
    assert.ok(shared.includes('export const ICON_PATHS'))
    assert.ok(index.includes("from '@papa/design'"), 'core comes from the shared package')
  })
})

describe('vendor glyphs', () => {
  const names = unionNames(vendor, 'VendorIconName')
  const keys = mapKeys(vendor, 'VENDOR_ICON_PATHS')

  test('every declared name has a glyph', () => {
    assert.deepEqual(names.filter((n) => !keys.includes(n)), [])
  })

  test('every glyph is declared', () => {
    assert.deepEqual(keys.filter((k) => !names.includes(k)), [])
  })

  test('the check covered every glyph', () => {
    // A guard for the guard: an earlier parser matched only paren-wrapped
    // glyphs and silently skipped seven icons.
    assert.equal(keys.length, names.length)
  })

  test('vendor names never shadow a shared glyph', () => {
    // A collision would be resolved silently by the spread in ALL_ICON_PATHS,
    // overwriting a marketplace glyph with a vendor one. `wrench` did exactly
    // this once.
    const clash = names.filter((n) => unionNames(shared, 'IconName').includes(n))
    assert.deepEqual(clash, [], `shadows shared glyphs: ${clash.join(', ')}`)
  })

  test('they follow the 24x24 duotone grammar', () => {
    assert.ok(vendor.includes('opacity: 0.15'), 'the duotone tint constant must be present')
    const tinted = [...vendor.matchAll(/\{\.\.\.T\}/g)].length
    assert.ok(tinted >= names.length * 0.8, `only ${tinted} of ${names.length} carry a tint layer`)
  })

  test('no glyph hardcodes a colour', () => {
    const body = vendor.slice(vendor.indexOf('VENDOR_ICON_PATHS'))
    const hardcoded = [...body.matchAll(/(?:fill|stroke)="(#[\da-f]{3,8}|rgb[^"]*)"/gi)].map((m) => m[1])
    assert.deepEqual(hardcoded, [], `hardcoded colours: ${hardcoded.join(', ')}`)
  })
})

describe('no emoji, anywhere', () => {
  const EMOJI = /\p{Extended_Pictographic}/u
  for (const file of readdirSync(srcDir)) {
    test(`${file} contains no emoji`, () => {
      const hit = readFileSync(join(srcDir, file), 'utf8').match(EMOJI)
      assert.equal(hit, null, hit ? `found '${hit[0]}' — use a glyph from the icon set` : '')
    })
  }
})

describe('the merged renderer', () => {
  test('merges both maps', () => {
    assert.ok(index.includes('...ICON_PATHS') && index.includes('...VENDOR_ICON_PATHS'))
  })

  test('keeps the sibling render contract', () => {
    for (const contract of [
      'viewBox="0 0 24 24"', 'strokeWidth = 1.8', 'strokeLinecap="round"',
      'strokeLinejoin="round"', 'filter="url(#icon-sketch)"', 'stroke="currentColor"',
    ]) {
      assert.ok(index.includes(contract), `render contract lost: ${contract}`)
    }
  })

  test('tolerates an unknown name rather than crashing', () => {
    assert.ok(index.includes('?? ALL_ICON_PATHS.box'))
  })
})
