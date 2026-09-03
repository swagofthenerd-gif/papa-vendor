import type { ScanOutcome } from './scan.ts'

/**
 * The feedback vocabulary.
 *
 * THE BAR: every one of these must be distinguishable BY FEEL AND EAR WITH
 * THE SCREEN FACE-DOWN. The tech is looking at the gear, not the phone.
 *
 * Haptics alone fail — phones live on lanyards and in pockets, not against
 * skin. Audio alone fails — warehouses run generators and compressors. So
 * both fire, always.
 *
 * And the audio must be PITCH-discriminable rather than beep-COUNT
 * discriminable: under noise, humans count beeps wrong and hear pitch right.
 * That is why accepted and duplicate differ by rhythm *and* why error drops an
 * octave and a half rather than simply beeping three times.
 */

export interface FeedbackSpec {
  /** Vibration pattern in ms: [buzz, gap, buzz, ...]. */
  haptic: number[]
  /** Tones as [hz, ms] pairs, played in sequence. */
  tones: Array<[number, number]>
  /** Rising or falling glide, for outcomes that need to feel "wrong". */
  glide?: { from: number; to: number; ms: number }
  /** What the row does. The caller owns rendering; this names the intent. */
  visual: 'insert' | 'pulse-existing' | 'insert-amber' | 'insert-warning' | 'insert-red' | 'confirm'
  /** Whether the session's counter advances. */
  counts: boolean
}

export const FEEDBACK: Record<ScanOutcome | 'complete', FeedbackSpec> = {
  /** The overwhelmingly common case. Short, light, unmistakable. */
  accepted: {
    haptic: [20],
    tones: [[880, 40]],
    visual: 'insert',
    counts: true,
  },

  /**
   * Already in this session.
   *
   * Fires REAL feedback rather than silence. Silence is indistinguishable
   * from "the camera didn't see it": the tech rescans, gets nothing, rescans
   * again, and concludes the scanner is broken — which is exactly how the
   * system dies. The double-tick says "yes, I have that one", which is the
   * information they were actually asking for.
   */
  duplicate: {
    haptic: [15, 60, 15],
    tones: [[880, 40], [880, 40]],
    visual: 'pulse-existing',
    counts: false,
  },

  /** On the truck but not on this job. Annotates; never stops the line. */
  unexpected: {
    haptic: [60, 40, 60],
    tones: [],
    glide: { from: 660, to: 440, ms: 180 },
    visual: 'insert-amber',
    counts: false,
  },

  /**
   * A label this device has never synced.
   *
   * Deliberately DIFFERENT from `unexpected`, even though both are amber and
   * neither counts, because the tech's next move differs. An unexpected item
   * needs a human decision eventually — add it to the job or set it aside. An
   * unknown tag needs nothing: the server resolves it on sync. So this is one
   * soft buzz and a flat low tone, not the two-part "look at me" of an
   * unexpected item.
   *
   * The first version of this file gave both the same pattern, and the
   * feedback test caught it. The bar is that every outcome is distinguishable
   * with the screen face-down; two amber outcomes feeling identical means the
   * tech cannot tell "decide about this later" from "ignore this".
   */
  unknown_tag: {
    haptic: [90],
    tones: [[494, 140]],
    visual: 'insert-amber',
    counts: false,
  },

  /**
   * A retired or lost label — revoked, but still physically on gear.
   *
   * Amber like the other annotations, but its follow-up differs from BOTH:
   * an unknown tag resolves itself on sync and an unexpected item needs a
   * decision, while a revoked label means the LABEL ITSELF is wrong and the
   * item needs its real one found or a manual add. Two mid-length buzzes and
   * a falling low pair — related to unknown_tag's single low tone by pitch,
   * separated from everything by feel.
   */
  retired_tag: {
    haptic: [90, 60, 90],
    tones: [[494, 90], [392, 140]],
    visual: 'insert-amber',
    counts: false,
  },

  /**
   * Already out to a different job.
   *
   * Deliberately the most distinct pattern in the set — a long buzz and a low
   * double. This is the one the tech must notice while the truck is still in
   * the yard, because at 06:14 the desk is closed.
   */
  conflict: {
    haptic: [200, 80, 200],
    tones: [[330, 120], [330, 120]],
    visual: 'insert-warning',
    counts: true,
  },

  /** Session finished. Rising triad — the only "upward" sound in the set. */
  complete: {
    haptic: [30, 40, 30, 40, 80],
    tones: [[523, 90], [659, 90], [784, 160]],
    visual: 'confirm',
    counts: false,
  },
}

/** A hard error from the queue, not a scan outcome. */
export const ERROR_FEEDBACK: FeedbackSpec = {
  haptic: [200],
  tones: [[220, 200]],
  visual: 'insert-red',
  counts: false,
}

/**
 * Total duration of a pattern.
 *
 * Used to keep feedback inside the 100ms decode-to-feedback budget: anything
 * whose HAPTIC ONSET is late is felt as lag, even when the visual was instant.
 * Only the first buzz has to be immediate; the rest may trail.
 */
export function hapticDurationMs(spec: FeedbackSpec): number {
  return spec.haptic.reduce((a, b) => a + b, 0)
}

/** The first buzz — the part the human actually times the scan by. */
export function firstBuzzMs(spec: FeedbackSpec): number {
  return spec.haptic[0] ?? 0
}
