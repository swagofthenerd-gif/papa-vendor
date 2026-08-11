/*
 * Papa design system — shared icon set.
 *
 * EXTRACTED VERBATIM from papa-rentals/src/components/icons.tsx (lines 1-777).
 * Consumed by both Papa Rentals and Papa Vendor.
 *
 * Kept as JSX rather than converted to path data on purpose: these are
 * hand-drawn duotone glyphs with per-glyph <circle>/<rect>/<path> geometry and
 * a shared tint spread. Mechanically flattening 85 of them to a data format
 * buys nothing and risks silent visual regressions.
 *
 * DeptMark and DEPT_MARKS are deliberately NOT here — they are marketplace
 * department illustrations, not icons, and they stay in papa-rentals.
 *
 * Vendor-specific glyphs (barcode, forklift, wrench, case, ...) go in
 * ./vendor-glyphs.tsx, NOT in this file, so parity with the sibling stays
 * mechanically checkable.
 */
import type { ReactNode } from 'react'

/*
 * Papa Rentals icon system — hand-drawn duotone-soft SVG set.
 *
 * Conventions (every glyph):
 *  - 24×24 grid, ~1.5px inset margin, corner radii ≥ 2, simple geometry.
 *  - Line work inherits from the root svg: stroke=currentColor, round caps/joins.
 *  - Duotone: the FIRST path of a glyph is the soft tint layer —
 *    fill="currentColor" opacity=".15" stroke="none" — on the key mass only.
 *  - Single color throughout, so `color:` on any wrapper themes the icon
 *    (dark mode and white-on-gradient sites work for free).
 */

/** Rounded five-point star, shared with the Stars rating components. */
export const STAR_PATH =
  'M12 3.2l2.5 5.1c.1.2.3.4.5.4l5.6.8c.6.1.8.8.4 1.2l-4 3.9c-.2.2-.2.4-.2.6l1 5.5c.1.6-.5 1-1 .7l-5-2.6a.7.7 0 0 0-.6 0l-5 2.6c-.5.3-1.1-.1-1-.7l1-5.5a.7.7 0 0 0-.2-.6l-4-3.9c-.5-.4-.2-1.1.4-1.2l5.6-.8c.2 0 .4-.2.5-.4L12 3.2z'

const T = { fill: 'currentColor', opacity: 0.15, stroke: 'none' } as const

export type IconName =
  | 'home' | 'search' | 'cart' | 'box' | 'user' | 'bell' | 'bell-off'
  | 'star' | 'heart' | 'heart-filled'
  | 'check' | 'check-circle' | 'x' | 'x-circle' | 'warning' | 'siren'
  | 'hourglass' | 'clock' | 'refresh' | 'ban' | 'dot'
  | 'chevron-left' | 'chevron-right' | 'chevron-down' | 'arrow-right' | 'arrow-up-right'
  | 'undo' | 'skip' | 'play' | 'pause'
  | 'bolt' | 'handshake' | 'coins' | 'shield' | 'wallet' | 'trophy' | 'ticket'
  | 'gift' | 'crown' | 'medal' | 'card' | 'mobile' | 'cash' | 'calendar'
  | 'receipt' | 'repeat' | 'flag' | 'scale' | 'pin' | 'chat' | 'headset'
  | 'trash' | 'sliders' | 'send' | 'mail' | 'scroll' | 'puzzle' | 'sparkles'
  | 'target' | 'eye' | 'flame' | 'backpack' | 'question' | 'chart'
  | 'truck' | 'van' | 'hand' | 'driver' | 'wrench' | 'phone' | 'users'
  | 'store' | 'flag-checkered'
  | 'camera' | 'video-camera' | 'film' | 'lens' | 'bulb' | 'mic'
  | 'clapperboard' | 'drone' | 'car' | 'building' | 'greenscreen' | 'skyline'
  | 'landmark' | 'warehouse' | 'sofa' | 'armchair' | 'coffee' | 'tree' | 'briefcase'
  | 'sun' | 'moon'

