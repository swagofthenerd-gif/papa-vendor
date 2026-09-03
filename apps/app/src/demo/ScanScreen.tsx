import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import { FEEDBACK, SameTagDebounce, type ScanResult } from '@papa/core'
import { Scan } from '../routes/Scan.tsx'
import { QrCamera } from '../camera/QrCamera.tsx'
import { ManualAdd } from './ManualAdd.tsx'
import { PhotoCapture, type CapturedPhoto } from '../camera/PhotoCapture.tsx'
import { CaseManifestSheet } from './CaseManifest.tsx'
import { go, type ScanMode } from '../nav.ts'
import { scanRowClass, type ScanRow } from '../scan-row.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * How long the same tag is ignored after it decodes.
 *
 * The camera sees a sticker roughly sixty times a second, so without this one
 * held-up label becomes sixty rows. It is NOT the session dedupe — that lives
 * in ScanSession and lasts the whole session on purpose. This is only about
 * the camera staring at the same thing, so it is short enough that a
 * deliberate rescan a couple of seconds later still gets its double-tick,
 * which is the feedback that tells the tech the scanner is alive.
 */
const SAME_TAG_QUIET_MS = 1_500

export function ScanScreen({
  store,
  jobId,
  mode,
}: {
  store: DemoStore
  jobId: string
  mode: ScanMode
}) {
  // The asking mode is its own loop entirely — no session, no writes. The
  // branch sits above the hooks, which is safe because App keys this
  // component by (job, mode): an instance can never change mode mid-life.
  if (mode === 'lookup') return <LookupScreen store={store} />
  return <SessionScanScreen store={store} jobId={jobId} mode={mode} />
}

