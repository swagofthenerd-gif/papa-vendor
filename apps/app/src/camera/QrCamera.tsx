import { useEffect, useRef, useState } from 'react'
import jsQR from 'jsqr'
import { Capacitor } from '@capacitor/core'
import { STR } from '../strings.ts'
import { markDecode, perfOverlayEnabled, setPerfOverlayEnabled } from './scan-perf.ts'
import { PerfOverlay } from './PerfOverlay.tsx'
import './native-scan.css'

/**
 * The camera preview and QR decoder — a three-step fallback chain.
 *
 * 1. NATIVE (the Android shell): ML Kit through
 *    @capacitor-mlkit/barcode-scanning. The plugin owns the camera and
 *    renders its preview BEHIND the WebView; native-scan.css punches a
 *    transparent hole where the camera frame sits so the layout survives.
 *    This is the path the <100ms scan budget is measured against.
 *
 * 2. BarcodeDetector, which on Android Chrome is the same native decoder
 *    ML Kit wraps — so in a browser on the target device the demo's decode
 *    speed is close to what the real scanner will feel.
 *
 * 3. jsQR, because BarcodeDetector DOES NOT EXIST in Chrome on Linux or
 *    Windows desktop — it ships on Android, ChromeOS and macOS only.
 *    Without the fallback the demo shows a live picture and decodes nothing
 *    on the very machine it is being demonstrated from, which is
 *    indistinguishable from every tag being broken. jsQR is slower and that
 *    is the honest trade: it is the desk fallback, not the number the scan
 *    budget is measured against.
 *
 * NOTHING HERE AWAITS ON BEHALF OF A SCAN. All three paths call `onDecode`
 * synchronously the moment a value reaches JavaScript; the scan handler
 * downstream never waits on this component. Each decode is also stamped on
 * the perf instrument (markDecode) so decode→feedback is measurable.
 */

type MlkitModule = typeof import('@capacitor-mlkit/barcode-scanning')

// One shared module promise: start, stop and the torch all need the plugin,
// and the chunk should load once, at camera start, never per scan.
let mlkitModule: Promise<MlkitModule> | null = null
function mlkit(): Promise<MlkitModule> {
  mlkitModule ??= import('@capacitor-mlkit/barcode-scanning')
  return mlkitModule
}

