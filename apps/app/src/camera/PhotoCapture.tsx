import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import { STR } from '../strings.ts'

/**
 * Taking one condition photo.
 *
 * A SHEET OVER THE SCAN SCREEN, NEVER A STEP INSIDE IT. The scan loop may not
 * grow a photo step: a tech doing 300 scans in a morning who has to dismiss
 * something 300 times stops scanning by Thursday, and that is how these
 * systems die. Photographing is a deliberate, separate act — reached from a
 * row, taken once, on the item that looked wrong.
 *
 * Downscaled to 1600px WebP, roughly 150KB. Big enough to show a scratch on a
 * matte box, small enough that a morning's photos are not a data bill.
 */

const MAX_EDGE = 1600
const QUALITY = 0.82

export interface CapturedPhoto {
  dataUri: string
  bytes: number
  sha256: string
}

async function sha256Of(bytes: Uint8Array): Promise<string> {
  // The DEVICE's hash, and it is not evidence. The server must hash the bytes
  // again on receipt and keep its own answer — a hash computed by the phone
  // that also chose the bytes proves only that the phone is self-consistent.
  const buf = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function PhotoCapture({
  itemName,
  side,
  onCaptured,
  onClose,
}: {
  itemName: string
  side: 'out' | 'in'
  onCaptured: (photo: CapturedPhoto) => void
  onClose: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const [state, setState] = useState<'starting' | 'live' | 'error'>('starting')
  const [detail, setDetail] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let stopped = false
    async function start() {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setState('error')
        setDetail(STR.scanPhotoSecurePage)
        return
      }
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 } },
          audio: false,
        })
        if (stopped) { stream.getTracks().forEach((t) => t.stop()); return }
        trackRef.current = stream.getVideoTracks()[0] ?? null
        const v = videoRef.current
        if (!v) return
        v.srcObject = stream
        await v.play().catch(() => {})
        setState('live')
      } catch (err) {
        setState('error')
        setDetail(err instanceof Error ? err.message : String(err))
      }
    }
    void start()
    return () => {
      stopped = true
      trackRef.current?.stop()
      trackRef.current = null
    }
  }, [])

  const take = useCallback(async () => {
    const v = videoRef.current
    if (!v || busy) return
    setBusy(true)
    try {
      const scale = Math.min(1, MAX_EDGE / Math.max(v.videoWidth, v.videoHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(v.videoWidth * scale)
      canvas.height = Math.round(v.videoHeight * scale)
      canvas.getContext('2d')?.drawImage(v, 0, 0, canvas.width, canvas.height)

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', QUALITY),
      )
      if (!blob) throw new Error(STR.scanPhotoNotEncoded)

      const bytes = new Uint8Array(await blob.arrayBuffer())
      const dataUri = await new Promise<string>((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => resolve(String(fr.result))
        fr.onerror = () => reject(new Error(STR.scanPhotoNotReadBack))
        fr.readAsDataURL(blob)
      })

      onCaptured({ dataUri, bytes: bytes.byteLength, sha256: await sha256Of(bytes) })
    } catch (err) {
      setState('error')
      setDetail(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [busy, onCaptured])

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.scanPhotographAria(itemName)}>
      <div className="photo-sheet">
        <header className="sheet-head">
          <div>
            <span className="sheet-title">{itemName}</span>
            <p className="photo-side">
              {side === 'out' ? STR.scanHowItLooksGoingOut : STR.scanHowItCameBack}
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>

        <div className="photo-view">
          <video ref={videoRef} playsInline muted autoPlay className="qr-video" />
          {state !== 'live' ? (
            <div className="qr-camera-msg">
              <p>{state === 'starting' ? STR.scanStartingCamera : detail}</p>
            </div>
          ) : null}
        </div>

        <button
          className="btn btn-primary btn-block btn-lg"
          onClick={() => void take()}
          disabled={state !== 'live' || busy}
        >
          <Icon name="camera" size={20} /> {busy ? STR.scanSaving : STR.scanTakeThePhoto}
        </button>
        <p className="photo-foot muted">{STR.scanTimedByThisPhone}</p>
      </div>
    </div>
  )
}
