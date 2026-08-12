import { Icon } from '@papa/icons'
import { syncStatus } from '@papa/core'

/**
 * The one global sync affordance.
 *
 * ABSENT when online and idle — not green. A permanent "all good" indicator is
 * noise people stop seeing within a week, and then it cannot warn them.
 *
 * Escalates by AGE, not by state. Being offline is NORMAL here and the strip
 * must not act like the app is broken. But 400 writes queued for three days is
 * not normal, it is a broken device, and a calm neutral strip actively hides
 * that from the one person who could fix it.
 */
export function SyncStrip({
  online, pending, oldestAgeMs, failures, onOpenFailures,
}: {
  online: boolean
  pending: number
  oldestAgeMs: number
  failures: number
  onOpenFailures: () => void
}) {
  const { tone, text } = syncStatus(online, pending, oldestAgeMs, failures)
  if (tone === 'hidden') return null

  const actionable = tone === 'attention'
  const Tag = actionable ? 'button' : 'div'

  return (
    <Tag
      className={`sync-strip sync-${tone}`}
      onClick={actionable ? onOpenFailures : undefined}
      // Announced politely: it must never interrupt a scan being read out.
      role="status"
      aria-live="polite"
    >
      <Icon name={online ? 'cloud-queue' : 'signal-off'} size={14} />
      <span>{text}</span>
    </Tag>
  )
}
