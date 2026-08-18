import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FEEDBACK, type ScanResult } from '@papa/core'
import { Scan } from '../routes/Scan.tsx'
import { QrCamera } from '../camera/QrCamera.tsx'
import { ManualAdd } from './ManualAdd.tsx'
import { PhotoCapture, type CapturedPhoto } from '../camera/PhotoCapture.tsx'
import { go, type ScanMode } from '../nav.ts'
import type { ScanRow } from '../scan-row.ts'
import type { DemoStore } from './store.ts'

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
  const [rows, setRows] = useState<ScanRow[]>([])
  const [torchOn, setTorchOn] = useState(false)
  const [manualOpen, setManualOpen] = useState(false)
  const [photoFor, setPhotoFor] = useState<{ assetId: string; name: string } | null>(null)
  const [bindingTag, setBindingTag] = useState<string | null>(null)
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
      record(session.scan(tagCode, eventType), tagCode)
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
          ? { ...r, outcome: action === 'add' ? 'accepted' : r.outcome, message: action === 'add' ? 'Added to this job' : 'Left off this job' }
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
        setBlocked(
          `Device full — ${result.waiting} photo${result.waiting === 1 ? '' : 's'} still waiting to send. ` +
            'Nothing has been deleted. Get this phone online, then try again.',
        )
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

  const onFinish = useCallback(() => {
    go({ name: 'session', sessionId: jobId })
  }, [jobId])

  useEffect(() => {
    document.title = job ? `${job.label} — Papa Vendor` : 'Papa Vendor'
  }, [job])

  return (
    <>
      <Scan
        jobLabel={job?.label ?? 'Loose scan'}
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
            paused={manualOpen || photoFor !== null}
          />
        }
      />
      {blocked ? (
        <div className="blocker" role="alert">
          <p>{blocked}</p>
          <button className="btn btn-ghost btn-sm" onClick={() => setBlocked(null)}>
            Got it
          </button>
        </div>
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
          title={bindingTag ? 'What is this label on?' : 'Can’t scan it'}
          onPick={onManualPick}
          onClose={() => { setManualOpen(false); setBindingTag(null) }}
        />
      ) : null}
    </>
  )
}
