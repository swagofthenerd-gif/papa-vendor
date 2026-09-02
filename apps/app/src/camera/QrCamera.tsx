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

// Below this mean luma (0–255) the room is dark enough that ML Kit needs the
// lamp. Judged from the first frames — a warehouse before dawn sits well under
// this; an indoor-lit shelf sits comfortably above it.
const DARK_LUMA_THRESHOLD = 60
// Average across the first few frames rather than one, so a single dark frame
// while the sensor's auto-exposure settles does not trip the lamp on its own.
const LUMA_SAMPLE_FRAMES = 5

// Track.getCapabilities is not in the DOM lib's type and is absent on some
// browsers; read it defensively.
interface TorchCapableTrack {
  getCapabilities?: () => { torch?: boolean }
}

export function QrCamera({
  torchOn,
  onDecode,
  onAutoTorch,
  paused = false,
}: {
  torchOn: boolean
  /** Called with the decoded text. Fires repeatedly; dedupe downstream. */
  onDecode: (value: string) => void
  /**
   * Called at most once, early, when the room is dark AND the platform can
   * drive the lamp — so the parent can default the torch on. The parent stays
   * the source of truth, so the header toggle keeps working after. Absent or
   * silently ignored where the lamp is unsupported.
   */
  onAutoTorch?: () => void
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
  const autoTorchRef = useRef(onAutoTorch)
  autoTorchRef.current = onAutoTorch
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

      // Ambient-light torch default. Only worth measuring where the lamp can
      // actually be driven; otherwise a dark reading has no action to take.
      const capTrack = trackRef.current as TorchCapableTrack | null
      const torchSupported = capTrack?.getCapabilities?.().torch === true
      let lumaFrames = 0
      let lumaSum = 0
      let autoTorchDone = !torchSupported

      const tick = () => {
        if (stopped) return
        raf = requestAnimationFrame(tick)
        if (busy || pausedRef.current) return
        if (!ctx || video.videoWidth === 0) return
        busy = true
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        ctx.drawImage(video, 0, 0)

        // Sample average luma over the first few frames, then decide once. Read
        // from a small centre crop — cheap, and it is what the lens is aimed at.
        if (!autoTorchDone) {
          const s = Math.min(64, canvas.width, canvas.height)
          const px = ctx.getImageData(
            (canvas.width - s) / 2,
            (canvas.height - s) / 2,
            s,
            s,
          ).data
          let sum = 0
          for (let i = 0; i < px.length; i += 4) {
            sum += 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
          }
          lumaSum += sum / (px.length / 4)
          if (++lumaFrames >= LUMA_SAMPLE_FRAMES) {
            autoTorchDone = true
            if (lumaSum / lumaFrames < DARK_LUMA_THRESHOLD) autoTorchRef.current?.()
          }
        }

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