export const ICON_PATHS: Record<IconName, ReactNode> = {
  /* ---------- nav / chrome ---------- */
  home: (
    <>
      <path {...T} d="M4.5 10.4 12 4.3l7.5 6.1V19a1.7 1.7 0 0 1-1.7 1.7H6.2A1.7 1.7 0 0 1 4.5 19Z" />
      <path d="M4.5 10.4 12 4.3l7.5 6.1V19a1.7 1.7 0 0 1-1.7 1.7H6.2A1.7 1.7 0 0 1 4.5 19Z" />
      <path d="M9.6 20.5v-4.6a1.2 1.2 0 0 1 1.2-1.2h2.4a1.2 1.2 0 0 1 1.2 1.2v4.6" />
    </>
  ),
  search: (
    <>
      <circle {...T} cx="10.8" cy="10.8" r="6.3" />
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.6 15.6 4.6 4.6" />
    </>
  ),
  cart: (
    <>
      <path {...T} d="M6.4 8h13.2l-1.7 7a1.7 1.7 0 0 1-1.6 1.3H9.2a1.7 1.7 0 0 1-1.7-1.4Z" />
      <path d="M3 3.8h1.8a1 1 0 0 1 1 .8L7.5 15a1.7 1.7 0 0 0 1.7 1.4h9.1a1.7 1.7 0 0 0 1.6-1.3l1.7-7H6.4" />
      <circle cx="9.7" cy="20.2" r="1.4" />
      <circle cx="17.7" cy="20.2" r="1.4" />
    </>
  ),
  box: (
    <>
      <path {...T} d="M4 8.2 12 4.4l8 3.8v7.6a1.8 1.8 0 0 1-1 1.6L12 20.8 5 17.4a1.8 1.8 0 0 1-1-1.6Z" />
      <path d="M4 8.2 12 4.4l8 3.8v7.6a1.8 1.8 0 0 1-1 1.6L12 20.8 5 17.4a1.8 1.8 0 0 1-1-1.6Z" />
      <path d="M4 8.2 12 12l8-3.8M12 12v8.8" />
    </>
  ),
  user: (
    <>
      <circle {...T} cx="12" cy="8.2" r="4" />
      <circle cx="12" cy="8.2" r="4" />
      <path d="M4.8 20.4a7.6 7.6 0 0 1 14.4 0" />
    </>
  ),
  bell: (
    <>
      <path {...T} d="M6 16.2v-5a6 6 0 0 1 12 0v5l1.4 2.2a.7.7 0 0 1-.6 1.1H5.2a.7.7 0 0 1-.6-1.1Z" />
      <path d="M6 16.2v-5a6 6 0 0 1 12 0v5l1.4 2.2a.7.7 0 0 1-.6 1.1H5.2a.7.7 0 0 1-.6-1.1Z" />
      <path d="M10.2 19.7a1.9 1.9 0 0 0 3.6 0" />
    </>
  ),
  'bell-off': (
    <>
      <path {...T} d="M6 16.2v-5c0-.8.2-1.6.5-2.4L17 18.2l.8 1.3H5.2a.7.7 0 0 1-.6-1.1Z" />
      <path d="M6.5 8.8A6 6 0 0 1 18 11.2v5l1.4 2.2a.7.7 0 0 1-.6 1.1H7.5M6 16.2v-4M10.2 19.7a1.9 1.9 0 0 0 3.6 0" />
      <path d="m4 4 16 16" />
    </>
  ),

  /* ---------- rating ---------- */
  star: (
    <>
      <path {...T} d={STAR_PATH} />
      <path d={STAR_PATH} />
    </>
  ),
  heart: (
    <>
      <path {...T} d="M12 19.8S4 15 4 9.7a4.4 4.4 0 0 1 8-2.6 4.4 4.4 0 0 1 8 2.6c0 5.3-8 10.1-8 10.1z" />
      <path d="M12 19.8S4 15 4 9.7a4.4 4.4 0 0 1 8-2.6 4.4 4.4 0 0 1 8 2.6c0 5.3-8 10.1-8 10.1z" />
    </>
  ),
  'heart-filled': (
    <path
      d="M12 19.8S4 15 4 9.7a4.4 4.4 0 0 1 8-2.6 4.4 4.4 0 0 1 8 2.6c0 5.3-8 10.1-8 10.1z"
      fill="currentColor"
    />
  ),

  /* ---------- status ---------- */
  check: <path d="m5 12.8 4.4 4.4L19 7.4" />,
  'check-circle': (
    <>
      <circle {...T} cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="8.6" />
      <path d="m8.2 12.4 2.7 2.7 5-5.4" />
    </>
  ),
  x: <path d="m6 6 12 12M18 6 6 18" />,
  'x-circle': (
    <>
      <circle {...T} cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="8.6" />
      <path d="m9 9 6 6M15 9l-6 6" />
    </>
  ),
  warning: (
    <>
      <path {...T} d="M10.4 4.6a1.9 1.9 0 0 1 3.2 0l7 12.2a1.8 1.8 0 0 1-1.6 2.7H5a1.8 1.8 0 0 1-1.6-2.7Z" />
      <path d="M10.4 4.6a1.9 1.9 0 0 1 3.2 0l7 12.2a1.8 1.8 0 0 1-1.6 2.7H5a1.8 1.8 0 0 1-1.6-2.7Z" />
      <path d="M12 9.4v4.2M12 16.5v.1" />
    </>
  ),
  siren: (
    <>
      <path {...T} d="M7.5 17v-4.5a4.5 4.5 0 0 1 9 0V17Z" />
      <path d="M7.5 17v-4.5a4.5 4.5 0 0 1 9 0V17" />
      <rect x="5" y="17" width="14" height="3.4" rx="1.7" />
      <path d="M12 3.4v1.8M5.4 5.8l1.3 1.3M18.6 5.8l-1.3 1.3" />
    </>
  ),
  hourglass: (
    <>
      <path {...T} d="M8 20.2h8v-2.4c0-2-4-4-4-4s-4 2-4 4Z" />
      <path d="M6.5 3.8h11M6.5 20.2h11M8 3.8v2.4c0 2.3 4 4.6 4 5.8 0 1.2-4 3.5-4 5.8v2.4M16 3.8v2.4c0 2.3-4 4.6-4 5.8 0 1.2 4 3.5 4 5.8v2.4" />
    </>
  ),
  clock: (
    <>
      <circle {...T} cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.4V12l3.1 1.9" />
    </>
  ),
  refresh: (
    <>
      <path d="M19.6 12a7.6 7.6 0 1 1-2.2-5.4" />
      <path d="M19.8 3.6v3.6h-3.6" />
    </>
  ),
  ban: (
    <>
      <circle {...T} cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="8.6" />
      <path d="M6 6.3 18 17.7" />
    </>
  ),
  dot: (
    <>
      <circle {...T} cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
    </>
  ),

  /* ---------- arrows ---------- */
  'chevron-left': <path d="M14.8 5.6 8.4 12l6.4 6.4" />,
  'chevron-right': <path d="m9.2 5.6 6.4 6.4-6.4 6.4" />,
  'chevron-down': <path d="m5.6 9.2 6.4 6.4 6.4-6.4" />,
  'arrow-right': <path d="M4.4 12h15.2m-6.4-6.4L19.6 12l-6.4 6.4" />,
  'arrow-up-right': <path d="M7 17 17 7M9.4 7H17v7.6" />,
  undo: (
    <>
      <path d="m8.8 13.6-4.6-4.6 4.6-4.6" />
      <path d="M4.2 9h10.2a5.6 5.6 0 0 1 5.6 5.6v5.6" />
    </>
  ),
  skip: (
    <>
      <path {...T} d="M5 6.6 11.5 12 5 17.4Z" />
      <path d="M5 6.6 11.5 12 5 17.4ZM12.5 6.6 19 12l-6.5 5.4Z" />
    </>
  ),
  play: (
    <>
      <path {...T} d="M7.4 5.4 18.6 12 7.4 18.6a.6.6 0 0 1-.9-.5V5.9a.6.6 0 0 1 .9-.5z" />
      <path d="M7.4 5.4 18.6 12 7.4 18.6a.6.6 0 0 1-.9-.5V5.9a.6.6 0 0 1 .9-.5z" />
    </>
  ),
  pause: (
    <>
      <rect {...T} x="6" y="5" width="4.4" height="14" rx="1.6" />
      <rect x="6" y="5" width="4.4" height="14" rx="1.6" />
      <rect x="13.6" y="5" width="4.4" height="14" rx="1.6" />
    </>
  ),

  /* ---------- commerce / gamification ---------- */
  sun: (
    <>
      <circle {...T} cx="12" cy="12" r="4.2" />
      <path {...T} d="M12 2.6v2.4M12 19v2.4M4.2 4.2l1.7 1.7M18.1 18.1l1.7 1.7M2.6 12h2.4M19 12h2.4M4.2 19.8l1.7-1.7M18.1 5.9l1.7-1.7" />
    </>
  ),
  moon: (
    <>
      <path {...T} d="M20.2 14.4A8.4 8.4 0 0 1 9.6 3.8a8.4 8.4 0 1 0 10.6 10.6Z" />
    </>
  ),
  bolt: (
    <>
      <path {...T} d="M13.2 2.8 5 13.4h5.4L10.8 21.2 19 10.6h-5.4Z" />
      <path d="M13.2 2.8 5 13.4h5.4L10.8 21.2 19 10.6h-5.4Z" />
    </>
  ),
  handshake: (
    <>
      <path {...T} d="m12 8.6 2.4-1.8a2.2 2.2 0 0 1 2.6 0l3.5 2.7-5 6.3-5.4-3.6Z" />
      <path d="M3.5 9.5 7 6.8a2.2 2.2 0 0 1 2.6 0L12 8.6l-2.6 2.3a1.8 1.8 0 0 0 2.3 2.7l2.2-1.6 3.6 3-2.3 2.7a2.2 2.2 0 0 1-3 .3l-6.3-4.6" />
      <path d="M20.5 9.5 17 6.8a2.2 2.2 0 0 0-2.6 0L12 8.6" />
    </>
  ),
  coins: (
    <>
      <circle {...T} cx="9" cy="10" r="5.8" />
      <circle cx="9" cy="10" r="5.8" />
      <path d="M17.2 8.8a5.8 5.8 0 1 1-6.4 9.4" />
      <path d="M9 7.6v4.8M6.8 10h4.4" />
    </>
  ),
  shield: (
    <>
      <path {...T} d="M12 3.2 5 5.8v5.4c0 4.4 2.9 7.6 7 9.6 4.1-2 7-5.2 7-9.6V5.8Z" />
      <path d="M12 3.2 5 5.8v5.4c0 4.4 2.9 7.6 7 9.6 4.1-2 7-5.2 7-9.6V5.8Z" />
      <path d="m9 11.8 2.2 2.2 3.8-4.2" />
    </>
  ),
  wallet: (
    <>
      <rect {...T} x="3.4" y="6.4" width="17.2" height="12.6" rx="2.4" />
      <rect x="3.4" y="6.4" width="17.2" height="12.6" rx="2.4" />
      <path d="M16.5 4.8H6a2.6 2.6 0 0 0-2.6 2.6" />
      <path d="M15.6 12.7h2.4" />
    </>
  ),
  trophy: (
    <>
      <path {...T} d="M8 4.4h8v6a4 4 0 0 1-8 0Z" />
      <path d="M8 4.4h8v6a4 4 0 0 1-8 0Z" />
      <path d="M8 6.2H5.2a0 0 0 0 0 0 0c0 2.6 1.2 4.2 2.9 4.6M16 6.2h2.8c0 2.6-1.2 4.2-2.9 4.6" />
      <path d="M12 14.4v3M8.8 20h6.4M10 17.4h4a1 1 0 0 1 1 1v1.6H9v-1.6a1 1 0 0 1 1-1z" />
    </>
  ),
  ticket: (
    <>
      <path {...T} d="M3.4 8.4a2 2 0 0 1 2-2h13.2a2 2 0 0 1 2 2v1.8a1.8 1.8 0 0 0 0 3.6v1.8a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2v-1.8a1.8 1.8 0 0 0 0-3.6Z" />
      <path d="M3.4 8.4a2 2 0 0 1 2-2h13.2a2 2 0 0 1 2 2v1.8a1.8 1.8 0 0 0 0 3.6v1.8a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2v-1.8a1.8 1.8 0 0 0 0-3.6Z" />
      <path d="M13.6 6.4v2M13.6 11v2M13.6 15.6v2" strokeDasharray="0.1 3" />
    </>
  ),
  gift: (
    <>
      <rect {...T} x="4.4" y="8" width="15.2" height="4" rx="1.2" />
      <path d="M5.4 12v6.4a2 2 0 0 0 2 2h9.2a2 2 0 0 0 2-2V12" />
      <rect x="4.4" y="8" width="15.2" height="4" rx="1.2" />
      <path d="M12 8v12.4M12 8s-.8-3.8-3.2-3.8a1.9 1.9 0 0 0 0 3.8M12 8s.8-3.8 3.2-3.8a1.9 1.9 0 0 1 0 3.8" />
    </>
  ),
  crown: (
    <>
      <path {...T} d="m4.4 8.2 3.6 3 4-5.4 4 5.4 3.6-3-1.2 9.2H5.6Z" />
      <path d="m4.4 8.2 3.6 3 4-5.4 4 5.4 3.6-3-1.2 9.2H5.6Z" />
      <path d="M5.8 20.2h12.4" />
    </>
  ),
  medal: (
    <>
      <path d="m8.6 3.6-2.4 6M15.4 3.6l2.4 6M9.8 3.6 12 9l2.2-5.4" />
      <circle {...T} cx="12" cy="14.6" r="5.6" />
      <circle cx="12" cy="14.6" r="5.6" />
      <path d="m12 12 .8 1.6 1.8.3-1.3 1.3.3 1.8-1.6-.9-1.6.9.3-1.8-1.3-1.3 1.8-.3z" fill="currentColor" stroke="none" opacity="0.5" />
    </>
  ),
  card: (
    <>
      <rect {...T} x="3.4" y="5.4" width="17.2" height="13.2" rx="2.4" />
      <rect x="3.4" y="5.4" width="17.2" height="13.2" rx="2.4" />
      <path d="M3.4 9.8h17.2M6.6 14.6h4" />
    </>
  ),
  mobile: (
    <>
      <rect {...T} x="7" y="3.2" width="10" height="17.6" rx="2.6" />
      <rect x="7" y="3.2" width="10" height="17.6" rx="2.6" />
      <path d="M11 17.6h2" />
    </>
  ),
  cash: (
    <>
      <rect {...T} x="3.2" y="6.4" width="17.6" height="11.2" rx="2.2" />
      <rect x="3.2" y="6.4" width="17.6" height="11.2" rx="2.2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6.4 9.6v.1M17.6 14.3v.1" />
    </>
  ),
  calendar: (
    <>
      <rect {...T} x="3.8" y="5.4" width="16.4" height="15" rx="2.4" />
      <rect x="3.8" y="5.4" width="16.4" height="15" rx="2.4" />
      <path d="M3.8 9.8h16.4M8.2 3.4v3.2M15.8 3.4v3.2" />
      <path d="M8 13.6h.1M12 13.6h.1M16 13.6h.1M8 16.8h.1M12 16.8h.1" />
    </>
  ),
  receipt: (
    <>
      <path {...T} d="M6 3.6h12v16.2l-2.4-1.5-2.4 1.5-1.2-.8-1.2.8-2.4-1.5L6 19.8Z" />
      <path d="M6 3.6h12v16.2l-2.4-1.5-2.4 1.5-1.2-.8-1.2.8-2.4-1.5L6 19.8Z" />
      <path d="M9 8.2h6M9 11.4h6M9 14.6h3.6" />
    </>
  ),
  repeat: (
    <>
      <path d="M4.4 9.6a5 5 0 0 1 5-5h10.2m0 0-3-3m3 3-3 3" />
      <path d="M19.6 14.4a5 5 0 0 1-5 5H4.4m0 0 3 3m-3-3 3-3" />
    </>
  ),
  flag: (
    <>
      <path {...T} d="M5.6 4.6c2-1.2 4-1.2 6.4 0s4.4 1.2 6.4 0v9.2c-2 1.2-4 1.2-6.4 0s-4.4-1.2-6.4 0Z" />
      <path d="M5.6 4.6c2-1.2 4-1.2 6.4 0s4.4 1.2 6.4 0v9.2c-2 1.2-4 1.2-6.4 0s-4.4-1.2-6.4 0" />
      <path d="M5.6 3.6v17" />
    </>
  ),
  scale: (
    <>
      <path {...T} d="M3.2 12.2a3.2 3.2 0 0 0 6.4 0l-3.2-6.4ZM14.4 12.2a3.2 3.2 0 0 0 6.4 0l-3.2-6.4Z" />
      <path d="M12 4v14.4M7.4 20.2h9.2M6.4 5.8 12 4.6l5.6 1.2" />
      <path d="M3.2 12.2a3.2 3.2 0 0 0 6.4 0l-3.2-6.4-3.2 6.4ZM14.4 12.2a3.2 3.2 0 0 0 6.4 0l-3.2-6.4-3.2 6.4Z" />
    </>
  ),
  pin: (
    <>
      <path {...T} d="M12 2.8a7 7 0 0 1 7 7c0 5-7 11.4-7 11.4S5 14.8 5 9.8a7 7 0 0 1 7-7z" />
      <path d="M12 2.8a7 7 0 0 1 7 7c0 5-7 11.4-7 11.4S5 14.8 5 9.8a7 7 0 0 1 7-7z" />
      <circle cx="12" cy="9.8" r="2.6" />
    </>
  ),
  chat: (
    <>
      <path {...T} d="M12 3.8a8.2 8.2 0 0 1 8.2 8.2c0 4.5-3.7 7.8-8.2 7.8-1 0-2-.1-2.9-.4L4.4 20.6l1.1-3.6A8.2 8.2 0 0 1 12 3.8z" />
      <path d="M12 3.8a8.2 8.2 0 0 1 8.2 8.2c0 4.5-3.7 7.8-8.2 7.8-1 0-2-.1-2.9-.4L4.4 20.6l1.1-3.6A8.2 8.2 0 0 1 12 3.8z" />
      <path d="M8.6 12h.1m3.3 0h.1m3.3 0h.1" />
    </>
  ),
  headset: (
    <>
      <path {...T} d="M4 13.6h3v5.6H5.6A1.6 1.6 0 0 1 4 17.6ZM17 13.6h3v4a1.6 1.6 0 0 1-1.6 1.6H17Z" />
      <path d="M4 15.4v-3a8 8 0 0 1 16 0v3" />
      <path d="M4 13.6h3v5.6H5.6A1.6 1.6 0 0 1 4 17.6ZM17 13.6h3v4a1.6 1.6 0 0 1-1.6 1.6H17Z" />
      <path d="M20 17.6v.8a2.6 2.6 0 0 1-2.6 2.6H13" />
    </>
  ),
  trash: (
    <>
      <path {...T} d="M6.2 7h11.6l-.9 12.2a1.8 1.8 0 0 1-1.8 1.6H8.9a1.8 1.8 0 0 1-1.8-1.6Z" />
      <path d="M4.4 7h15.2M6.2 7l.9 12.2a1.8 1.8 0 0 0 1.8 1.6h6.2a1.8 1.8 0 0 0 1.8-1.6L17.8 7M9.4 7V5a1.6 1.6 0 0 1 1.6-1.6h2A1.6 1.6 0 0 1 14.6 5v2" />
      <path d="M10 11v6M14 11v6" />
    </>
  ),
  sliders: (
    <>
      <path d="M5.8 4.4v5M5.8 14v5.6M12 4.4v2.4M12 11.4v8.2M18.2 4.4v7.8M18.2 16.8v2.8" />
      <circle {...T} cx="5.8" cy="11.6" r="2.2" />
      <circle cx="5.8" cy="11.6" r="2.2" />
      <circle {...T} cx="12" cy="9" r="2.2" />
      <circle cx="12" cy="9" r="2.2" />
      <circle {...T} cx="18.2" cy="14.6" r="2.2" />
      <circle cx="18.2" cy="14.6" r="2.2" />
    </>
  ),
  send: (
    <>
      <path {...T} d="M20.4 3.6 3.8 10l6 2.6 2.6 6Z" />
      <path d="M20.4 3.6 3.8 10l6 2.6 2.6 6ZM20.4 3.6 9.8 12.6" />
    </>
  ),
  mail: (
    <>
      <rect {...T} x="3.4" y="5.6" width="17.2" height="12.8" rx="2.4" />
      <rect x="3.4" y="5.6" width="17.2" height="12.8" rx="2.4" />
      <path d="m4.4 7.4 7.6 6 7.6-6" />
    </>
  ),
  scroll: (
    <>
      <path {...T} d="M7 3.8h11.4v13.4a3 3 0 0 1-3 3H7Z" />
      <path d="M18.4 3.8H7a2.4 2.4 0 0 0-2.4 2.4v.8h4.2" />
      <path d="M18.4 3.8v13.4a3 3 0 0 1-3 3H8.4a2.4 2.4 0 0 1-2.4-2.4V6.2" />
      <path d="M10.4 9h4.6M10.4 12.4h4.6" />
    </>
  ),
  puzzle: (
    <>
      <path {...T} d="M9.4 4.8a2 2 0 0 1 4 0v1h3.8a1.6 1.6 0 0 1 1.6 1.6v3.4h-1a2 2 0 0 0 0 4h1v3.4a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6v-3.8h1.4a2 2 0 0 0 0-4H3.8V7.4a1.6 1.6 0 0 1 1.6-1.6h4Z" />
      <path d="M9.4 5.8v-1a2 2 0 0 1 4 0v1h3.8a1.6 1.6 0 0 1 1.6 1.6v3.4h-1a2 2 0 0 0 0 4h1v3.4a1.6 1.6 0 0 1-1.6 1.6H5.4a1.6 1.6 0 0 1-1.6-1.6v-3.8h1.4a2 2 0 0 0 0-4H3.8V7.4a1.6 1.6 0 0 1 1.6-1.6Z" />
    </>
  ),
  sparkles: (
    <>
      <path {...T} d="M9.4 3.8 11 8.4l4.6 1.6-4.6 1.6L9.4 16l-1.6-4.4L3.2 10l4.6-1.6Z" />
      <path d="M9.4 3.8 11 8.4l4.6 1.6-4.6 1.6L9.4 16l-1.6-4.4L3.2 10l4.6-1.6Z" />
      <path d="m17.4 13.2.9 2.5 2.5.9-2.5.9-.9 2.5-.9-2.5-2.5-.9 2.5-.9Z" />
    </>
  ),
  target: (
    <>
      <circle {...T} cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="5" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  eye: (
    <>
      <path {...T} d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z" />
      <path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  flame: (
    <>
      <path {...T} d="M12 3.4s6.4 4.6 6.4 10.4a6.4 6.4 0 0 1-12.8 0c0-2.2 1-4.2 2.2-5.8 0 0 .6 2 2.2 2.6C9.6 8 10.4 5.4 12 3.4z" />
      <path d="M12 3.4s6.4 4.6 6.4 10.4a6.4 6.4 0 0 1-12.8 0c0-2.2 1-4.2 2.2-5.8 0 0 .6 2 2.2 2.6C9.6 8 10.4 5.4 12 3.4z" />
      <path d="M12 20.2a3.2 3.2 0 0 1-3.2-3.2c0-1.8 1.6-3.4 3.2-4.4 1.6 1 3.2 2.6 3.2 4.4a3.2 3.2 0 0 1-3.2 3.2z" />
    </>
  ),
  backpack: (
    <>
      <path {...T} d="M6 9.6a6 6 0 0 1 12 0v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z" />
      <path d="M6 9.6a6 6 0 0 1 12 0v9a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2Z" />
      <path d="M9.4 5V4a1.6 1.6 0 0 1 1.6-1.6h2A1.6 1.6 0 0 1 14.6 4v1M8.4 20.4v-5a1.6 1.6 0 0 1 1.6-1.6h4a1.6 1.6 0 0 1 1.6 1.6v5M8.4 17h7.2M9 9.4h6" />
    </>
  ),
  question: (
    <>
      <circle {...T} cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="8.6" />
      <path d="M9.4 9.6A2.7 2.7 0 0 1 12 7.6a2.6 2.6 0 0 1 2.6 2.6c0 1.8-2.6 2.1-2.6 3.8M12 17v.1" />
    </>
  ),
  chart: (
    <>
      <rect {...T} x="14.6" y="5" width="4.6" height="15" rx="1.4" />
      <rect x="4.8" y="12.6" width="4.6" height="7.4" rx="1.4" />
      <rect x="9.7" y="8.8" width="4.6" height="11.2" rx="1.4" />
      <rect x="14.6" y="5" width="4.6" height="15" rx="1.4" />
    </>
  ),

  /* ---------- logistics / people ---------- */
  truck: (
    <>
      <path {...T} d="M2.8 6.4h11.6v9.8H2.8Z" />
      <path d="M2.8 6.4h11.6v9.8H2.8ZM14.4 10h3.4l3.2 3.4v2.8h-6.6" />
      <circle cx="7" cy="17.6" r="1.9" />
      <circle cx="17" cy="17.6" r="1.9" />
    </>
  ),
  van: (
    <>
      <path {...T} d="M3 8.4a2 2 0 0 1 2-2h10.4c.9 0 1.8.4 2.4 1.1l2.6 3.1a2 2 0 0 1 .6 1.4v3.6a1.6 1.6 0 0 1-1.6 1.6H3.8a.8.8 0 0 1-.8-.8Z" />
      <path d="M3 8.4a2 2 0 0 1 2-2h10.4c.9 0 1.8.4 2.4 1.1l2.6 3.1a2 2 0 0 1 .6 1.4v3.6a1.6 1.6 0 0 1-1.6 1.6H3.8a.8.8 0 0 1-.8-.8Z" />
      <path d="M14.6 6.6V11H21M3 11h7.6" />
      <circle cx="7.2" cy="17.4" r="1.9" />
      <circle cx="16.6" cy="17.4" r="1.9" />
    </>
  ),
  hand: (
    <>
      <path {...T} d="M7.4 12V6.6a1.5 1.5 0 0 1 3 0V5.2a1.5 1.5 0 0 1 3 0v1.4a1.5 1.5 0 0 1 3 0V8a1.5 1.5 0 0 1 3 0v6.4a6.4 6.4 0 0 1-12.8 0v-2a1.7 1.7 0 0 1 3.4-.4z" />
      <path d="M10.4 6.6a1.5 1.5 0 0 1 3 0V11M10.4 11V6.6a1.5 1.5 0 0 0-3 0V12M13.4 6.6V5.2a1.5 1.5 0 0 1 3 0V11M16.4 8a1.5 1.5 0 0 1 3 0v6.4a6.4 6.4 0 0 1-12.8 0v-2a1.7 1.7 0 0 1 3.4-.4l.4.6" />
    </>
  ),
  driver: (
    <>
      <circle {...T} cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="8.6" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M3.6 10.8c2.4 1.4 4.2 1.4 6.2.4M20.4 10.8c-2.4 1.4-4.2 1.4-6.2.4M12 14.4v6" />
    </>
  ),
  wrench: (
    <>
      <path {...T} d="M20.2 6.6a5 5 0 0 1-6.8 6L7 19a2.1 2.1 0 0 1-3-3l6.4-6.4a5 5 0 0 1 6-6.8l-3 3 .4 3.4 3.4.4Z" />
      <path d="M20.2 6.6a5 5 0 0 1-6.8 6L7 19a2.1 2.1 0 0 1-3-3l6.4-6.4a5 5 0 0 1 6-6.8l-3 3 .4 3.4 3.4.4Z" />
    </>
  ),
  phone: (
    <>
      <path {...T} d="M8 3.6 5 4.4a2 2 0 0 0-1.4 2.2c.9 6.8 6.9 12.8 13.7 13.7a2 2 0 0 0 2.2-1.4l.8-3-4-2.4-1.8 1.8a12.9 12.9 0 0 1-5.8-5.8L10.4 7.6Z" />
      <path d="M8 3.6 5 4.4a2 2 0 0 0-1.4 2.2c.9 6.8 6.9 12.8 13.7 13.7a2 2 0 0 0 2.2-1.4l.8-3-4-2.4-1.8 1.8a12.9 12.9 0 0 1-5.8-5.8L10.4 7.6Z" />
    </>
  ),
  users: (
    <>
      <circle {...T} cx="9" cy="8.6" r="3.6" />
      <circle cx="9" cy="8.6" r="3.6" />
      <path d="M2.8 20a6.2 6.2 0 0 1 12.4 0" />
      <path d="M15.4 5.4a3.6 3.6 0 0 1 0 6.4M17.6 14.8a6.2 6.2 0 0 1 3.6 5.2" />
    </>
  ),
  store: (
    <>
      <path {...T} d="M4.4 10.6h15.2V19a1.6 1.6 0 0 1-1.6 1.6H6A1.6 1.6 0 0 1 4.4 19Z" />
      <path d="M4 7.2 5.4 3.8h13.2L20 7.2a2.7 2.7 0 0 1-2.7 3.2 2.8 2.8 0 0 1-2.6-1.7 2.8 2.8 0 0 1-5.3 0 2.8 2.8 0 0 1-2.6 1.7A2.7 2.7 0 0 1 4 7.2Z" />
      <path d="M4.4 10.4V19A1.6 1.6 0 0 0 6 20.6h12a1.6 1.6 0 0 0 1.6-1.6v-8.6M9.4 20.4v-4.6a1.2 1.2 0 0 1 1.2-1.2h2.8a1.2 1.2 0 0 1 1.2 1.2v4.6" />
    </>
  ),
  'flag-checkered': (
    <>
      <path d="M5.6 3.6v17M5.6 4.4c2-1 4-1 6.4.2s4.4 1.2 6.4.2v9.2c-2 1-4 1-6.4-.2s-4.4-1.2-6.4-.2" />
      <path fill="currentColor" stroke="none" opacity="0.5" d="M5.6 4.4c1-.5 2-.75 3.2-.7v3.2c-1.2-.05-2.2.2-3.2.7zM12 5.5c1 .5 2.1.8 3.2.85v3.2c-1.1-.05-2.2-.35-3.2-.85zM8.8 10.1c1.05 0 2.15.35 3.2.85v3.2c-1.05-.5-2.15-.85-3.2-.85zM15.2 12.75c1.1.05 2.2-.15 3.2-.65v3.2c-1 .5-2.1.7-3.2.65z" />
    </>
  ),

  /* ---------- departments / spaces ---------- */
  camera: (
    <>
      <rect {...T} x="2.8" y="9" width="13" height="10" rx="2.4" />
      <rect x="2.8" y="9" width="13" height="10" rx="2.4" />
      <path d="m15.8 12.6 4.2-2.2a.8.8 0 0 1 1.2.7v5.8a.8.8 0 0 1-1.2.7l-4.2-2.2" />
      <circle cx="7" cy="6" r="2.5" />
      <circle cx="12.5" cy="6" r="2.5" />
    </>
  ),
  'video-camera': (
    <>
      <rect {...T} x="3" y="6.6" width="12.4" height="10.8" rx="2.4" />
      <rect x="3" y="6.6" width="12.4" height="10.8" rx="2.4" />
      <path d="m15.4 10.4 4.4-2.6a.6.6 0 0 1 1 .5v7.4a.6.6 0 0 1-1 .5l-4.4-2.6" />
      <circle cx="9.2" cy="12" r="2.6" />
    </>
  ),
  film: (
    <>
      <rect {...T} x="3.4" y="4.4" width="17.2" height="15.2" rx="2.2" />
      <rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2.2" />
      <path d="M7.6 4.6v14.8M16.4 4.6v14.8M3.6 8.2h4M3.6 12h16.8M3.6 15.8h4M16.4 8.2h4M16.4 15.8h4" />
    </>
  ),
  lens: (
    <>
      {/* barrel behind */}
      <path {...T} d="M11.4 6.2h6a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-6z" />
      <path d="M11.6 6.2h5.8a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2h-5.8" />
      {/* knurled focus ring */}
      <path d="M14 6.4v11.2M16 6.4v11.2" opacity="0.55" />
      {/* front element — the part that has to read at a glance */}
      <circle {...T} cx="9.4" cy="12" r="6.6" />
      <circle cx="9.4" cy="12" r="6.6" />
      <circle cx="9.4" cy="12" r="3.8" opacity="0.85" />
      {/* iris blades */}
      <path d="M9.4 8.2 7.2 10.4M12.4 11 9.9 9.6M11.4 14.6l-1-2.7M7.1 14.2l2.6-.9" opacity="0.7" />
    </>
  ),
  bulb: (
    <>
      <path {...T} d="M12 3a6.4 6.4 0 0 1 3.8 11.5c-.7.6-1.2 1.4-1.2 2.3H9.4c0-.9-.5-1.7-1.2-2.3A6.4 6.4 0 0 1 12 3z" />
      <path d="M12 3a6.4 6.4 0 0 1 3.8 11.5c-.7.6-1.2 1.4-1.2 2.3H9.4c0-.9-.5-1.7-1.2-2.3A6.4 6.4 0 0 1 12 3z" />
      <path d="M9.8 19.8h4.4M10.6 22h2.8" />
    </>
  ),
  mic: (
    <>
      <rect {...T} x="9" y="2.8" width="6" height="11" rx="3" />
      <rect x="9" y="2.8" width="6" height="11" rx="3" />
      <path d="M5.6 11a6.4 6.4 0 0 0 12.8 0M12 17.4v3.2M8.8 20.6h6.4" />
    </>
  ),
  clapperboard: (
    <>
      <path {...T} d="M3.4 9h17.2v9.4a2.2 2.2 0 0 1-2.2 2.2H5.6a2.2 2.2 0 0 1-2.2-2.2Z" />
      <path d="M3.4 9h17.2v9.4a2.2 2.2 0 0 1-2.2 2.2H5.6a2.2 2.2 0 0 1-2.2-2.2Z" />
      <path d="m3.6 8.8 1-3.6a2 2 0 0 1 2.4-1.4L20 6.6l-.6 2.3M8.2 4.6l-1 3.3M13 5.8l-1 3.2M17.8 7l-1 3" />
    </>
  ),
  drone: (
    <>
      <rect {...T} x="9" y="9.6" width="6" height="5" rx="1.8" />
      <rect x="9" y="9.6" width="6" height="5" rx="1.8" />
      <path d="M9.4 10 6 6.6M14.6 10 18 6.6M9.4 14 6 17.4M14.6 14 18 17.4" />
      <path d="M2.8 6.6h6.4M14.8 6.6h6.4M2.8 17.4h6.4M14.8 17.4h6.4" />
    </>
  ),
  car: (
    <>
      <path {...T} d="M4 12.6 5.6 8a2.4 2.4 0 0 1 2.3-1.6h8.2A2.4 2.4 0 0 1 18.4 8l1.6 4.6v4.2a1.2 1.2 0 0 1-1.2 1.2h-1.2a1.2 1.2 0 0 1-1.2-1.2v-.8H7.6v.8a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 16.8Z" />
      <path d="M4 12.6 5.6 8a2.4 2.4 0 0 1 2.3-1.6h8.2A2.4 2.4 0 0 1 18.4 8l1.6 4.6v4.2a1.2 1.2 0 0 1-1.2 1.2h-1.2a1.2 1.2 0 0 1-1.2-1.2v-.8H7.6v.8a1.2 1.2 0 0 1-1.2 1.2H5.2A1.2 1.2 0 0 1 4 16.8Z" />
      <path d="M4 12.6h16M7 15.2h.1M17 15.2h.1" />
    </>
  ),
  building: (
    <>
      <rect {...T} x="5.4" y="3.6" width="13.2" height="16.8" rx="1.8" />
      <rect x="5.4" y="3.6" width="13.2" height="16.8" rx="1.8" />
      <path d="M9 7.4h.1M15 7.4h.1M9 11h.1M15 11h.1M9 14.6h.1M15 14.6h.1M10.6 20.2v-2.8a1.2 1.2 0 0 1 1.2-1.2h.4a1.2 1.2 0 0 1 1.2 1.2v2.8" />
    </>
  ),
  greenscreen: (
    <>
      <rect {...T} x="3.8" y="4.4" width="16.4" height="11" rx="1.8" />
      <rect x="3.8" y="4.4" width="16.4" height="11" rx="1.8" />
      <path d="M8 15.6 6 20.4M16 15.6l2 4.8M12 15.6v2.2" />
    </>
  ),
  skyline: (
    <>
      <path {...T} d="M3.6 20V9.4h5V20ZM8.6 20V5.4h6.8V20Z" />
      <path d="M3.6 20V9.4h5V5.4h6.8V12h4.4v8" />
      <path d="M2.6 20h18.8M6 12.6h.1M11 8.6h.1M11 12.6h.1M17.6 15.4h.1" />
    </>
  ),
  landmark: (
    <>
      <path {...T} d="m12 3.4 8.2 4.4v1.6H3.8V7.8Z" />
      <path d="m12 3.4 8.2 4.4v1.6H3.8V7.8ZM4.4 20.2h15.2M3.6 17.4h16.8v2.8H3.6z" />
      <path d="M6.6 9.6v7.6M11 9.6v7.6M13 9.6v7.6M17.4 9.6v7.6" />
    </>
  ),
  warehouse: (
    <>
      <path {...T} d="M3.6 20V8.8L12 4.4l8.4 4.4V20h-4.8v-7H8.4v7Z" />
      <path d="M3.6 20V8.8L12 4.4l8.4 4.4V20" />
      <path d="M8.4 20v-7h7.2v7M8.4 16h7.2M2.8 20h18.4" />
    </>
  ),
  sofa: (
    <>
      <path {...T} d="M4.6 10.8V8.4A2.4 2.4 0 0 1 7 6h10a2.4 2.4 0 0 1 2.4 2.4v2.4a2.5 2.5 0 0 0-1.6 2.3v1.3H6.2v-1.3a2.5 2.5 0 0 0-1.6-2.3z" />
      <path d="M4.6 10.9V8.4A2.4 2.4 0 0 1 7 6h10a2.4 2.4 0 0 1 2.4 2.4v2.5" />
      <path d="M6.2 14.4v-1.3a2.4 2.4 0 1 0-3.2 2.3v1.4A1.8 1.8 0 0 0 4.8 18.6h14.4a1.8 1.8 0 0 0 1.8-1.8v-1.4a2.4 2.4 0 1 0-3.2-2.3v1.3ZM6.2 14.4h11.6M5 18.8v1.6M19 18.8v1.6" />
    </>
  ),
  armchair: (
    <>
      <path {...T} d="M6.4 10.4V7.6A2.6 2.6 0 0 1 9 5h6a2.6 2.6 0 0 1 2.6 2.6v2.8a2.6 2.6 0 0 0-1.8 2.5v1H8.2v-1a2.6 2.6 0 0 0-1.8-2.5z" />
      <path d="M6.4 10.5V7.6A2.6 2.6 0 0 1 9 5h6a2.6 2.6 0 0 1 2.6 2.6v2.9" />
      <path d="M8.2 13.9a2.5 2.5 0 1 0-3.4 2.4v1.5A1.7 1.7 0 0 0 6.5 19.5h11a1.7 1.7 0 0 0 1.7-1.7v-1.5a2.5 2.5 0 1 0-3.4-2.4v1H8.2ZM8.2 14.9h7.6M6.6 19.7V21M17.4 19.7V21" />
    </>
  ),
  coffee: (
    <>
      <path {...T} d="M4.4 9.4h12v6.2a4.4 4.4 0 0 1-4.4 4.4H8.8a4.4 4.4 0 0 1-4.4-4.4Z" />
      <path d="M4.4 9.4h12v6.2a4.4 4.4 0 0 1-4.4 4.4H8.8a4.4 4.4 0 0 1-4.4-4.4Z" />
      <path d="M16.4 11h1.2a2.6 2.6 0 0 1 0 5.2h-1.4M7.6 3.4c-.4 1.2.8 1.6.4 2.8M10.6 3.4c-.4 1.2.8 1.6.4 2.8M13.6 3.4c-.4 1.2.8 1.6.4 2.8" />
    </>
  ),
  tree: (
    <>
      <path {...T} d="M12 3.2c3.4 0 6.2 2.6 6.2 5.9 0 .8-.2 1.5-.4 2.2a5.5 5.5 0 0 1-2.7 7.3 6.3 6.3 0 0 1-6.2 0 5.5 5.5 0 0 1-2.7-7.3c-.3-.7-.4-1.4-.4-2.2 0-3.3 2.8-5.9 6.2-5.9z" />
      <path d="M12 3.2c3.4 0 6.2 2.6 6.2 5.9 0 .8-.2 1.5-.4 2.2a5.5 5.5 0 0 1-2.7 7.3 6.3 6.3 0 0 1-6.2 0 5.5 5.5 0 0 1-2.7-7.3c-.3-.7-.4-1.4-.4-2.2 0-3.3 2.8-5.9 6.2-5.9z" />
      <path d="M12 10.4v10.4M12 13.4l2.6-2M12 15.4l-2.6-2" />
    </>
  ),
  briefcase: (
    <>
      <rect {...T} x="3.4" y="7.4" width="17.2" height="12" rx="2.2" />
      <rect x="3.4" y="7.4" width="17.2" height="12" rx="2.2" />
      <path d="M9 7.2V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.2M3.6 12.2c2.7 1.3 5.5 2 8.4 2s5.7-.7 8.4-2M12 13.4v1.8" />
    </>
  ),
}

/* One rough-edged filter shared by every icon, so the whole set reads as
   hand-sketched rather than vector-perfect. Rendered once, referenced by all. */
export function IconSketchFilter() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <filter id="icon-sketch" x="-8%" y="-8%" width="116%" height="116%">
        <feTurbulence type="fractalNoise" baseFrequency="0.055" numOctaves="2" seed="5" result="n" />
        <feDisplacementMap in="SourceGraphic" in2="n" scale="1" />
      </filter>
    </svg>
  )
}

