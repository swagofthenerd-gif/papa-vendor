# Interface audit — September 2026 (W10, the polish pass)

Every route of the app was walked with Playwright at 375×812 and at 320 wide,
in the light (ledger) and dark (carbon) themes, before and after the polish
pass. The script (a scratchpad tool, not shipped) measured, per route:

- **Targets** — every visible `button`, link, input and grid cell; the hit
  rectangle is the box plus any absolutely positioned `::after` apron
  (the expand-hit-area technique), and must be ≥ 48px on both sides.
- **Icon buttons named** — a button with no text must carry `aria-label`.
- **Inputs labelled** — every input/textarea has a `<label for>`, a wrapping
  label, or `aria-label`.
- **Contrast** — every element with a text node: computed colour against the
  composited background (walking up through translucent layers), ≥ 4.5:1
  (3:1 for large text), disabled controls excluded.
- **No overflow at 320** — `scrollWidth` of the page must not exceed the
  viewport.
- **Focus ring visible** — the first 40 Tab stops; a `:focus-visible`
  element must show an outline or a box-shadow.
- Also checked once per build: reduced motion collapses every animation to
  0.01ms (`.view`, `.stamp`, `.sheet`, `.sheet-backdrop`, `.nav-pill`);
  the five busiest screens (Today, Gear, Desk, Khata, Booking) at Roman-Urdu
  string lengths keep 375 wide with no overflow.

Counts are offenders summed over both themes × both widths (so one bad
element on every pass counts 4). **Before → after.**

| Route | Path | Targets ≥ 48px | Icon buttons named | Inputs labelled | Contrast ≥ 4.5:1 | No overflow at 320 | Focus ring visible |
|---|---|---|---|---|---|---|---|
| today | `#/` | 114 → 0 | 0 | 0 | 2 → 0 | 0 | 0 |
| gear | `#/gear` | 36 → 0 | 0 | 0 | 44 → 0 | 0 | 0 |
| asset | `#/asset/…` | 26 → 0 | 0 | 0 | 0 | 0 | 0 |
| desk | `#/desk` | 12 → 0 | 0 | 4 → 0 | 0 | 2 → 0 | 0 |
| calendar | `#/calendar` | 140 → 60 | 0 | 0 | 0 | 2 → 0 | 0 |
| booking | `#/booking/…` | 24 → 0 | 0 | 0 | 4 → 0 | 2 → 0 | 0 |
| khata | `#/owed` | 8 → 0 | 0 | 0 | 0 | 2 → 0 | 0 |
| customer | `#/customer/…` | 16 → 0 | 0 | 0 | 6 → 0 | 0 | 0 |
| hisaab | `#/hisaab` | 8 → 0 | 0 | 0 | 4 → 0 | 0 | 0 |
| partner | `#/partner/…` | 28 → 0 | 0 | 0 | 4 → 0 | 4 → 0 | 0 |
| settings | `#/settings` | 40 → 0 | 0 | 0 | 6 → 0 | 2 → 0 | 0 |
| rates | `#/settings/rates` | 72 → 0 | 0 | 0 | 4 → 0 | 2 → 0 | 0 |
| enquiry | `#/enquiry` | 12 → 0 | 0 | 4 → 0 | 0 | 2 → 0 | 0 |
| session | `#/session/…` | 4 → 0 | 0 | 0 | 0 | 0 | 0 |
| closed | `#/closed` | 28 → 0 | 0 | 0 | 6 → 0 | 0 | 0 |
| ginti | `#/ginti` | 0 | 0 | 0 | 0 | 0 | 0 |
| import | `#/import` | 4 → 0 | 0 | 4 → 0 | 0 | 0 | 0 |
| scan | `#/scan/…` | 0 | 0 | 0 | 0 | 0 | 0 |
| **all** | | **572 → 60** | **0 → 0** | **12 → 0** | **80 → 0** | **18 → 0** | **0 → 0** |

## What was found, and what was done

