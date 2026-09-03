import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import type { PullListView } from '@papa/core'
import { progressSummary } from '@papa/core'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import type { ScanMode } from '../nav.ts'
import { scanRowClass, scanRowChanged, type ScanRow } from '../scan-row.ts'
import { STR } from '../strings.ts'

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
 *   session list       newest at TOP, no re-sort, no layout shift. Each row is
 *                      memoised, so a scan re-renders ONE row, not all of them.
 *                      NOT yet virtualised — see the note on ScanRowItem.
 *   hold to finish     64px, 500ms hold
 */

export type { ScanRow }

/**
 * One row of the session list.
 *
 * Memoised, because the list this lives in re-renders on EVERY scan and a
 * tech does 300 in a morning. Without this, scan 300 reconciles 300 rows and
 * their nested spans — inside the sub-100ms window the whole scan loop is
 * built around. A duplicate makes it worse: it re-renders the list once to
 * start the pulse and again 400ms later to clear it.
 *
 * The comparison lives in scan-row.ts so it can be tested. A memo whose
 * comparison is wrong silently stops the screen updating, and the tech reads
 * that as "the scanner missed one".
 *
 * STILL NOT VIRTUALISED. Memoising means we render 300 cheap no-ops instead of
 * 300 real reconciliations, which is enough for a morning's work. Windowing to
 * the visible ~40 is the next step if a real session ever gets long enough to
 * feel it — measure before building it.
 */
const ScanRowItem = memo(function ScanRowItem({
  row,
  isPulsing,
  onResolve,
  onBind,
  onPhoto,
  photoCount,
}: {
  row: ScanRow
  isPulsing: boolean
  onResolve: (key: string, action: 'add' | 'not-this-job') => void
  onBind: (tagCode: string) => void
  onPhoto: (assetId: string, name: string) => void
  photoCount: number
}) {
  return (
    <li data-asset={row.assetId ?? ''} className={scanRowClass(row.outcome, isPulsing)}>
      <span className="row-main">
        <span className="row-name">{row.displayName ?? STR.commonUnknownItem}</span>
        {row.message ? <span className="row-note">{row.message}</span> : null}
      </span>
      <span className="row-code code">{row.assetCode ?? '—'}</span>

      {/* The camera on the row, never in the scan path. Photographing is a
          separate act on the one item that looked wrong — a tech doing 300
          scans who has to dismiss a prompt 300 times stops scanning by
          Thursday. */}
      {row.assetId ? (
        <button
          className={`row-photo${photoCount > 0 ? ' has-photo' : ''}`}
          onClick={() => onPhoto(row.assetId as string, row.displayName ?? STR.scanThisItem)}
          aria-label={STR.scanPhotographAria(row.displayName ?? STR.scanThisItem)}
        >
          <Icon name="camera" size={18} />
          {photoCount > 0 ? <span className="row-photo-n code">{photoCount}</span> : null}
        </button>
      ) : null}

      {/* Two inline actions, ON the row, NEITHER REQUIRED. Nothing in the scan
          loop is a modal or a blocking toast: the line does not stop. An
          unresolved row can sit here all morning and get dealt with once, at
          the finish. */}
      {row.outcome === 'unexpected' ? (
        <span className="row-actions">
          <button className="btn btn-sm" onClick={() => onResolve(row.key, 'add')}>
            {STR.scanAddAnyway}
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => onResolve(row.key, 'not-this-job')}>
            {STR.scanNotThisJob}
          </button>
        </span>
      ) : null}

      {/* A fresh label off the printer. Offering to attach it HERE is what
          makes tagging a rack possible at all — the alternative is a desk
          chore later that nobody does, and a sheet of stickers on nothing. */}
      {row.outcome === 'unknown_tag' && row.tagCode ? (
        <span className="row-actions">
          <button className="btn btn-sm" onClick={() => onBind(row.tagCode as string)}>
            {STR.scanAttachThisLabel}
          </button>
        </span>
      ) : null}
    </li>
  )
}, (prev, next) => !scanRowChanged(prev, next) && prev.photoCount === next.photoCount)

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
  onBind,
  onPhoto,
  photoCounts,
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
  /** Attach a freshly printed label to an item. */
  onBind: (tagCode: string) => void
  /** Open the camera for one item's condition photo. */
  onPhoto: (assetId: string, name: string) => void
  /** How many condition photos each asset already has this session. */
  photoCounts: Record<string, number>
  /** Human age of the pull list, e.g. "04:12". Null when live. */
  snapshotAge: string | null
  /** The camera preview, injected so this component stays testable. */
  cameraSlot: React.ReactNode
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const [pulseKey, setPulseKey] = useState<string | null>(null)

  // A permanently stable callback, whatever the parent does with its own.
  // Passing onResolveRow straight through would defeat the row memo the moment
  // a caller rebuilds it each render — which is the default way anyone writes
  // it. Holding it in a ref means the memo cannot be broken from outside.
  const resolveRef = useRef(onResolveRow)
  resolveRef.current = onResolveRow
  const handleResolve = useCallback(
    (key: string, action: 'add' | 'not-this-job') => resolveRef.current(key, action),
    [],
  )

  // Held in a ref for the same reason as onResolveRow: a caller that rebuilds
  // this callback each render would defeat the row memo, and the memo is what
  // keeps scan 300 from reconciling 300 rows inside the sub-100ms budget.
  const bindRef = useRef(onBind)
  bindRef.current = onBind
  const handleBind = useCallback((tagCode: string) => bindRef.current(tagCode), [])

  const photoRef = useRef(onPhoto)
  photoRef.current = onPhoto
  const handlePhoto = useCallback(
    (assetId: string, name: string) => photoRef.current(assetId, name),
    [],
  )

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
        <span className="scan-mode">{mode === 'out' ? STR.scanGoingOut : STR.scanComingBack}</span>
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
          aria-label={torchOn ? STR.scanTorchOffAria : STR.scanTorchOnAria}
        >
          <Icon name="bulb" size={24} />
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
            <Icon name="signal-off" size={13} /> {STR.scanListAsOf(snapshotAge)}
          </p>
        ) : null}
      </div>

      <ul className="scan-list" ref={listRef}>
        {rows.map((row) => (
          <ScanRowItem
            key={row.key}
            row={row}
            isPulsing={pulseKey !== null && row.assetId === pulseKey}
            onResolve={handleResolve}
            onBind={handleBind}
            onPhoto={handlePhoto}
            photoCount={row.assetId ? (photoCounts[row.assetId] ?? 0) : 0}
          />
        ))}
      </ul>

      <div className="scan-foot">
        {/* The manual path is a PEER of the camera, not a buried fallback.
            Its absence is the single biggest abandonment trigger in the
            research: a tag under gaffer tape at 06:05 with no way forward
            teaches a tech on day one that the app has no answer for the real
            world. */}
        <button className="btn btn-ghost manual-btn" onClick={onManualAdd}>
          <Icon name="tag-off" size={18} /> {STR.scanCantScanIt}
        </button>

        <HoldToFinish
          label={remaining > 0 ? STR.scanHoldToFinishLeft(remaining) : STR.scanHoldToFinish}
          onFinish={onFinish}
        />
      </div>
    </div>
  )
}
