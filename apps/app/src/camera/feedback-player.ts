/**
 * The feedback vocabulary, made audible and tactile.
 *
 * The vocabulary itself — patterns, tones, the face-down bar — lives in
 * packages/core/src/feedback.ts and is IMPORTED, never restated. This file
 * only decides which motor and which speaker plays it:
 *
 *   haptics — @capacitor/haptics inside the Android shell (the WebView's
 *             navigator.vibrate is inconsistently honoured across OEM
 *             WebViews; the plugin drives the vibrator directly), and
 *             navigator.vibrate on the plain web where it exists.
 *   audio   — WebAudio everywhere. Oscillators, not samples: the vocabulary
 *             is pitch-discriminable by design, and a synthesized tone at
 *             the named frequency IS the spec, with nothing to ship.
 *
 * NOTHING HERE AWAITS ON BEHALF OF A SCAN. playFeedback() is synchronous;
 * the native haptics module is imported eagerly at startup so the first
 * scan of the morning does not pay a module-load on its first buzz.
 */
import { Capacitor } from '@capacitor/core'
import type { FeedbackSpec } from '@papa/core'
import { markFeedback } from './scan-perf.ts'

/** Gap between discrete tones — Scan-Loop-UX names 40ms for the double. */
const TONE_GAP_S = 0.04
const TONE_GAIN = 0.28
/** 5ms attack/release so square-ish starts do not click in a quiet office. */
const RAMP_S = 0.005

type HapticsModule = typeof import('@capacitor/haptics')

// Warmed at module load on native, so the first buzz is immediate.
const hapticsReady: Promise<HapticsModule> | null = Capacitor.isNativePlatform()
  ? import('@capacitor/haptics')
  : null

function vibrate(pattern: number[]): void {
  if (pattern.length === 0) return
  if (hapticsReady) {
    void hapticsReady.then(({ Haptics }) => {
      // The plugin vibrates one duration at a time; the gaps in the pattern
      // become timer delays. Timer jitter is a few ms; the vocabulary's
      // patterns are separated by ≥40ms on purpose, so rhythm survives.
      let at = 0
      pattern.forEach((ms, i) => {
        if (i % 2 === 0) {
          if (at === 0) void Haptics.vibrate({ duration: ms })
          else setTimeout(() => void Haptics.vibrate({ duration: ms }), at)
        }
        at += ms
      })
    })
    return
  }
  if (typeof navigator.vibrate === 'function') navigator.vibrate(pattern)
}

let audioCtx: AudioContext | null = null

function audio(): AudioContext | null {
  try {
    audioCtx ??= new AudioContext()
    // Autoplay policy may start it suspended; the scan screen is always
    // reached through a tap, so a resume here succeeds from then on.
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    return audioCtx
  } catch {
    return null
  }
}

function tone(
  ac: AudioContext,
  at: number,
  ms: number,
  shape: (osc: OscillatorNode) => void,
): number {
  const osc = ac.createOscillator()
  const gain = ac.createGain()
  osc.type = 'sine'
  shape(osc)
  const dur = ms / 1000
  gain.gain.setValueAtTime(0, at)
  gain.gain.linearRampToValueAtTime(TONE_GAIN, at + RAMP_S)
  gain.gain.setValueAtTime(TONE_GAIN, Math.max(at + RAMP_S, at + dur - RAMP_S))
  gain.gain.linearRampToValueAtTime(0, at + dur)
  osc.connect(gain)
  gain.connect(ac.destination)
  osc.start(at)
  osc.stop(at + dur)
  return at + dur
}

function playTones(spec: FeedbackSpec): void {
  if (spec.tones.length === 0 && !spec.glide) return
  const ac = audio()
  if (!ac) return
  let at = ac.currentTime
  for (const [hz, ms] of spec.tones) {
    at = tone(ac, at, ms, (osc) => osc.frequency.setValueAtTime(hz, at)) + TONE_GAP_S
  }
  if (spec.glide) {
    const { from, to, ms } = spec.glide
    const start = at
    tone(ac, start, ms, (osc) => {
      osc.frequency.setValueAtTime(from, start)
      osc.frequency.linearRampToValueAtTime(to, start + ms / 1000)
    })
  }
}

/**
 * Fire one entry of the vocabulary: haptic + audio together, always — that
 * is the vocabulary's own rule (lanyards defeat haptics, generators defeat
 * audio). Also stamps the perf instrument's feedback mark, because haptic
 * onset is the moment a human counts as "the scanner answered".
 */
export function playFeedback(spec: FeedbackSpec): void {
  markFeedback()
  vibrate(spec.haptic)
  playTones(spec)
}