**Targets (572 → 60).** The whole control system stood on the marketplace's
`--tap: 44px`. Buttons, icon doors, the tab bar, the search field and the
sheet inputs were 44–46px; the small pill (`.btn-sm`) was 40; the filter
chips 32; the crew chips 36; the weekday toggles 30; the calendar's day cells
47 wide. Fixes, all in `semantic.css` / `app.css`:

- `--tap` is 48px in this app (a glove floor, deliberately above the phone
  floor); everything sized from the token moved with it.
- `.btn-sm` draws at 44 and is hit at 48 through an invisible 2px apron
  above and below (`::after`); `.filter-chip` draws at 40 with a 4px apron;
  the crew chip is 48; the weekday toggles are 48 wide and wrap.
- The calendar grid drops its column gap so a day cell is 49px wide at 375.

The 60 that remain are the thirty day cells of the month grid at **320 wide**
(41px across, both themes): seven columns on a 288px column cannot each be
48. They are 52px tall and separated by rules; this is accepted as the one
layout that cannot meet the floor on a 320px phone, and is met at 375.

**Icon buttons named (0 → 0).** Every icon-only button already carried an
`aria-label`; the audit confirms it on every route in both languages.

**Inputs labelled (12 → 0).** The kit-list paste box (Desk / Enquiry) and the
import paste box had a placeholder and no name. Both now carry `aria-label`
(EN + UR).

**Contrast (80 → 0).** Two token pairs:

- `.btn-primary` filled with the raw marketplace accent `#ff6b2c`; white on it
  is 2.8:1. It now fills with `--accent-strong` (5.0:1 with white); the dark
  theme's alias is a light orange and takes the dark status ink instead
  (9.0:1) through `--btn-primary-ink`.
- Dark `--muted` `#8fa0af` on `--card-2` was 4.4:1 — the badge and the gear
  group count sit on `card-2`. It is `#96a7b6` now (4.8:1 there, 5.5:1 on the
  card). Both pairs are pinned in `apps/app/test/contrast.test.mjs`.

**No overflow at 320 (18 → 0).** `.app-shell` is a grid whose single column
was the implicit `auto`, so a nowrap title beside two header buttons sized the
whole shell to its min-content and every such page scrolled sideways (eight
routes at 320; the partner page at 375 too). The column is
`minmax(0, 1fr)` now and the title ellipsises as it was written to.

**Focus ring visible (0 → 0).** The global `:focus-visible` rule covers every
control; the tab walk found no stop without a ring.

**Safe areas.** The tab bar already padded `env(safe-area-inset-bottom)`;
sheets now do too (`.sheet` bottom padding), so the phone's gesture bar never
sits on the last button.

**`hidden` over display toggling.** No `style={{ display }}` toggles exist in
the app; the one hidden control (the payment-QR file input) uses the
attribute.

**Reduced motion.** Honoured globally (`semantic.css` and `app.css`) and by
the sheet's JavaScript: with the preference set, every close is instant and no
exit wait is scheduled. Verified by computed `animation-duration` on a
reduced-motion context.

**Roman Urdu.** Today, Gear, Desk, Khata and Booking screenshot at 375 with
the UR table: no overflow, no target under the floor; the screenshots are in
the W10 report's shot list.

## Motion inventory after the pass

| What | Duration | Curve | Note |
|---|---|---|---|
| Sheet in | 200ms | ease-out | translateY(32px) + fade |
| Sheet out | 150ms | ease-in | translateY(100%) + backdrop fade |
| Sheet drag | follows the thumb | — | grip and header only; spring back on `--dur` / `--ease-spring`; dismiss past 30% of height or a 0.5px/ms flick |
| Tab pill | 250ms (`--dur`) | `--ease-spring` | one pill slides between columns, remembered across screens |
| Stamp landing | 120ms (+60ms delay) | ease-out | keyed by status: plays on a change, never loops; still on the scan row |
| View in | 240ms | ease-out | unchanged |
| List stagger | 300ms, 30ms steps | ease-out | was 340/35 |
| Scan row in | 150ms (`--dur-fast`) | ease-out | unchanged; killed under reduced motion |
| Scan row pulse | 240ms | ease-out | was 400ms |

Nothing in the app runs longer than 300ms; nothing loops.

