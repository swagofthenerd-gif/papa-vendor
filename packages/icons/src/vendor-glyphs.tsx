import type { ReactNode } from 'react'

/*
 * Papa Vendor glyphs — warehouse and rental-operations icons.
 *
 * Same grammar as the shared set in ./core.tsx, and it must stay that way or
 * the two read as different products:
 *   - 24×24 grid, ~1.5px inset margin, corner radii >= 2, simple geometry
 *   - line work inherits stroke=currentColor and round caps/joins from <svg>
 *   - duotone: the FIRST path is the soft tint layer (T), on the key mass only
 *   - single colour throughout, so `color:` on any wrapper themes the glyph
 *
 * These live in a separate file from core.tsx so the parity test can compare
 * the shared set against papa-rentals mechanically without vendor additions
 * showing up as drift.
 */

/** The duotone tint layer. Identical to core.tsx's `T`, duplicated here rather
 *  than exported across files so each glyph file reads standalone. */
const T = { fill: 'currentColor', opacity: 0.15, stroke: 'none' } as const

export type VendorIconName =
  | 'scan' | 'qr' | 'barcode' | 'tag' | 'tag-off'
  | 'case' | 'shelf' | 'forklift' | 'pallet'
  | 'clipboard' | 'clipboard-check'
  | 'torch' | 'battery' | 'battery-low'
  | 'signal-off' | 'cloud-queue'

