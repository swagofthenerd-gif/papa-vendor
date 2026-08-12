import { useEffect, useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import type { ScanResult } from '@papa/core'
import type { PullListView } from '@papa/core'
import { progressSummary } from '@papa/core'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import type { ScanMode } from '../nav.ts'

/**
 * The scan screen. The product is this screen.
 *
 * NOT A FULL-SCREEN VIEWFINDER. That maximises the one thing the tech is not
 * looking at and destroys all context. The camera gets roughly a third of the
 * height — enough to aim a QR at 20cm — and the rest goes to what they
 * actually need: how far through they are, where the remaining items live, and
 * what just happened.
 *
 * Layout, top to bottom:
 *   job name           44px, so they know what they are scanning against
 *   camera             ~38%, 2px accent frame, no chrome over it
 *   progress + shelves count in --ff-code at 32px; remaining GROUPED BY SHELF
 *   session list       newest at TOP, virtualised, no re-sort, no layout shift
 *   hold to finish     64px, 500ms hold
 */

export interface ScanRow extends ScanResult {
  key: string
  at: number
}

export function Scan({
  jobLabel,
  mode,
  rows,
  pullList,
  torchOn,
  onToggleTorch,
  onFinish,
  onManualAdd,
  onResolveRow,
  snapshotAge,
  cameraSlot,
}: {
  jobLabel: string
  mode: ScanMode
  rows: ScanRow[]
  pullList: PullListView | null
  torchOn: boolean
  onToggleTorch: () => void
  onFinish: () => void
  onManualAdd: () => void
  onResolveRow: (key: string, action: 'add' | 'not-this-job') => void
  /** Human age of the pull list, e.g. "04:12". Null when live. */
  snapshotAge: string | null
  /** The camera preview, injected so this component stays testable. */
  cameraSlot: React.ReactNode
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const [pulseKey, setPulseKey] = useState<string | null>(null)

  // A duplicate scrolls the existing row into view and pulses it. Silence
  // would be indistinguishable from "the camera didn't see it", which is
  // exactly how a tech decides the scanner is broken.
  const newest = rows[0]
  useEffect(() => {
    if (newest?.outcome !== 'duplicate' || !newest.assetId) return
    const el = listRef.current?.querySelector<HTMLElement>(`[data-asset="${newest.assetId}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    setPulseKey(newest.assetId)
    const t = setTimeout(() => setPulseKey(null), 400)
    return () => clearTimeout(t)
  }, [newest])

  const counted = pullList?.scanned ?? rows.filter((r) => r.outcome === 'accepted').length
  const total = pullList?.total ?? 0
  const remaining = total > 0 ? total - counted : 0

  return (
    <div className="screen scan-screen">
      <header className="scan-head">
        <span className="scan-job">{jobLabel}</span>
        <span className="scan-mode">{mode === 'out' ? 'Going out' : 'Coming back'}</span>
      </header>

      <div className="camera-frame">
        {cameraSlot}
        {/* The torch is a persistent, thumb-reachable control, not a settings
            item. A Lahore warehouse before dawn is dark and the decoder needs
            light; burying this behind a menu means it never gets used. */}
        <button
          className={`torch-btn${torchOn ? ' is-on' : ''}`}
          onClick={onToggleTorch}
          aria-pressed={torchOn}
          aria-label={torchOn ? 'Turn torch off' : 'Turn torch on'}
        >
          <Icon name="torch" size={24} />
        </button>
      </div>

      <div className="scan-progress">
        <div className="progress-row">
          <div className="progress-bar" aria-hidden="true">
            <span
              className="progress-fill"
              style={{ ['--p' as string]: total > 0 ? counted / total : 0 }}
            />
          </div>
          <span className="progress-count code">
            {total > 0 ? `${counted}/${total}` : counted}
          </span>
        </div>

        {/* Remaining work named by PLACE. "Six left" is not actionable;
            "Rack B 6 left" is somewhere to walk to, and it means the tech
            crosses the warehouse once instead of ping-ponging. */}
        {pullList ? <p className="shelf-line">{progressSummary(pullList)}</p> : null}

        {/* Staleness is never hidden. A pull list that quietly went out of
            date is how gear gets left on a shelf. */}
        {snapshotAge ? (
          <p className="snapshot-age">
            <Icon name="signal-off" size={13} /> List as of {snapshotAge} · not refreshed
          </p>
        ) : null}
      </div>

      <ul className="scan-list" ref={listRef}>
        {rows.map((row) => (
          <li
            key={row.key}
            data-asset={row.assetId ?? ''}
            className={[
              'scan-row',
              `is-${row.outcome}`,
              pulseKey && row.assetId === pulseKey ? 'is-pulsing' : '',
            ].filter(Boolean).join(' ')}
          >
            <span className="row-main">
              <span className="row-name">{row.displayName ?? 'Unknown item'}</span>
              {row.message ? <span className="row-note">{row.message}</span> : null}
            </span>
            <span className="row-code code">{row.assetCode ?? '—'}</span>

            {/* Two inline actions, ON the row, NEITHER REQUIRED. Nothing in
                the scan loop is a modal or a blocking toast: the line does not
                stop. An unresolved row can sit here all morning and get dealt
                with once, at the finish. */}
            {row.outcome === 'unexpected' ? (
              <span className="row-actions">
                <button className="btn btn-sm" onClick={() => onResolveRow(row.key, 'add')}>
                  Add anyway
                </button>
                <button
                  className="btn btn-sm btn-ghost"
                  onClick={() => onResolveRow(row.key, 'not-this-job')}
                >
                  Not this job
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="scan-foot">
        {/* The manual path is a PEER of the camera, not a buried fallback.
            Its absence is the single biggest abandonment trigger in the
            research: a tag under gaffer tape at 06:05 with no way forward
            teaches a tech on day one that the app has no answer for the real
            world. */}
        <button className="btn btn-ghost manual-btn" onClick={onManualAdd}>
          <Icon name="tag-off" size={18} /> Can’t scan it
        </button>

        <HoldToFinish
          label={remaining > 0 ? `Hold to finish · ${remaining} left` : 'Hold to finish'}
          onFinish={onFinish}
        />
      </div>
    </div>
  )
}
