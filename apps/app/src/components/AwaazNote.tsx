import { useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import { STR } from '../strings.ts'

/**
 * The awaaz note — hold-to-record spoken evidence (0021; Phase D5).
 *
 * Bykea's lesson: typing is the barrier. The tech at the dock will not
 * thumb a paragraph about a scratch, but they will hold a button and say
 * it. Hold-to-record, not tap-to-toggle: a toggle left on records a
 * warehouse's afternoon; a hold ends when the thumb lifts, which is the
 * physical gesture a walkie-talkie already taught everyone.
 *
 * DEGRADES SILENTLY. Where MediaRecorder or getUserMedia is missing the
 * component renders NOTHING — a disabled mystery button teaches a tech the
 * app is broken; absence teaches nothing. The refusal states are honest and
 * inline: mic permission refused, and the photo-model "device full" with
 * the waiting count — nothing is ever deleted to make room.
 */

export interface AwaazRecording {
  dataUri: string
  bytes: number
  durationMs: number
  mime: string | null
}

export type AwaazSaveResult = { ok: true } | { ok: false; waiting: number }

/** Whether this browser can record at all — the silent-degrade gate. */
export function awaazSupported(): boolean {
  return (
    typeof MediaRecorder !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getUserMedia === 'function'
  )
}

export function AwaazNote(props: {
  /** What the note is about — the aria target ('FX9-01', a job label). */
  targetLabel: string
  /** Row-sized (the discrepancy list) instead of block-sized (the page). */
  compact?: boolean
  onSave: (rec: AwaazRecording) => AwaazSaveResult
}) {
  // The gate is stable for the life of the page, so the inner component's
  // hooks are unconditional wherever it renders at all.
  if (!awaazSupported()) return null
  return <Recorder {...props} />
}

type Phase = 'idle' | 'recording' | 'saved' | 'full' | 'refused'

function Recorder({
  targetLabel,
  compact,
  onSave,
}: {
  targetLabel: string
  compact?: boolean
  onSave: (rec: AwaazRecording) => AwaazSaveResult
}) {
  const [phase, setPhase] = useState<Phase>('idle')
  const [waiting, setWaiting] = useState(0)
  const held = useRef(false)
  const recorder = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const startedAt = useRef(0)

  const begin = async () => {
    held.current = true
    if (recorder.current) return
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    } catch {
      held.current = false
      setPhase('refused')
      return
    }
    // The thumb may already have lifted while permission was being asked —
    // a recorder nobody is holding must not start.
    if (!held.current) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    const rec = new MediaRecorder(stream)
    chunks.current = []
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data)
    }
    rec.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      recorder.current = null
      const blob = new Blob(chunks.current, { type: rec.mimeType || 'audio/webm' })
      const durationMs = Date.now() - startedAt.current
      if (blob.size === 0) {
        setPhase('idle')
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const r = onSave({
          dataUri: String(reader.result),
          bytes: blob.size,
          durationMs,
          mime: rec.mimeType || null,
        })
        if (r.ok) {
          setPhase('saved')
        } else {
          setWaiting(r.waiting)
          setPhase('full')
        }
      }
      reader.readAsDataURL(blob)
    }
    recorder.current = rec
    startedAt.current = Date.now()
    rec.start()
    setPhase('recording')
  }

  const end = () => {
    held.current = false
    const rec = recorder.current
    if (rec && rec.state !== 'inactive') rec.stop()
  }

  return (
    <div className={compact ? 'awaaz awaaz-compact' : 'awaaz'}>
      <button
        className={compact ? 'btn btn-sm btn-outline' : 'btn btn-outline btn-block'}
        aria-label={STR.awaazHoldAria(targetLabel)}
        onPointerDown={(e) => {
          e.preventDefault()
          void begin()
        }}
        onPointerUp={end}
        onPointerLeave={end}
        onPointerCancel={end}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Icon name={phase === 'recording' ? 'siren' : 'send'} size={compact ? 14 : 18} />{' '}
        {phase === 'recording' ? STR.awaazRecording : STR.awaazNote}
      </button>
      {phase === 'saved' ? <p className="awaaz-status">{STR.awaazSaved}</p> : null}
      {phase === 'refused' ? <p className="awaaz-status">{STR.awaazMicRefused}</p> : null}
      {phase === 'full' ? (
        <p className="awaaz-status">{STR.awaazDeviceFull(waiting)}</p>
      ) : null}
    </div>
  )
}
