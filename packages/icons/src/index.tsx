import type { ReactNode } from 'react'
import { ICON_PATHS, type IconName as CoreIconName } from '@papa/design'
import { VENDOR_ICON_PATHS, type VendorIconName } from './vendor-glyphs'

export { STAR_PATH, ICON_PATHS, IconSketchFilter, Avatar, LogoMark } from '@papa/design'
export type { IconName as CoreIconName } from '@papa/design'
export { VENDOR_ICON_PATHS } from './vendor-glyphs'
export type { VendorIconName } from './vendor-glyphs'

/** Every glyph available to Papa Vendor: the shared set plus vendor additions. */
export type AnyIconName = CoreIconName | VendorIconName

export const ALL_ICON_PATHS: Record<AnyIconName, ReactNode> = {
  ...ICON_PATHS,
  ...VENDOR_ICON_PATHS,
}

/**
 * The icon renderer.
 *
 * Deliberately identical in behaviour to the sibling's `Icon` — same 24×24
 * viewBox, same 1.8 stroke, same sketch filter, same fallback — so a glyph
 * looks the same in both products. The only difference is that it resolves
 * against the merged map.
 *
 * `name` accepts a bare string so stale persisted data can never crash a
 * screen; an unknown name falls back to `box`. That matters more here than in
 * the marketplace, because icon names arrive from a local database that may
 * have been written by an older build of the app.
 *
 * `IconSketchFilter` must be mounted once at the app root or every glyph
 * silently renders unfiltered — which looks fine in isolation and wrong beside
 * one that is filtered.
 */
export function Icon({
  name,
  size = 20,
  className,
  strokeWidth = 1.8,
  title,
}: {
  name: AnyIconName | string
  size?: number
  className?: string
  strokeWidth?: number
  title?: string
}) {
  const glyph = ALL_ICON_PATHS[name as AnyIconName] ?? ALL_ICON_PATHS.box

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
