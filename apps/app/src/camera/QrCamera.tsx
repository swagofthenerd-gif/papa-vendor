import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'

/**
 * The camera preview and QR decoder.
 *
 * Prefers the browser's built-in BarcodeDetector, which on Android Chrome is
 * the same native decoder ML Kit wraps — so on the target device the demo's
 * decode speed is close to what the real scanner will feel.
 *
 * FALLS BACK TO jsQR, because BarcodeDetector DOES NOT EXIST in Chrome on
 * Linux or Windows desktop — it ships on Android, ChromeOS and macOS only.
 * Without the fallback the demo shows a live picture and decodes nothing on
 * the very machine it is being demonstrated from, which is indistinguishable
 * from every tag being broken. jsQR is slower and that is the honest trade:
 * it is the desk fallback, not the number the scan budget is measured against.
 *
 * NOTHING HERE AWAITS ON BEHALF OF A SCAN. The decode loop calls `onDecode`
 * synchronously; the scan handler downstream never waits on this component.
 */

interface DetectedBarcode {
  rawValue: string
}

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

type BarcodeDetectorCtor = new (opts?: { formats?: string[] }) => BarcodeDetectorLike

function detectorCtor(): BarcodeDetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
  return w.BarcodeDetector ?? null
}

export type CameraState = 'starting' | 'live' | 'denied' | 'insecure' | 'error'

export function QrCamera({
  torchOn,
  onDecode,
  paused = false,
}: {
  torchOn: boolean
  /** Called with the decoded text. Fires repeatedly; dedupe downstream. */
  onDecode: (value: string) => void
  paused?: boolean
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<MediaStreamTrack | null>(null)
  const [state, setState] = useState<CameraState>('starting')
  const [detail, setDetail] = useState<string>('')
  const [native, setNative] = useState(true)

  // Held in a ref so changing the handler never restarts the camera. A restart
  // costs ~400ms of black screen, and the scan screen rebuilds this callback
  // on every scan.
  const decodeRef = useRef(onDecode)
  decodeRef.current = onDecode
  const pausedRef = useRef(paused)
  pausedRef.current = paused

  useEffect(() => {
    let stopped = false
    let raf = 0

    async function start() {
      // getUserMedia only exists on a secure page. Over plain http on a phone
      // it is simply absent, which reads as "camera broken" unless we say so.
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setState('insecure')
        return
      }

      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        })
      } catch (err) {
        const name = err instanceof Error ? err.name : ''
        setState(name === 'NotAllowedError' ? 'denied' : 'error')
        setDetail(err instanceof Error ? err.message : String(err))
        return
      }

      if (stopped) { stream.getTracks().forEach((t) => t.stop()); return }

      trackRef.current = stream.getVideoTracks()[0] ?? null
      const video = videoRef.current
      if (!video) return
      video.srcObject = stream
      await video.play().catch(() => {})
      setState('live')

      // Native where it exists, jsQR everywhere else.
      const Ctor = detectorCtor()
      const detector = Ctor ? new Ctor({ formats: ['qr_code'] }) : null
      setNative(detector !== null)

      const canvas = document.createElement('canvas')
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      let busy = false

      const tick = () => {
        if (stopped) return
        raf = requestAnimationFrame(tick)
        if (busy || pausedRef.current) return
        if (!ctx || video.videoWidth === 0) return
        busy = true
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)

        if (!detector) {
          const frame = ctx.getImageData(0, 0, canvas.width, canvas.height)
          const found = jsQR(frame.data, frame.width, frame.height, {
            inversionAttempts: 'dontInvert',
          })
          if (found?.data) decodeRef.current(found.data)
          busy = false
          return
        }

        detector
          .detect(canvas)
          .then((codes) => {
            for (const c of codes) if (c.rawValue) decodeRef.current(c.rawValue)
          })
          .catch(() => {})
          .finally(() => { busy = false })
      }
      raf = requestAnimationFrame(tick)
    }

    void start()
    return () => {
      stopped = true
      cancelAnimationFrame(raf)
      trackRef.current?.stop()
      trackRef.current = null
    }
  }, [])

  // The torch is a capability of the track, not of the page. Most laptops have
  // no lamp, so a failure here is expected and must stay silent rather than
  // throwing into the scan screen.
  useEffect(() => {
    const track = trackRef.current
    if (!track) return
    const constraints = { advanced: [{ torch: torchOn }] } as unknown as MediaTrackConstraints
    void track.applyConstraints(constraints).catch(() => {})
  }, [torchOn, state])

  return (
    <div className="qr-camera">
      <video ref={videoRef} playsInline muted autoPlay className="qr-video" />
      {/* Named, not hidden. The desk decoder is slower than the phone's, and
          a tech comparing the two must know which one they are holding. */}
      {state === 'live' && !native ? (
        <span className="qr-decoder-note">Desk decoder</span>
      ) : null}
      {state !== 'live' ? (
        <div className="qr-camera-msg">
          {state === 'starting' ? <p>Starting camera…</p> : null}
          {state === 'insecure' ? (
            <p>
              The camera needs a secure page. Open this on <strong>localhost</strong>,
              or start the server with <strong>npm run dev:https</strong>.
            </p>
          ) : null}
          {state === 'denied' ? <p>Camera permission was refused. Allow it and reload.</p> : null}
          {state === 'error' ? <p>Camera would not start. {detail}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
