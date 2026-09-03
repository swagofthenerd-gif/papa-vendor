/**
 * The string table, and the guard that keeps words IN it.
 *
 * Two halves:
 *
 *   1. The table itself is well-formed: no empty string, keys carry a screen
 *      prefix, and no two entries are the same sentence wearing different
 *      trailing punctuation — that near-duplicate is how 'Close' and 'Close.'
 *      end up needing two Roman-Urdu translations for one word.
 *
 *   2. A source scan, in the spirit of the no-emoji test: every .tsx file is
 *      PARSED (with the same TypeScript the build uses, not a regex — JSX
 *      text is not findable by regex without lying) and any JSX text node or
 *      user-facing string attribute with three or more letters that does not
 *      come from STR fails the build. This is what stops the NEXT commit
 *      hardcoding English and quietly raising the price of the Urdu retrofit
 *      (docs/PLAN.md's Roman-Urdu decision; review lens 4 item 5).
 *
 * The allowances are deliberate and small: punctuation and numbers are not
 * words; 'localhost' and 'npm run dev:https' are commands a person must type
 * verbatim, not sentences to translate.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, resolve, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { STR } from '../src/strings.ts'

// Resolved against THIS FILE, not the working directory — the suite runs from
// the repo root and from apps/app, and a cwd-relative walk that finds zero
// files is a guard that passes by examining nothing (see icon-names.test.mjs).
const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')

// The compiler the repo already depends on. Parsing beats regexing here:
// JSX text nodes have no reliable textual delimiter, and the one thing this
// test must never do is pass because its pattern missed the file's shape.
const require = createRequire(import.meta.url)
const ts = require('typescript')

const PREFIXES = ['today', 'scan', 'session', 'gear', 'enquiry', 'hisaab', 'labels', 'common']

/** Sample args so parameterised strings can be rendered and checked. */
function renderValue(value) {
  if (typeof value === 'string') return value
  // Templates coerce numbers; string params render fine with these too.
  const args = [2, 3, 4].slice(0, value.length)
  return String(value(...args))
}

describe('the string table', () => {
  const entries = Object.entries(STR)

  test('is not empty and every key carries a screen prefix', () => {
    assert.ok(entries.length > 100, `expected the full table; found ${entries.length} keys`)
    const bad = entries
      .map(([k]) => k)
      .filter((k) => !PREFIXES.some((p) => k.startsWith(p)))
    assert.deepEqual(bad, [], `keys without a screen prefix: ${bad.join(', ')}`)
  })

  test('no entry renders to an empty string', () => {
    const empty = entries.filter(([, v]) => renderValue(v).trim().length === 0)
    assert.deepEqual(empty.map(([k]) => k), [])
  })

  test('no two entries differ only by trailing punctuation', () => {
    // 'Close' beside 'Close.' is one word needing two translations. IDENTICAL
    // values in two sections are allowed — the same English word on two
    // screens may translate differently, and that is the point of per-screen
    // keys — but a punctuation-only variant is never intentional.
    const groups = new Map()
    for (const [key, value] of entries) {
      if (typeof value !== 'string') continue
      const normalized = value.replace(/[\s.,;:!?…·—–-]+$/u, '')
      const group = groups.get(normalized) ?? new Map()
      group.set(value, [...(group.get(value) ?? []), key])
      groups.set(normalized, group)
    }
    const clashes = [...groups.values()]
      .filter((g) => g.size > 1)
      .map((g) => [...g.values()].flat().join(' / '))
    assert.deepEqual(clashes, [], `trailing-punctuation twins:\n${clashes.join('\n')}`)
  })
})

// ---------------------------------------------------------------------------
// The source scan.

/** Attributes whose literal value a person sees or hears. */
const VISIBLE_ATTRS = new Set(['aria-label', 'placeholder', 'alt', 'title'])

/**
 * Verbatim technical tokens a person types or reads as code, not prose.
 * Keep this list short: every addition is a word the Urdu table cannot reach.
 */
const ALLOWED_TEXT = new Set([
  'localhost', // the address to open, typed as-is
  'npm run dev:https', // the command to run, typed as-is
])

/** Three or more letters — the threshold below which text is not a word. */
const WORDY = /\p{L}{3,}/u

function walkDir(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walkDir(full) : [full]
  })
}

function scanFile(file) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX,
  )
  const violations = []

  const report = (node, text) => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.push(`${relative(APP, file)}:${line + 1}: ${JSON.stringify(text.trim())}`)
  }

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const text = node.text
      if (WORDY.test(text) && !ALLOWED_TEXT.has(text.trim())) report(node, text)
    }
    if (
      ts.isJsxAttribute(node) &&
      VISIBLE_ATTRS.has(node.name.getText(source)) &&
      node.initializer !== undefined &&
      ts.isStringLiteral(node.initializer) &&
      WORDY.test(node.initializer.text)
    ) {
      report(node, node.initializer.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

describe('no hardcoded words in the chrome', () => {
  const files = walkDir(join(APP, 'src')).filter((f) => f.endsWith('.tsx'))

  test('the walk found the screens', () => {
    // A guard for the guard: zero files means a moved directory, not clean code.
    assert.ok(files.length > 15, `expected the app's .tsx files; found ${files.length}`)
  })

  test('every rendered word comes from STR', () => {
    const violations = files.flatMap(scanFile)
    assert.deepEqual(
      violations,
      [],
      'user-visible text outside strings.ts — add it to STR and reference it:\n' +
        violations.join('\n'),
    )
  })
})
