/**
 * The scan-speed instrument's measuring tape.
 *
 * WHY: the product's kill-shot test (docs/review-2026-09-02.md, lens 4
 * item 2) is <100ms decode-to-feedback sustained for a 30-minute session on
 * a cheap Android — because thermal throttling makes minute-2 numbers a
 * fiction by minute 18, and nothing in ordinary telemetry says why. This
 * module records exactly the numbers that test needs and nothing else.
 *
 * WHAT IS MEASURED, precisely:
 *
 *   markDecode()   — the moment a decoded QR value reaches JavaScript.
 *                    On the web path that is the frame where jsQR or
 *                    BarcodeDetector returned; on the native path it is the
 *                    arrival of the ML Kit plugin's bridge event. The
 *                    camera-to-bridge time on native is invisible from JS,
 *                    so the absolute number flatters slightly — but the
 *                    TREND across 30 minutes, which is what throttling
 *                    corrupts, is fully visible.
 *
 *   markFeedback() — the haptic onset (the instant the feedback vocabulary
 *                    fires — the part a human times the scan by, see
 *                    packages/core/src/feedback.ts). The latency SAMPLE is
 *                    taken one animation frame later, i.e. after React has
 *                    committed the row, so it approximates decode → VISIBLE
 *                    feedback, the budget's actual definition.
 *
 * Deliberately not a React hook and deliberately module-global: the scan
 * screen rebuilds callbacks on every scan, and the instrument must never
 * add renders, closures, or awaits to the loop it is measuring. Everything
 * here is synchronous; the only async part is the rAF that stamps paint.
 */

/** Rolling window sizes — small enough to never matter, big enough for p95. */
const MAX_LATENCY_SAMPLES = 500
const MAX_SCAN_TIMES = 1_200
/** A decode older than this never pairs with a feedback; drop it. */
const PAIR_WINDOW_MS = 2_000

let pendingDecodeAt: number | null = null
let sessionStartedAt: number | null = null
let totalScans = 0
const latencySamples: number[] = []
const scanTimes: number[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const fn of listeners) fn()
}

/** Call the instant a decoded value reaches JS, before the scan handler. */
export function markDecode(): void {
  pendingDecodeAt = performance.now()
}

/**
 * Call at haptic onset. Pairs with the most recent decode; the visible-
 * feedback sample is stamped on the next animation frame, after commit.
 */
export function markFeedback(): void {
  const now = performance.now()
  totalScans += 1
  if (sessionStartedAt === null) sessionStartedAt = now
  scanTimes.push(now)
  if (scanTimes.length > MAX_SCAN_TIMES) {
    scanTimes.splice(0, scanTimes.length - MAX_SCAN_TIMES)
  }

  const decodedAt = pendingDecodeAt
  pendingDecodeAt = null
  if (decodedAt !== null && now - decodedAt < PAIR_WINDOW_MS) {
    requestAnimationFrame((frameTs) => {
      latencySamples.push(Math.max(0, frameTs - decodedAt))
      if (latencySamples.length > MAX_LATENCY_SAMPLES) {
        latencySamples.splice(0, latencySamples.length - MAX_LATENCY_SAMPLES)
      }
      emit()
    })
  }
  emit()
}

export interface PerfStats {
  /** Decode → visible feedback, most recent scan. Null until the first. */
  lastMs: number | null
  avgMs: number | null
  p95Ms: number | null
  /** Scans whose feedback fired in the trailing 60 seconds. */
  scansPerMin: number
  totalScans: number
  /** Elapsed since the first scan of this app run. 0 before any scan. */
  sessionMs: number
}

export function perfStats(): PerfStats {
  const now = performance.now()
  const n = latencySamples.length
  let avgMs: number | null = null
  let p95Ms: number | null = null
  if (n > 0) {
    avgMs = latencySamples.reduce((a, b) => a + b, 0) / n
    const sorted = [...latencySamples].sort((a, b) => a - b)
    p95Ms = sorted[Math.min(n - 1, Math.ceil(n * 0.95) - 1)]
  }
  let recent = 0
  for (let i = scanTimes.length - 1; i >= 0; i--) {
    if (now - scanTimes[i] > 60_000) break
    recent++
  }
  return {
    lastMs: n > 0 ? latencySamples[n - 1] : null,
    avgMs,
    p95Ms,
    scansPerMin: recent,
    totalScans,
    sessionMs: sessionStartedAt === null ? 0 : now - sessionStartedAt,
  }
}

export function subscribePerf(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/* ---- the dev flag ------------------------------------------------------ */

const PERF_FLAG = 'papa-perf'

/**
 * The instrument is a dev flag, not user-facing chrome. It turns on via
 * `?perf=1` in the URL (web) or a long-press on the camera view (device,
 * where there is no URL bar), and the choice sticks in localStorage so a
 * 30-minute session survives navigation and restarts.
 */
export function perfOverlayEnabled(): boolean {
  try {
    const q = new URLSearchParams(window.location.search)
    if (q.get('perf') === '1') {
      localStorage.setItem(PERF_FLAG, '1')
      return true
    }
    if (q.get('perf') === '0') {
      localStorage.removeItem(PERF_FLAG)
      return false
    }
    return localStorage.getItem(PERF_FLAG) === '1'
  } catch {
    return false
  }
}

export function setPerfOverlayEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(PERF_FLAG, '1')
    else localStorage.removeItem(PERF_FLAG)
  } catch {
    /* private mode: the toggle simply does not persist */
  }
}