function SessionScanScreen({
  store,
  jobId,
  mode,
}: {
  store: DemoStore
  jobId: string
  mode: 'out' | 'in'
}) {
  const [rows, setRows] = useState<ScanRow[]>([])
  const [torchOn, setTorchOn] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [photoFor, setPhotoFor] = useState<{ assetId: string; name: string } | null>(null)
  const [bindingTag, setBindingTag] = useState<string | null>(null)
  const [openCase, setOpenCase] = useState<string | null>(null)
  const [photoCounts, setPhotoCounts] = useState<Record<string, number>>({})
  const [blocked, setBlocked] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const lastSeen = useRef(new Map<string, number>())

  const job = store.job(jobId)
  const session = store.sessionFor(jobId, mode)
  const eventType = mode === 'out' ? 'check_out' : 'check_in'

  const pullList = useMemo(() => store.pullList(jobId, mode), [store, jobId, mode, tick])

  const record = useCallback(
    (result: ScanResult, tagCode?: string) => {
      setRows((prev) => [
        {
          ...result,
          key: result.outboxId ?? `${result.outcome}-${Date.now()}`,
          at: Date.now(),
          tagCode,
        },
        ...prev,
      ])
      setTick((t) => t + 1)

      // Haptics from the shared vocabulary, so the demo teaches the same
      // rhythms the real scanner will. A phone with no vibration motor simply
      // ignores this.
      const spec = FEEDBACK[result.outcome]
      if (spec && typeof navigator.vibrate === 'function') navigator.vibrate(spec.haptic)
    },
    [],
  )

  const onDecode = useCallback(
    (tagCode: string) => {
      const now = Date.now()
      const last = lastSeen.current.get(tagCode)
      if (last !== undefined && now - last < SAME_TAG_QUIET_MS) return
      lastSeen.current.set(tagCode, now)
      const result = session.scan(tagCode, eventType)
      record(result, tagCode)

      // A case opens its manifest. The case itself is already recorded by the
      // scan above; nothing inside it is, and nothing inside it will be until
      // a person acts on this sheet.
      if (result.assetId && store.manifestFor(result.assetId)) setOpenCase(result.assetId)
    },
    [session, eventType, record],
  )

  const onManualPick = useCallback(
    (assetId: string) => {
      // One sheet, two jobs. Opened from "can't scan it" it adds the item;
      // opened from an unknown label it attaches that label instead.
      if (bindingTag) {
        const result = session.bindTag(bindingTag, assetId)
        record(result)
        setBindingTag(null)
        setTick((t) => t + 1)
        return
      }
      record(session.addManually(assetId, eventType))
      setManualOpen(false)
    },
    [session, eventType, record, bindingTag],
  )

  const onResolveRow = useCallback((key: string, action: 'add' | 'not-this-job') => {
    // Neither action is required and neither blocks the line, so both simply
    // annotate the row. In the real product 'add' amends the job's expected
    // set; there is no server here to amend it on.
    setRows((prev) =>
      prev.map((r) =>
        r.key === key
          ? { ...r, outcome: action === 'add' ? 'accepted' : r.outcome, message: action === 'add' ? STR.scanAddedToThisJob : STR.scanLeftOffThisJob }
          : r,
      ),
    )
  }, [])

  // Finishing opens the handover summary rather than dropping the tech back on
  // the board. The session stays open behind it: "keep scanning" has to be one
  // tap, because a case turning up late is the normal case, not the exception.
  const onPhotoTaken = useCallback(
    (shot: CapturedPhoto) => {
      const target = photoFor
      if (!target) return
      const result = store.capturePhoto({
        assetId: target.assetId,
        side: mode === 'out' ? 'out' : 'in',
        dataUri: shot.dataUri,
        bytes: shot.bytes,
        sha256: shot.sha256,
      })

      if (!result.ok) {
        // Refused, not failed. Nothing was deleted to make room, and the
        // message says what to do about it rather than just that it broke.
        setBlocked(STR.scanDeviceFull(result.waiting))
        setPhotoFor(null)
        return
      }

      setPhotoCounts((prev) => ({
        ...prev,
        [target.assetId]: (prev[target.assetId] ?? 0) + 1,
      }))
      setPhotoFor(null)
    },
    [photoFor, store, mode],
  )

  const onConfirmCase = useCallback(
    (assetIds: string[]) => {
      for (const r of session.confirmContents(assetIds, eventType)) record(r)
      setOpenCase(null)
    },
    [session, eventType, record],
  )

  const onFinish = useCallback(() => {
    go({ name: 'session', sessionId: jobId })
  }, [jobId])

  useEffect(() => {
    document.title = job ? STR.scanDocTitle(job.label) : STR.commonAppName
  }, [job])

  return (
    <>
      <Scan
        jobLabel={job?.label ?? STR.scanLooseScan}
        mode={mode}
        rows={rows}
        pullList={pullList}
        torchOn={torchOn}
        onToggleTorch={() => setTorchOn((t) => !t)}
        onFinish={onFinish}
        onManualAdd={() => setManualOpen(true)}
        onBind={(tagCode) => { setBindingTag(tagCode); setManualOpen(true) }}
        onResolveRow={onResolveRow}
        onPhoto={(assetId, name) => setPhotoFor({ assetId, name })}
        photoCounts={photoCounts}
        snapshotAge={null}
        cameraSlot={
          <QrCamera
            torchOn={torchOn}
            onDecode={onDecode}
            // Default the lamp on in a dark room where the platform allows it;
            // the header toggle still turns it back off.
            onAutoTorch={() => setTorchOn(true)}
            paused={manualOpen || photoFor !== null || openCase !== null}
          />
        }
      />
      {blocked ? (
        <div className="blocker" role="alert">
          <p>{blocked}</p>
          <button className="btn btn-ghost btn-sm" onClick={() => setBlocked(null)}>
            {STR.scanGotIt}
          </button>
        </div>
      ) : null}
      {openCase ? (
        (() => {
          const manifest = store.manifestFor(openCase)
          if (!manifest) return null
          return (
            <CaseManifestSheet
              manifest={manifest}
              alreadyRecorded={new Set(session.scannedIds)}
              onConfirmAll={onConfirmCase}
              onScanIndividually={() => setOpenCase(null)}
              onClose={() => setOpenCase(null)}
            />
          )
        })()
      ) : null}
      {photoFor ? (
        <PhotoCapture
          itemName={photoFor.name}
          side={mode === 'out' ? 'out' : 'in'}
          onCaptured={onPhotoTaken}
          onClose={() => setPhotoFor(null)}
        />
      ) : null}
      {manualOpen ? (
        <ManualAdd
          store={store}
          title={bindingTag ? STR.scanWhatIsThisLabelOn : STR.scanCantScanIt}
          onPick={onManualPick}
          onClose={() => { setManualOpen(false); setBindingTag(null) }}
        />
      ) : null}
    </>
  )
}

