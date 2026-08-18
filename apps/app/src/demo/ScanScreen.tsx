import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { FEEDBACK, type ScanResult } from '@papa/core'
import { Scan } from '../routes/Scan.tsx'
import { QrCamera } from '../camera/QrCamera.tsx'
import { ManualAdd } from './ManualAdd.tsx'
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
  const [tick, setTick] = useState(0)
  const lastSeen = useRef(new Map<string, number>())

  const job = store.job(jobId)
  const session = store.sessionFor(jobId)
  const eventType = mode === 'out' ? 'check_out' : 'check_in'

  const pullList = useMemo(() => store.pullList(jobId), [store, jobId, tick])

  const record = useCallback(
    (result: ScanResult) => {
      setRows((prev) => [
        { ...result, key: result.outboxId ?? `${result.outcome}-${Date.now()}`, at: Date.now() },
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
      record(session.scan(tagCode, eventType))
    },
    [session, eventType, record],
  )

  const onManualPick = useCallback(
    (assetId: string) => {
      record(session.addManually(assetId, eventType))
      setManualOpen(false)
    },
    [session, eventType, record],
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

  const onFinish = useCallback(() => {
    store.endSession()
    go({ name: 'jobs' })
  }, [store])

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
        onResolveRow={onResolveRow}
        snapshotAge={null}
        cameraSlot={<QrCamera torchOn={torchOn} onDecode={onDecode} paused={manualOpen} />}
      />
      {manualOpen ? (
        <ManualAdd
          store={store}
          onPick={onManualPick}
          onClose={() => setManualOpen(false)}
        />
      ) : null}
    </>
  )
}