export function Icon({
  name,
  size = 20,
  className,
  strokeWidth = 1.8,
  title,
}: {
  name: IconName | string // string tolerated so stale persisted data can never crash
  size?: number
  className?: string
  strokeWidth?: number
  title?: string
}) {
  const glyph = ICON_PATHS[name as IconName] ?? ICON_PATHS.box
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      filter="url(#icon-sketch)"
    >
      {title ? <title>{title}</title> : null}
      {glyph}
    </svg>
  )
}

/* ---------------- monogram avatar (replaces emoji owner avatars) ---------------- */
export function Avatar({ name, id, size = 46 }: { name: string; id: string; size?: number }) {
  const hue = [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7)
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  return (
    <span
      className="avatar"
      style={{ width: size, height: size, fontSize: size * 0.34, ['--av-h' as string]: hue }}
      aria-hidden="true"
    >
      {id === 'support' ? <Icon name="headset" size={size * 0.48} /> : initials}
    </span>
  )
}

/* ---------------- brand mark (topbar logo) ---------------- */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="2.5" y="8" width="15" height="12.5" rx="3.4" fill="var(--accent)" />
      <path
        d="m17.5 12 3.2-1.8a.9.9 0 0 1 1.3.8v6.5a.9.9 0 0 1-1.3.8l-3.2-1.8"
        fill="var(--accent)"
      />
      <circle cx="6.8" cy="4.9" r="2.6" fill="none" stroke="var(--accent)" strokeWidth="1.9" />
      <circle cx="12.6" cy="4.9" r="2.6" fill="none" stroke="var(--accent)" strokeWidth="1.9" />
      <path d="m7.6 14.5 3.6 2-3.6 2z" fill="#fff" />
    </svg>
  )
}