/**
 * Lookup — "where is this thing?".
 *
 * A separate loop from the job scanner ON PURPOSE. A lookup asserts nothing
 * about the physical world, so it must never open a session, enqueue an op,
 * or move the projection. The previous version routed "Just scan" through a
 * real check-in session — scanning an item to ASK where it was quietly marked
 * it RETURNED, which is the worst possible answer to an innocent question.
 *
 * The loop keeps the scanner's feel: decode → local read → answer, one
 * gesture, nothing awaited. A known label goes straight to the item's page;
 * everything else gets a row that names the outcome and says that nothing was
 * recorded. There is no "attach this label" here — binding is a write, and it
 * belongs in a session where the tech has already said which job they are on.
 */
function LookupScreen({ store }: { store: DemoStore }) {
  const [rows, setRows] = useState<ScanRow[]>([])
  const [torchOn, setTorchOn] = useState(false)
  const debounce = useRef(new SameTagDebounce())

  const onDecode = useCallback(
    (tagCode: string) => {
      if (!debounce.current.accept(tagCode)) return
      const found = store.lookup(tagCode)

      if (found.kind === 'found') {
        // The answer IS the asset page — one gesture from label to "on Job
        // 482 since 3 Apr", with the scan recorded nowhere.
        if (typeof navigator.vibrate === 'function') navigator.vibrate(FEEDBACK.accepted.haptic)
        go({ name: 'asset', assetId: found.assetId })
        return
      }

      // Every miss says "nothing recorded" out loud. This screen's one
      // promise is that it only looks, and a promise like that has to be
      // restated at exactly the moments it might be doubted.
      const result: ScanResult =
        found.kind === 'retired'
          ? {
              outcome: 'retired_tag',
              message: found.status === 'lost'
                ? STR.scanLabelReportedLost
                : STR.scanLabelRetired,
            }
          : {
              outcome: 'unknown_tag',
              message: found.kind === 'unknown_item'
                ? STR.scanNotOnThisPhoneYet
                : STR.scanUnknownLabel,
            }

      setRows((prev) => [
        { ...result, key: `${tagCode}-${Date.now()}`, at: Date.now() },
        ...prev,
      ])
      const spec = FEEDBACK[result.outcome]
      if (spec && typeof navigator.vibrate === 'function') navigator.vibrate(spec.haptic)
    },
    [store],
  )

  useEffect(() => {
    document.title = STR.scanLookupDocTitle
  }, [])

  return (
    <div className="screen scan-screen">
      <header className="scan-head">
        <span className="scan-job">{STR.todayWhereIsThisThing}</span>
        <span className="scan-mode">{STR.scanOnlyLooking}</span>
      </header>

      <div className="camera-frame">
        <QrCamera
          torchOn={torchOn}
          onDecode={onDecode}
          onAutoTorch={() => setTorchOn(true)}
          paused={false}
        />
        <button
          className={`torch-btn${torchOn ? ' is-on' : ''}`}
          onClick={() => setTorchOn((t) => !t)}
          aria-pressed={torchOn}
          aria-label={torchOn ? STR.scanTorchOffAria : STR.scanTorchOnAria}
        >
          <Icon name="bulb" size={24} />
        </button>
      </div>

      <ul className="scan-list">
        {rows.map((row) => (
          <li key={row.key} className={scanRowClass(row.outcome, false)}>
            <span className="row-main">
              <span className="row-name">{row.displayName ?? STR.commonUnknownItem}</span>
              {row.message ? <span className="row-note">{row.message}</span> : null}
            </span>
            <span className="row-code code">{row.assetCode ?? '—'}</span>
          </li>
        ))}
      </ul>

      <div className="scan-foot">
        {/* A plain tap is fine here — leaving loses nothing, because nothing
            was ever going to be written. */}
        <button className="btn btn-ghost manual-btn" onClick={() => go({ name: 'jobs' })}>
          <Icon name="chevron-left" size={18} /> {STR.commonBackToToday}
        </button>
      </div>
    </div>
  )
}
