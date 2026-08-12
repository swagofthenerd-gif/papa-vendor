import { GLYPH, LABEL, toBucket, type AssetStatus } from '../status.ts'

/**
 * Asset status, as one glanceable mark.
 *
 * SOLID FILL + REDUNDANT GLYPH, never a tint.
 *   - A tint sits at ~1.1:1 against the card. The marketplace's own CSS admits
 *     this and patches it with a currentColor border. In sunlight a tinted
 *     badge is a rumour.
 *   - ~8% of men have red-green CVD, and green/red are the canonical
 *     confusion pair. The glyph makes the encoding survive greyscale,
 *     sunlight and colour blindness — three failure modes, one character.
 */
export function StatusBadge({
  status,
  showLabel = false,
}: {
  status: AssetStatus
  showLabel?: boolean
}) {
  const bucket = toBucket(status)
  return (
    <span
      className={`status status-${bucket}`}
      // The glyph carries the meaning for a screen reader too; the fill is
      // decoration as far as assistive tech is concerned.
      role="img"
      aria-label={LABEL[bucket]}
      title={LABEL[bucket]}
    >
      <span aria-hidden="true" className="status-glyph">{GLYPH[bucket]}</span>
      {showLabel ? <span className="status-text">{LABEL[bucket]}</span> : null}
    </span>
  )
}
