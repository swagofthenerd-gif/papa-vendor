/**
 * Every icon name used in the app must exist.
 *
 * `Icon` resolves an unknown name to a generic box INSTEAD OF FAILING. That is
 * the right runtime behaviour — a missing glyph must never white-screen a
 * phone — but it means a typo ships as a wrong-but-plausible icon that looks
 * deliberate, and nobody reports it. Three names in one screen were wrong when
 * this test was written.
 *
 * The valid set is READ FROM SOURCE rather than imported, because the icon
 * modules are `.tsx` and Node strips types but cannot transform JSX. Same
 * constraint that put status.ts, hold.ts and scan-row.ts in plain .ts files.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Resolved against THIS FILE, not the working directory. The suite is run
// from the repo root by `npm test` and from apps/app directly, and a
// cwd-relative path silently finds nothing in one of those — which would make
// this guard pass by examining zero files.
const HERE = dirname(fileURLToPath(import.meta.url))
const APP = resolve(HERE, '..')
const ROOT = resolve(HERE, '../../..')

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/** Names declared in a `export type XName = 'a' | 'b' | ...` union, or as map keys. */
function namesFrom(file) {
  if (!existsSync(file)) return []
  const src = readFileSync(file, 'utf8')
  const names = new Set()
  // The IconName union in the shared design package.
  const union = src.match(/export type \w*IconName\s*=([\s\S]*?);/)
  if (union) for (const m of union[1].matchAll(/'([a-z0-9-]+)'/g)) names.add(m[1])
  // Vendor glyphs are declared as quoted object keys.
  for (const m of src.matchAll(/^\s{2}'([a-z0-9-]+)':/gm)) names.add(m[1])
  return [...names]
}

test('every <Icon name="..."> in the app resolves to a real glyph', () => {
  const valid = new Set([
    ...namesFrom(join(ROOT, 'node_modules/@papa/design/src/icons/core.tsx')),
    ...namesFrom(join(ROOT, 'packages/icons/src/vendor-glyphs.tsx')),
  ])

  assert.ok(valid.size > 20, `expected to find the icon set; found ${valid.size} names`)

  const bad = []
  for (const file of walk(join(APP, 'src')).filter((f) => /\.tsx?$/.test(f))) {
    const src = readFileSync(file, 'utf8')
    // Literal names only. A dynamic name cannot be checked here, which is why
    // the TONE-style maps in the screens are typed as AnyIconName so the
    // compiler catches those instead.
    for (const m of src.matchAll(/<Icon[^>]*?\sname=["']([a-z0-9-]+)["']/gs)) {
      if (!valid.has(m[1])) bad.push(`${file}: ${m[1]}`)
    }
    for (const m of src.matchAll(/icon:\s*['"]([a-z0-9-]+)['"]/g)) {
      if (!valid.has(m[1])) bad.push(`${file}: ${m[1]}`)
    }
  }

  assert.deepEqual(bad, [], `these would silently render as a box:\n${bad.join('\n')}`)
})