export const VENDOR_ICON_PATHS: Record<VendorIconName, ReactNode> = {
  /* ---------- scanning ---------- */

  /** Viewfinder corners with a sweep line — the app's primary verb. */
  scan: (
    <>
      <rect {...T} x="4.2" y="4.2" width="15.6" height="15.6" rx="3" />
      <path d="M4.2 9V7.2a3 3 0 0 1 3-3H9" />
      <path d="M15 4.2h1.8a3 3 0 0 1 3 3V9" />
      <path d="M19.8 15v1.8a3 3 0 0 1-3 3H15" />
      <path d="M9 19.8H7.2a3 3 0 0 1-3-3V15" />
      <path d="M6.6 12h10.8" />
    </>
  ),

  /** A QR label as an object, distinct from `scan` (the action). */
  qr: (
    <>
      <rect {...T} x="4.3" y="4.3" width="6.4" height="6.4" rx="1.6" />
      <rect x="4.3" y="4.3" width="6.4" height="6.4" rx="1.6" />
      <rect x="13.3" y="4.3" width="6.4" height="6.4" rx="1.6" />
      <rect x="4.3" y="13.3" width="6.4" height="6.4" rx="1.6" />
      <path d="M13.3 13.3h2.6v2.6h-2.6z" />
      <path d="M17.1 17.1h2.6v2.6" />
      <path d="M13.3 19.7h1.2" />
    </>
  ),

  barcode: (
    <>
      <rect {...T} x="3.2" y="5.4" width="17.6" height="13.2" rx="2.4" />
      <path d="M6.4 8.6v6.8M9.2 8.6v6.8M12 8.6v6.8M15.4 8.6v6.8M17.8 8.6v6.8" />
    </>
  ),

  /** Asset tag — the physical label bound to one unit. */
  tag: (
    <>
      <path {...T} d="M11.2 3.9H19a1.2 1.2 0 0 1 1.2 1.2v7.8a1.6 1.6 0 0 1-.5 1.1l-6.1 6.1a1.6 1.6 0 0 1-2.3 0l-6.5-6.5a1.6 1.6 0 0 1 0-2.3l6.1-6.1a1.6 1.6 0 0 1 1.3-.3Z" />
      <path d="M11.2 3.9H19a1.2 1.2 0 0 1 1.2 1.2v7.8a1.6 1.6 0 0 1-.5 1.1l-6.1 6.1a1.6 1.6 0 0 1-2.3 0l-6.5-6.5a1.6 1.6 0 0 1 0-2.3l6.1-6.1a1.6 1.6 0 0 1 1.3-.3Z" />
      <circle cx="16.1" cy="7.9" r="1.4" />
    </>
  ),

  /** A dead or unreadable label — gaffer tape, road rash, a peeled sticker.
   *  Needs its own glyph because "this tag cannot be scanned" is a routine,
   *  first-class outcome on the dock, not an error state. */
  'tag-off': (
    <>
      <path {...T} d="M11.2 3.9H19a1.2 1.2 0 0 1 1.2 1.2v7.8a1.6 1.6 0 0 1-.5 1.1l-2 2-10-10 2-2a1.6 1.6 0 0 1 1.5-.1Z" />
      <path d="M11.2 3.9H19a1.2 1.2 0 0 1 1.2 1.2v7.8a1.6 1.6 0 0 1-.5 1.1l-6.1 6.1a1.6 1.6 0 0 1-2.3 0l-6.5-6.5a1.6 1.6 0 0 1 0-2.3" />
      <path d="M3.6 3.6l16.8 16.8" />
    </>
  ),

  /* ---------- the warehouse ---------- */

  /** A road case with latches — the unit a tech actually carries. */
  case: (
    <>
      <rect {...T} x="3.4" y="6.6" width="17.2" height="11.4" rx="2.2" />
      <rect x="3.4" y="6.6" width="17.2" height="11.4" rx="2.2" />
      <path d="M3.4 11.2h17.2" />
      <path d="M9.4 6.6V5.2a1 1 0 0 1 1-1h3.2a1 1 0 0 1 1 1v1.4" />
      <path d="M10.4 14.2h3.2" />
    </>
  ),

  /** Racking. Pull lists are ordered by shelf so the tech walks the floor once. */
  shelf: (
    <>
      <rect {...T} x="3.6" y="4.4" width="16.8" height="15.2" rx="2.2" />
      <rect x="3.6" y="4.4" width="16.8" height="15.2" rx="2.2" />
      <path d="M3.6 9.5h16.8M3.6 14.6h16.8" />
      <path d="M7.4 6.6v1.6M7.4 11.7v1.6M7.4 16.8v1.6" />
    </>
  ),

  forklift: (
    <>
      <path {...T} d="M3.6 15.4V9.2a1.4 1.4 0 0 1 1.4-1.4h4.8v7.6Z" />
      <path d="M3.6 15.4V9.2a1.4 1.4 0 0 1 1.4-1.4h4.8v7.6" />
      <circle cx="6.4" cy="18.2" r="1.9" />
      <circle cx="13.4" cy="18.2" r="1.9" />
      <path d="M9.8 15.4h1.7" />
      <path d="M15.8 4.6v11.8" />
      <path d="M15.8 16.4h4.6" />
    </>
  ),

  pallet: (
    <>
      <path {...T} d="M3.4 13.4h17.2v4.2H3.4z" />
      <path d="M3.4 13.4h17.2v4.2H3.4z" />
      <path d="M8.4 13.4v4.2M15.6 13.4v4.2" />
      <path d="M6.2 9.2h11.6v4.2H6.2z" />
    </>
  ),

  /* ---------- process ---------- */

  clipboard: (
    <>
      <path {...T} d="M6.4 5.4h11.2a1.4 1.4 0 0 1 1.4 1.4v12.4a1.4 1.4 0 0 1-1.4 1.4H6.4A1.4 1.4 0 0 1 5 19.2V6.8a1.4 1.4 0 0 1 1.4-1.4Z" />
      <path d="M6.4 5.4h11.2a1.4 1.4 0 0 1 1.4 1.4v12.4a1.4 1.4 0 0 1-1.4 1.4H6.4A1.4 1.4 0 0 1 5 19.2V6.8a1.4 1.4 0 0 1 1.4-1.4Z" />
      <rect x="9" y="3.2" width="6" height="3.6" rx="1.2" />
      <path d="M8.6 11.4h6.8M8.6 15h4.8" />
    </>
  ),

  /** A completed pull or return session — the thing that unlocks the gate pass. */
  'clipboard-check': (
    <>
      <path {...T} d="M6.4 5.4h11.2a1.4 1.4 0 0 1 1.4 1.4v12.4a1.4 1.4 0 0 1-1.4 1.4H6.4A1.4 1.4 0 0 1 5 19.2V6.8a1.4 1.4 0 0 1 1.4-1.4Z" />
      <path d="M6.4 5.4h11.2a1.4 1.4 0 0 1 1.4 1.4v12.4a1.4 1.4 0 0 1-1.4 1.4H6.4A1.4 1.4 0 0 1 5 19.2V6.8a1.4 1.4 0 0 1 1.4-1.4Z" />
      <rect x="9" y="3.2" width="6" height="3.6" rx="1.2" />
      <path d="m8.8 13.6 2.3 2.3 4.1-4.5" />
    </>
  ),

  /* ---------- device state ---------- */

  /** Torch. A Lahore warehouse before dawn is dark and the decoder needs light,
   *  so this is a persistent control on the scan screen, not a settings item. */
  torch: (
    <>
      <path {...T} d="M9 9.4h6v9.4a1.4 1.4 0 0 1-1.4 1.4h-3.2A1.4 1.4 0 0 1 9 18.8Z" />
      <path d="M9 9.4h6v9.4a1.4 1.4 0 0 1-1.4 1.4h-3.2A1.4 1.4 0 0 1 9 18.8Z" />
      <path d="M8.2 5.2h7.6l-.8 4.2H9Z" />
      <path d="M12 12.6v2.4" />
    </>
  ),

  battery: (
    <>
      <rect {...T} x="3.2" y="8" width="14.6" height="8" rx="2" />
      <rect x="3.2" y="8" width="14.6" height="8" rx="2" />
      <path d="M20.4 10.6v2.8" />
      <path d="M6 10.6v2.8M9 10.6v2.8M12 10.6v2.8" />
    </>
  ),

  /** Battery health is a silent killer: a cell that reads full and dies in
   *  twenty minutes destroys a shoot day. Cycle count drives the warning. */
  'battery-low': (
    <>
      <rect {...T} x="3.2" y="8" width="14.6" height="8" rx="2" />
      <rect x="3.2" y="8" width="14.6" height="8" rx="2" />
      <path d="M20.4 10.6v2.8" />
      <path d="M6 10.6v2.8" />
      <path d="M13.8 10.4v3.2" />
      <path d="M13.8 15.4v.1" />
    </>
  ),

  /** Offline is NORMAL here, not an error. The strip that uses this glyph is
   *  neutral until the queue ages — see the pending-state UI rules. */
  'signal-off': (
    <>
      <path {...T} d="M4.4 19.6h3.2v-4.2H4.4z" />
      <path d="M4.4 19.6h3.2v-4.2H4.4z" />
      <path d="M9.8 19.6h3.2v-7.4H9.8z" />
      <path d="M15.2 19.6h3.2v-4" />
      <path d="M3.6 3.6l16.8 16.8" />
    </>
  ),

  /** Writes waiting to send. Say "waiting to send", never "saved" — the
   *  difference is whether a person understands the model. */
  'cloud-queue': (
    <>
      <path {...T} d="M7.4 17.4a3.9 3.9 0 0 1-.4-7.8 5 5 0 0 1 9.6-1.1 3.9 3.9 0 0 1 .6 7.7Z" />
      <path d="M7.4 17.4a3.9 3.9 0 0 1-.4-7.8 5 5 0 0 1 9.6-1.1 3.9 3.9 0 0 1 .6 7.7" />
      <path d="M9.4 20.4h.1M12 20.4h.1M14.6 20.4h.1" />
    </>
  ),
}
