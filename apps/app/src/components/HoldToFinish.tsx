import { useCallback, useEffect, useRef, useState } from 'react'
import { HOLD_MS } from '../hold.ts'

export { HOLD_MS }

/**
 * Press and hold to finish a session.
 *
 * NOT A TAP. A tap at the bottom of the screen is exactly what a knuckle does
 * while carrying a case, and an accidental finish closes a pull the tech is
 * halfway through. A 500ms hold with a visibly filling ring is deliberate,
 * glove-operable, and cancellable by lifting — the affordance says "I am
 * listening, keep holding" and lets you change your mind without a dialog.
 *
 * The same reasoning rules out a confirm dialog: a modal at the end of a pull
 * is one more thing to dismiss with a wet glove, and people learn to dismiss
 * modals without reading them.
 */


export function HoldToFinish({
  label,
  onFinish,
  disabled = false,
  holdMs = HOLD_MS,
}: {
  label: string
  onFinish: () => void
  disabled?: boolean
  holdMs?: number
}) {
  const [progress, setProgress] = useState(0)
  const raf = useRef<number | null>(null)
  const start = useRef<number | null>(null)

  const cancel = useCallback(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current)
    raf.current = null
    start.current = null
    setProgress(0)
  }, [])

  // Cancel on unmount, or a hold in flight keeps a rAF alive against a dead
  // component and fires onFinish after the screen is gone.
  useEffect(() => cancel, [cancel])

  const begin = useCallback(() => {
    if (disabled || start.current !== null) return
    start.current = performance.now()

    const tick = (now: number) => {
      if (start.current === null) return
      const p = Math.min(1, (now - start.current) / holdMs)
      setProgress(p)
      if (p >= 1) {
        cancel()
        onFinish()
        return
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
  }, [cancel, disabled, holdMs, onFinish])

  return (
    <button
      type="button"
      className="hold-btn"
      disabled={disabled}
      // Pointer events cover touch, pen and mouse with one path. `onLostPointerCapture`
      // matters on Android: a scroll gesture steals the pointer mid-hold, and
      // without this the ring would sit frozen at 60% forever.
      onPointerDown={begin}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      // Keyboard equivalent for the console, where this same control appears.
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') begin() }}
      onKeyUp={cancel}
      style={{ ['--hold-progress' as string]: progress }}
      aria-label={`${label} — press and hold`}
    >
      <span className="hold-fill" aria-hidden="true" />
      <span className="hold-label">{label}</span>
    </button>
  )
}
