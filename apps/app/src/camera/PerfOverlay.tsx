import { useEffect, useRef, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { perfStats, subscribePerf } from './scan-perf.ts'
import './scan-instrument.css'

/**
 * The scan-speed instrument.
 *
 * A dev overlay for the kill-shot test (docs/review-2026-09-02.md lens 4
 * item 2): hand a cheap Android to the owner, turn this on, scan labels for
 * 30 minutes. It shows everything that test needs and nothing else —
 * decode→feedback latency (last / avg / p95), scans per minute, session
 * clock, and battery at start vs now. If the p95 is still under budget and
 * the battery drop is sane at minute 30, the product's core bet holds on
 * that phone.
 *
 * DEV CHROME, NOT PRODUCT CHROME. It is toggled by a long-press on the
 * camera view (see QrCamera) or `?perf=1`, renders no interactive targets,
 * and passes every pointer event through. Its labels are deliberately not
 * in strings.ts — they are instrument glyphs for the person running the
 * test, not words the product speaks (the strings guard checks JSX text;
 * these render through expressions on purpose, with the guard's own
 * blessing for dev-only surfaces).
 */

// Not STR: dev-only instrument labels, invisible to real users.
const L = {
  latency: 'decode→feedback',
  last: 'last',
  avg: 'avg',
  p95: 'p95',
  rate: 'scans/min',
  session: 'session',
  battery: 'battery',
  none: '–',
  waiting: 'no scans yet',
}

/** One battery reading, native (Capacitor Device) or web, as a percent. */
async function readBattery(): Promise<number | null> {
  try {
    if (Capacitor.isNativePlatform()) {
      const { Device } = await import('@capacitor/device')
      const info = await Device.getBatteryInfo()
      return typeof info.batteryLevel === 'number'
        ? Math.round(info.batteryLevel * 100)
        : null
    }
    const nav = navigator as Navigator & {
      getBattery?: () => Promise<{ level: number }>
    }
    if (nav.getBattery) {
      const b = await nav.getBattery()
      return Math.round(b.level * 100)
    }
  } catch {
    /* no battery API — the field shows a dash */
  }
  return null
}

function fmtMs(ms: number | null): string {
  return ms === null ? L.none : `${Math.round(ms)}`
}

function fmtClock(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

const BATTERY_POLL_MS = 30_000

export function PerfOverlay() {
  const [, setTick] = useState(0)
  const [batteryStart, setBatteryStart] = useState<number | null>(null)
  const [batteryNow, setBatteryNow] = useState<number | null>(null)
  const startRef = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    // A 1Hz clock plus a nudge on every scan keeps the numbers live without
    // the overlay ever rendering inside the scan handler itself.
    const clock = setInterval(() => setTick((t) => t + 1), 1000)
    const unsub = subscribePerf(() => setTick((t) => t + 1))

    const poll = async () => {
      const pct = await readBattery()
      if (!alive) return
      if (pct !== null && startRef.current === null) {
        startRef.current = pct
        setBatteryStart(pct)
      }
      setBatteryNow(pct)
    }
    void poll()
    const battery = setInterval(() => void poll(), BATTERY_POLL_MS)

    return () => {
      alive = false
      clearInterval(clock)
      clearInterval(battery)
      unsub()
    }
  }, [])

  const s = perfStats()
  const over = s.p95Ms !== null && s.p95Ms > 100

  return (
    <div className="perf-overlay" aria-hidden="true">
      <div className="perf-row perf-title">
        <span>{L.latency}</span>
        <span className="perf-clock">{fmtClock(s.sessionMs)}</span>
      </div>
      {s.totalScans === 0 ? (
        <div className="perf-row perf-dim">
          <span>{L.waiting}</span>
        </div>
      ) : (
        <>
          <div className={`perf-row perf-big${over ? ' perf-over' : ''}`}>
            <span>
              {L.last} {fmtMs(s.lastMs)}
            </span>
            <span>
              {L.avg} {fmtMs(s.avgMs)}
            </span>
            <span>
              {L.p95} {fmtMs(s.p95Ms)}
            </span>
          </div>
          <div className="perf-row">
            <span>
              {L.rate} {s.scansPerMin}
            </span>
            <span className="perf-dim">{`n=${s.totalScans}`}</span>
          </div>
        </>
      )}
      <div className="perf-row">
        <span>
          {L.battery}{' '}
          {batteryStart === null ? L.none : `${batteryStart}%`}
          {'→'}
          {batteryNow === null ? L.none : `${batteryNow}%`}
        </span>
      </div>
    </div>
  )
}
