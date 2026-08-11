/**
 * Parity with Papa Rentals.
 *
 * The whole justification for a shared token package is that both apps use
 * literally the same values. That claim is worthless unless something checks
 * it, so this parses the sibling's real stylesheet and compares.
 *
 * When this fails, one of two things happened and they need different fixes:
 *   1. Papa Rentals changed a token       -> port the change into tokens.json
 *   2. tokens.json changed                -> port it into Papa Rentals, or
 *                                            accept the divergence DELIBERATELY
 *                                            by adding it to KNOWN_DIVERGENCES
 *                                            with a reason.
 *
 * It skips (rather than fails) when the sibling checkout is absent, so this
 * repo still tests standalone on a machine that only has papa-vendor.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const tokens = JSON.parse(readFileSync(join(here, '..', 'src', 'tokens.json'), 'utf8'))

const SIBLING = join(here, '..', '..', '..', '..', 'papa-rentals', 'src', 'styles.css')

/**
 * Tokens that are deliberately NOT in the shared package.
 * `--radius` and `--shadow` are convenience aliases; they ARE shared, but they
 * live in tokens.alias rather than a token group, so the group walk misses them.
 */
const ALIASES = new Set(['radius', 'shadow'])

/** Deliberate divergences: token -> why. Empty is the goal. */
const KNOWN_DIVERGENCES = new Map([])

function parseBlock(css, selector) {
  const start = css.indexOf(selector)
  if (start === -1) return null
  const open = css.indexOf('{', start)
  const close = css.indexOf('\n}', open)
  const body = css.slice(open + 1, close)
  const out = new Map()
  // Strip comments first so a `--foo: bar;` inside a comment can't be parsed.
  for (const line of body.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')) {
    const m = line.match(/^\s*--([\w-]+)\s*:\s*(.+?);\s*$/)
    if (m) out.set(m[1], m[2].trim())
  }
  return out
}

const GROUPS = ['color', 'radius', 'shadow', 'fontSize', 'space', 'motion', 'size']

/** Flatten tokens.json to name -> {light, dark|undefined}. */
function flatten() {
  const out = new Map()
  for (const group of GROUPS) {
    for (const [name, value] of Object.entries(tokens[group] ?? {})) {
      out.set(
        name,
        value !== null && typeof value === 'object'
          ? { light: value.light, dark: value.dark }
          : { light: value, dark: undefined },
      )
    }
  }
  for (const [name, value] of Object.entries(tokens.alias ?? {})) {
    out.set(name, { light: value, dark: undefined })
  }
  return out
}

describe('token parity with papa-rentals', () => {
  if (!existsSync(SIBLING)) {
    test('sibling checkout present', { skip: `not found at ${SIBLING}` }, () => {})
    return
  }

  const css = readFileSync(SIBLING, 'utf8')
  const light = parseBlock(css, ':root {')
  const dark = parseBlock(css, ":root[data-theme='dark']")
  const ours = flatten()

  test('the sibling stylesheet parses', () => {
    assert.ok(light && light.size > 20, 'light :root block should yield tokens')
    assert.ok(dark && dark.size > 10, 'dark block should yield tokens')
  })

  test('every shared token matches the sibling in light theme', () => {
    const mismatches = []
    for (const [name, value] of ours) {
      if (KNOWN_DIVERGENCES.has(name)) continue
      if (!light.has(name)) {
        mismatches.push(`--${name}: missing from papa-rentals`)
        continue
      }
      if (light.get(name) !== value.light) {
        mismatches.push(`--${name}: sibling='${light.get(name)}' ours='${value.light}'`)
      }
    }
    assert.deepEqual(mismatches, [], `\n  ${mismatches.join('\n  ')}\n`)
  })

  test('every shared token matches the sibling in dark theme', () => {
    const mismatches = []
    for (const [name, value] of ours) {
      if (KNOWN_DIVERGENCES.has(name) || value.dark === undefined) continue
      if (!dark.has(name)) {
        mismatches.push(`--${name}: has a dark value here but none in papa-rentals`)
        continue
      }
      if (dark.get(name) !== value.dark) {
        mismatches.push(`--${name}: sibling='${dark.get(name)}' ours='${value.dark}'`)
      }
    }
    assert.deepEqual(mismatches, [], `\n  ${mismatches.join('\n  ')}\n`)
  })

  test('the sibling has no token we are missing', () => {
    const missing = [...light.keys()].filter((n) => !ours.has(n) && !ALIASES.has(n))
    assert.deepEqual(
      missing,
      [],
      `papa-rentals defines tokens absent from the shared package: ${missing.join(', ')}`,
    )
  })

  test('every dark override in the sibling is represented here', () => {
    const missing = [...dark.keys()].filter((n) => {
      const t = ours.get(n)
      return !t || t.dark === undefined
    })
    assert.deepEqual(missing, [], `dark overrides not captured: ${missing.join(', ')}`)
  })
})

describe('generated output', () => {
  const distCss = join(here, '..', 'dist', 'tokens.css')

  test('dist is built and current', () => {
    assert.ok(existsSync(distCss), 'run `npm run build -w @papa/tokens` first')
    const css = readFileSync(distCss, 'utf8')
    const built = parseBlock(css, ':root {')
    for (const [name, value] of flatten()) {
      assert.equal(built.get(name), value.light, `--${name} is stale in dist/tokens.css`)
    }
  })

  test('dark values appear in exactly one rule, never duplicated', () => {
    const css = readFileSync(distCss, 'utf8')
    // The sibling's own comment explains why: two copies drift apart.
    assert.equal(
      (css.match(/data-theme='dark'/g) ?? []).length,
      1,
      'dark tokens must be defined once, not also under a media query',
    )
  })
})
