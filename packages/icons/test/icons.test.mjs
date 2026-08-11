/**
 * Icon set integrity.
 *
 * Two things are being defended:
 *
 *  1. PARITY. core.tsx is a verbatim extraction of the sibling's icon set.
 *     A copy with no check is a fork with extra steps, so this compares the
 *     declared names and the glyph bodies against papa-rentals directly.
 *
 *  2. NO EMOJI. The marketplace was rebuilt off emoji and ships a test that
 *     fails on any emoji in the DOM. That rule travels with the icon set —
 *     an emoji renders differently on every Android skin, cannot inherit
 *     `currentColor`, and is invisible in a warehouse at a glance.
 *
 * Parsed as text rather than imported, because these are .tsx and this suite
 * runs on bare node with no build step.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const srcDir = join(here, '..', 'src')
const core = readFileSync(join(srcDir, 'core.tsx'), 'utf8')
const vendor = readFileSync(join(srcDir, 'vendor-glyphs.tsx'), 'utf8')
const index = readFileSync(join(srcDir, 'index.tsx'), 'utf8')

const SIBLING = join(here, '..', '..', '..', '..', 'papa-rentals', 'src', 'components', 'icons.tsx')

/** Names declared in a `export type X = | 'a' | 'b'` union. */
function unionNames(source, typeName) {
  const m = source.match(new RegExp(`export type ${typeName} =([\\s\\S]*?)\\n\\nexport`))
  assert.ok(m, `could not find the ${typeName} union`)
  return [...m[1].matchAll(/'([\w-]+)'/g)].map((x) => x[1])
}

/**
 * Split a `Record<..., ReactNode> = { ... }` map into [name, body] entries.
 *
 * Glyphs come in two shapes, and an earlier version of this only matched the
 * first, silently ignoring seven icons:
 *     multi:  home: (\n    <>...</>\n  ),
 *     single: check: <path d="..." />,
 *
 * Anchoring on the two-space indent is what keeps nested JSX props (indented
 * further) from being mistaken for keys.
 */
function mapEntries(source, constName) {
  const start = source.indexOf(`export const ${constName}`)
  assert.notEqual(start, -1, `could not find ${constName}`)
  const open = source.indexOf('{', start)
  // Bound at the map's closing brace — the first `}` in column 0. Without this
  // the LAST entry slices to end-of-file and swallows whatever follows the map,
  // so an identical glyph reports as drift purely because the two files differ
  // further down. That is exactly what happened with `briefcase`.
  const close = source.indexOf('\n}', open)
  assert.notEqual(close, -1, `${constName} is not closed at column 0`)
  const body = source.slice(open, close)
  const heads = [...body.matchAll(/^ {2}'?([\w-]+)'?:[ \t]*(?=[(<])/gm)]
  return heads.map((m, i) => [
    m[1],
    body.slice(m.index, i + 1 < heads.length ? heads[i + 1].index : undefined).trimEnd(),
  ])
}

const mapKeys = (source, constName) => mapEntries(source, constName).map(([k]) => k)

describe('shared icon set', () => {
  const names = unionNames(core, 'IconName')
  const keys = mapKeys(core, 'ICON_PATHS')

  test('the set is non-trivial', () => {
    assert.ok(names.length >= 80, `expected 80+ icons, found ${names.length}`)
  })

  test('every declared name has a glyph', () => {
    const missing = names.filter((n) => !keys.includes(n))
    assert.deepEqual(missing, [], `declared but not drawn: ${missing.join(', ')}`)
  })

  test('every glyph is a declared name', () => {
    const extra = keys.filter((k) => !names.includes(k))
    assert.deepEqual(extra, [], `drawn but not declared: ${extra.join(', ')}`)
  })

  test('the fallback glyph exists', () => {
    // Icon() falls back to `box` for unknown names, including stale names read
    // out of the local database. If `box` ever disappears, every unknown name
    // renders undefined instead.
    assert.ok(keys.includes('box'), 'ICON_PATHS.box is the fallback and must exist')
  })

  test('marketplace-only pieces were left behind', () => {
    for (const symbol of ['DEPT_MARKS[', 'export function DeptMark']) {
      assert.ok(!core.includes(symbol), `${symbol} is marketplace-specific and must not be here`)
    }
  })
})

describe('parity with papa-rentals', () => {
  if (!existsSync(SIBLING)) {
    test('sibling checkout present', { skip: `not found at ${SIBLING}` }, () => {})
    return
  }

  const sib = readFileSync(SIBLING, 'utf8')

  test('the same icon names exist, in the same order', () => {
    assert.deepEqual(unionNames(core, 'IconName'), unionNames(sib, 'IconName'))
  })

  test('every glyph body is byte-identical', () => {
    // Catches a redrawn path, which a name-only comparison would miss entirely.
    const ours = new Map(mapEntries(core, 'ICON_PATHS'))
    const theirs = new Map(mapEntries(sib, 'ICON_PATHS'))
    const drift = [...ours].filter(([name, body]) => theirs.get(name) !== body).map(([n]) => n)
    assert.deepEqual(drift, [], `glyphs differ from the sibling: ${drift.join(', ')}`)
  })

  test('the comparison actually covered every glyph', () => {
    // Guards the guard: the first version of mapEntries only matched glyphs
    // wrapped in parens, so seven single-element icons were silently skipped
    // and would have drifted unnoticed.
    const covered = mapKeys(core, 'ICON_PATHS')
    const declared = unionNames(core, 'IconName')
    assert.equal(covered.length, declared.length, 'parser missed glyphs')
  })

  test('STAR_PATH is identical', () => {
    const grab = (src) => src.match(/export const STAR_PATH\s*=\s*\n?\s*'([^']+)'/)?.[1]
    assert.equal(grab(core), grab(sib))
  })
})