/** How long a finger holds the camera view to toggle the perf instrument. */
const PERF_TOGGLE_HOLD_MS = 700

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
  // True while the ML Kit plugin owns the camera. A ref, not state: the
  // torch effect and the cleanup read it without re-rendering the preview.
  const nativeScanRef = useRef(false)
  const perfHoldRef = useRef<number | null>(null)
  const [state, setState] = useState<CameraState>('starting')
  const [detail, setDetail] = useState<string>('')
  const [native, setNative] = useState(true)
  const [perfOn, setPerfOn] = useState(perfOverlayEnabled)

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

    // The native path. The plugin owns the camera; this component only
    // relays decodes and manages the transparent hole + torch.
    function stopNative() {
      nativeScanRef.current = false
      document.body.classList.remove('papa-native-scan')
      void mlkit()
        .then(async ({ BarcodeScanner }) => {
          await BarcodeScanner.removeAllListeners()
          await BarcodeScanner.stopScan()
        })
        .catch(() => {})
    }

    async function startNative() {
      const { BarcodeScanner, BarcodeFormat, LensFacing } = await mlkit()

      let granted = false
      try {
        const perm = await BarcodeScanner.requestPermissions()
        granted = perm.camera === 'granted' || perm.camera === 'limited'
      } catch {
        granted = false
      }
      if (stopped) return
      if (!granted) {
        setState('denied')
        return
      }

      await BarcodeScanner.removeAllListeners()
      await BarcodeScanner.addListener('barcodesScanned', (event) => {
        if (pausedRef.current) return
        for (const barcode of event.barcodes) {
          const value = barcode.rawValue ?? barcode.displayValue
          if (value) {
            markDecode()
            decodeRef.current(value)
          }
        }
      })
      await BarcodeScanner.addListener('scanError', (event) => {
        setState('error')
        setDetail(event.message)
      })
      if (stopped) {
        void BarcodeScanner.removeAllListeners()
        return
      }

      document.body.classList.add('papa-native-scan')
      nativeScanRef.current = true
      try {
        await BarcodeScanner.startScan({
          formats: [BarcodeFormat.QrCode],
          lensFacing: LensFacing.Back,
        })
      } catch (err) {
        stopNative()
        setState('error')
        setDetail(err instanceof Error ? err.message : String(err))
        return
      }
      if (stopped) {
        stopNative()
        return
      }
      // Counts as the native decoder for the on-screen note — it IS ML Kit.
      setNative(true)
      setState('live')
      // No luma sampling on this path (the frames never reach JS), so the
      // auto-torch stays a web-path behaviour; the header toggle drives the
      // real lamp below.
    }

    async function start() {
      if (Capacitor.isNativePlatform()) {
        await startNative()
        return
      }
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
          if (found?.data) {
            markDecode()
            decodeRef.current(found.data)
          }
          busy = false
          return
        }

        detector
          .detect(canvas)
          .then((codes) => {
            for (const c of codes) {
              if (c.rawValue) {
                markDecode()
                decodeRef.current(c.rawValue)
              }
            }
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
      if (nativeScanRef.current) stopNative()
    }
  }, [])

  // The torch is a capability of the track, not of the page. Most laptops have
  // no lamp, so a failure here is expected and must stay silent rather than
  // throwing into the scan screen.
  useEffect(() => {
    if (nativeScanRef.current) {
      // On the native path the plugin owns the lamp.
      void mlkit()
        .then(({ BarcodeScanner }) =>
          torchOn ? BarcodeScanner.enableTorch() : BarcodeScanner.disableTorch(),
        )
        .catch(() => {})
      return
    }
    const track = trackRef.current
    if (!track) return
    const constraints = { advanced: [{ torch: torchOn }] } as unknown as MediaTrackConstraints
    void track.applyConstraints(constraints).catch(() => {})
  }, [torchOn, state])

  // A long hold on the camera view toggles the scan-speed instrument —
  // dev-flag chrome for the 30-minute thermal test, reachable on a device
  // with no URL bar. Deliberately long enough that no scanning gesture
  // trips it, and it adds zero elements to the loop when off.
  const perfHoldStart = () => {
    perfHoldRef.current = window.setTimeout(() => {
      perfHoldRef.current = null
      setPerfOn((on) => {
        setPerfOverlayEnabled(!on)
        return !on
      })
    }, PERF_TOGGLE_HOLD_MS)
  }
  const perfHoldEnd = () => {
    if (perfHoldRef.current !== null) {
      clearTimeout(perfHoldRef.current)
      perfHoldRef.current = null
    }
  }

  return (
    <div
      className="qr-camera"
      onPointerDown={perfHoldStart}
      onPointerUp={perfHoldEnd}
      onPointerCancel={perfHoldEnd}
      onPointerLeave={perfHoldEnd}
    >
      <video ref={videoRef} playsInline muted autoPlay className="qr-video" />
      {perfOn ? <PerfOverlay /> : null}
      {/* Named, not hidden. The desk decoder is slower than the phone's, and
          a tech comparing the two must know which one they are holding. */}
      {state === 'live' && !native ? (
        <span className="qr-decoder-note">{STR.scanDeskDecoder}</span>
      ) : null}
      {state !== 'live' ? (
        <div className="qr-camera-msg">
          {state === 'starting' ? <p>{STR.scanStartingCamera}</p> : null}
          {state === 'insecure' ? (
            <p>
              {STR.scanNeedsSecurePageOpenOn} <strong>localhost</strong>
              {STR.scanOrStartTheServerWith} <strong>npm run dev:https</strong>.
            </p>
          ) : null}
          {state === 'denied' ? <p>{STR.scanPermissionRefused}</p> : null}
          {state === 'error' ? <p>{STR.scanCameraWouldNotStart} {detail}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
