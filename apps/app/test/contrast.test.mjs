/**
 * Contrast claims, made executable.
 *
 * semantic.css asserts specific ratios in its comments ("5.6:1 with white
 * ink", "4.6:1 on white"). Comments rot. These tests recompute the ratios
 * from the actual declared values, so changing a colour without checking
 * fails the build instead of quietly shipping an unreadable badge to a
 * loading dock.
 *
 * WCAG 2.1 relative luminance / contrast ratio.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'src', 'semantic.css'), 'utf8')

const AA_NORMAL = 4.5
const AA_LARGE = 3.0

function srgbToLinear(c) {
  const s = c / 255
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

function luminance(hex) {
  const m = hex.trim().match(/^#?([\da-f]{6})$/i)
  assert.ok(m, `not a 6-digit hex colour: '${hex}'`)
  const n = parseInt(m[1], 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b)
}

function contrast(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (l1 + 0.05) / (l2 + 0.05)
}

/** Read a declared value out of a given selector block. */
function declared(selector, name) {
  const start = css.indexOf(selector)
  assert.notEqual(start, -1, `selector ${selector} not found in semantic.css`)
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  const body = css.slice(open + 1, close).replace(/\/\*[\s\S]*?\*\//g, '')
  const m = body.match(new RegExp(`--${name}\\s*:\\s*([^;]+);`))
  return m ? m[1].trim() : null
}

const round = (n) => Math.round(n * 10) / 10

describe('sun mode — the theme that has to survive direct sunlight', () => {
  const SEL = ":root[data-theme='sun']"
  const ink = declared(SEL, 'status-ink')
  const bg = declared(SEL, 'bg')

  for (const bucket of ['here', 'out', 'attention']) {
    test(`--status-${bucket} carries its ink at AA`, () => {
      const fill = declared(SEL, `status-${bucket}`)
      const ratio = contrast(fill, ink)
      assert.ok(
        ratio >= AA_NORMAL,
        `--status-${bucket} (${fill}) on ${ink} is ${round(ratio)}:1, needs ${AA_NORMAL}:1`,
      )
    })

    test(`--status-${bucket} is distinguishable from the page`, () => {
      const fill = declared(SEL, `status-${bucket}`)
      const ratio = contrast(fill, bg)
      // A solid fill that vanishes into a white page is not a status indicator.
      assert.ok(
        ratio >= AA_LARGE,
        `--status-${bucket} (${fill}) on ${bg} is only ${round(ratio)}:1`,
      )
    })
  }

  test('body text is maximally legible', () => {
    assert.ok(contrast(declared(SEL, 'ink'), bg) >= 20, 'sun mode should be black on white')
  })

  test('--muted is still readable, not decorative', () => {
    const ratio = contrast(declared(SEL, 'muted'), bg)
    assert.ok(ratio >= AA_NORMAL, `--muted is ${round(ratio)}:1 in sun mode`)
  })

  test('--accent-strong passes AA as text', () => {
    const ratio = contrast(declared(SEL, 'accent-strong'), bg)
    assert.ok(ratio >= AA_NORMAL, `--accent-strong is ${round(ratio)}:1, needs ${AA_NORMAL}:1`)
  })

  test('every shadow is disabled, because shadows are invisible outdoors', () => {
    for (const s of ['shadow-xs', 'shadow-sm', 'shadow-md', 'shadow-lg', 'shadow']) {
      assert.equal(declared(SEL, s), 'none', `--${s} must be none in sun mode`)
    }
  })

  test('borders thicken to replace the shadows', () => {
    assert.equal(declared(SEL, 'line-w'), '2px')
  })
})

describe('accent-as-text', () => {
  test('the light-theme --accent-strong passes AA on white', () => {
    const ratio = contrast(declared(':root {', 'accent-strong'), '#ffffff')
    assert.ok(
      ratio >= AA_NORMAL,
      `--accent-strong is ${round(ratio)}:1 on white, needs ${AA_NORMAL}:1`,
    )
  })

  test('it exists precisely because the inherited --accent does NOT pass', () => {
    // Documents the reason for the token. If the marketplace ever darkens
    // --accent enough to pass on its own, this fails and --accent-strong
    // can be deleted — which is a good failure to be told about.
    const ratio = contrast('#ff6b2c', '#ffffff')
    assert.ok(
      ratio < AA_NORMAL,
      `inherited --accent now passes at ${round(ratio)}:1 — --accent-strong may be redundant`,
    )
  })
})

describe('truck mode — a dark van at 05:00', () => {
  const SEL = ":root[data-theme='dark']"

  test('card is separable from the page background', () => {
    // The marketplace's dark is a cozy phone-in-bed dark (1.10:1); beside a
    // live camera viewfinder its card edges vanish. Not an AA threshold — a
    // deliberate floor, so a future tweak cannot flatten it back.
    //
    // Beware the trap this test originally caught: darkening --bg makes this
    // WORSE, because at low luminance the +0.05 term dominates and both ends
    // converge. Separation must come from raising --card.
    const ratio = contrast(declared(SEL, 'card'), declared(SEL, 'bg'))
    const sibling = contrast('#211d18', '#161310')
    assert.ok(ratio >= 1.25, `card/bg separation is only ${round(ratio)}:1`)
    assert.ok(
      ratio > sibling,
      `must beat the marketplace's ${round(sibling)}:1, got ${round(ratio)}:1`,
    )
  })

  test('--line is raised above the marketplace value', () => {
    const line = declared(SEL, 'line')
    const ratio = contrast(line, declared(SEL, 'card'))
    const sibling = contrast('#37322d', '#211d18')
    assert.ok(
      ratio > sibling,
      `--line ${line} gives ${round(ratio)}:1 vs the sibling's ${round(sibling)}:1 — it must be higher`,
    )
  })

  test('body and secondary text pass AA on the raised card', () => {
    const card = declared(SEL, 'card')
    for (const [name, min] of [['ink', 4.5], ['muted', 4.5]]) {
      // --ink and --muted come from @papa/design, not this file. Raising
      // --card moves them; this asserts the raise did not break them.
      const value = name === 'ink' ? '#f2efec' : '#a8a29e'
      const ratio = contrast(value, card)
      assert.ok(ratio >= min, `--${name} on the raised card is ${round(ratio)}:1`)
    }
  })

  test('status fills carry the flipped dark ink', () => {
    const ink = declared(SEL, 'status-ink')
    // Dark-theme fills come from @papa/design (--green/--purple/--red dark).
    for (const [bucket, fill] of [
      ['here', '#34d074'],
      ['out', '#a78bfa'],
      ['attention', '#f87171'],
    ]) {
      const ratio = contrast(fill, ink)
      assert.ok(ratio >= AA_NORMAL, `${bucket} (${fill}) on ${ink} is ${round(ratio)}:1`)
    }
  })

  test('status ink flips to dark on the lighter dark-theme fills', () => {
    assert.equal(declared(SEL, 'status-ink'), '#0f0d0b')
  })
})