describe('vendor glyphs', () => {
  const names = unionNames(vendor, 'VendorIconName')
  const keys = mapKeys(vendor, 'VENDOR_ICON_PATHS')

  test('every declared vendor name has a glyph', () => {
    assert.deepEqual(names.filter((n) => !keys.includes(n)), [])
  })

  test('every vendor glyph is declared', () => {
    assert.deepEqual(keys.filter((k) => !names.includes(k)), [])
  })

  test('vendor names never collide with the shared set', () => {
    // A collision would be silently resolved by the spread in ALL_ICON_PATHS,
    // overwriting a marketplace glyph with a vendor one.
    const shared = unionNames(core, 'IconName')
    const clash = names.filter((n) => shared.includes(n))
    assert.deepEqual(clash, [], `vendor glyphs shadow shared ones: ${clash.join(', ')}`)
  })

  test('vendor glyphs follow the 24x24 duotone grammar', () => {
    // The tint spread must appear, or the set reads as two different products.
    assert.ok(vendor.includes("opacity: 0.15"), 'the duotone tint constant must be present')
    const tinted = [...vendor.matchAll(/\{\.\.\.T\}/g)].length
    assert.ok(tinted >= names.length * 0.8, `only ${tinted} of ${names.length} glyphs carry a tint layer`)
  })

  test('no glyph hardcodes a colour', () => {
    // Everything inherits currentColor so `color:` themes it, and so the sun
    // and truck themes work without touching the icon set.
    const body = vendor.slice(vendor.indexOf('VENDOR_ICON_PATHS'))
    const hardcoded = [...body.matchAll(/(?:fill|stroke)="(#[\da-f]{3,8}|rgb[^"]*)"/gi)].map((m) => m[1])
    assert.deepEqual(hardcoded, [], `hardcoded colours: ${hardcoded.join(', ')}`)
  })
})

describe('no emoji, anywhere', () => {
  // Inherited from the marketplace, which was rebuilt off emoji and gates on
  // this. Extended-pictographic covers the emoji blocks without flagging the
  // typographic characters the codebase genuinely uses (— · ×).
  const EMOJI = /\p{Extended_Pictographic}/u

  for (const file of readdirSync(srcDir)) {
    test(`${file} contains no emoji`, () => {
      const text = readFileSync(join(srcDir, file), 'utf8')
      const hit = text.match(EMOJI)
      assert.equal(
        hit,
        null,
        hit ? `found '${hit[0]}' at index ${hit.index} — use a glyph from the icon set` : '',
      )
    })
  }
})

describe('the merged renderer', () => {
  test('merges both maps', () => {
    assert.ok(index.includes('...ICON_PATHS') && index.includes('...VENDOR_ICON_PATHS'))
  })

  test('keeps the sibling render contract', () => {
    // Same viewBox, stroke width, caps and filter, or a glyph looks different
    // in the two products.
    for (const contract of [
      'viewBox="0 0 24 24"',
      'strokeWidth = 1.8',
      'strokeLinecap="round"',
      'strokeLinejoin="round"',
      'filter="url(#icon-sketch)"',
      'stroke="currentColor"',
    ]) {
      assert.ok(index.includes(contract), `render contract lost: ${contract}`)
    }
  })

  test('tolerates an unknown name rather than crashing', () => {
    assert.ok(index.includes('?? ALL_ICON_PATHS.box'))
  })
})
