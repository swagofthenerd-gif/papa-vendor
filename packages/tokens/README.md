# @papa/tokens

Primitive design tokens shared by **Papa Rentals** and **Papa Vendor**.

## The one rule

**Primitives live here. Semantics live in the app.**

| Belongs here | Belongs in `apps/*/src/semantic.css` |
|---|---|
| `--accent`, `--ink`, `--line`, `--bg`, `--card` | `--status-here`, `--status-out`, `--status-attention` |
| `--r-sm…--r-xl`, `--sp-1…--sp-8`, `--fs-*` | `--tap-glove`, `--row-h-comfort`, `--r-row` |
| `--shadow-*`, `--ease-*`, `--dur-*`, `--tap` | `--ff-code`, `--accent-strong`, sun-mode overrides |

Sharing primitives is what stops the two apps drifting into different
oranges. Keeping semantics app-owned is what stops a marketplace brand
refresh silently changing what "overdue" looks like on a loading dock. You
need both properties, so you need both layers.

**Do not add a third theme here.** Papa Vendor has a `sun` theme for direct
sunlight on a loading dock; that is a semantic concern and it lives in the app.

## Usage

```css
@import '@papa/tokens/css';   /* primitives: light + dark */
@import './semantic.css';     /* meaning, app-owned */
```

```ts
import { cssVar, tokenValue } from '@papa/tokens'

cssVar('accent')                 // 'var(--accent)'  <- prefer this
tokenValue('accent', 'dark')     // '#ff7b40'        <- only where CSS can't reach
```

`tokenValue` exists for canvas, native bridges, and `<meta name="theme-color">`.
In CSS, always use the variable, or the theme switch won't reach it.

## Editing

`src/tokens.json` is the source of truth. Everything in `dist/` is generated.

```bash
npm run build -w @papa/tokens
npm test
```

Light values sit on bare `:root`; dark values are emitted **once**, under
`:root[data-theme='dark']` — never also duplicated into a
`prefers-color-scheme` media query, because two copies drift. The attribute
(rather than the media query alone) is what lets someone choose dark at noon;
a boot script sets it from the saved choice, falling back to the system
setting.

A token with the same value in both themes is written as a plain string, not
`{light, dark}` — the dark block then correctly omits it, matching the sibling.

## Parity

`test/parity.test.mjs` parses the real `papa-rentals/src/styles.css` and
asserts every shared token matches, in both themes, in both directions.

The claim "both apps use the same values" is worthless unless something checks
it. When the test fails, work out which of these happened:

1. **Papa Rentals changed a token** → port it into `tokens.json`.
2. **`tokens.json` changed** → port it into Papa Rentals, **or** accept the
   divergence deliberately by adding it to `KNOWN_DIVERGENCES` with a reason.

The test skips rather than fails when the sibling checkout is absent, so this
package still tests standalone.

## Status: not yet consumed by Papa Rentals

Right now this package is the canonical source but **only Papa Vendor reads
it**. Papa Rentals still has its values inline in `styles.css`; the parity
test is what keeps them honest in the meantime.

Wiring the marketplace up to consume this package is deliberately deferred —
it's a deployed app mid-backlog with a relative-base build, and the two repos
are separate, so it needs the distribution decision made first (see
`README.md` → "The shared-package consequence"). Until then, treat a parity
failure as a real signal, not test noise.
