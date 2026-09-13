import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react'
import { Icon } from '@papa/icons'
import { STR } from '../strings.ts'

/**
 * The bottom sheet — one home for how every sheet arrives, leaves and is
 * dragged away.
 *
 * ARRIVES: a 200ms ease-out rise with a fade (app.css .sheet). LEAVES: a
 * 150ms ease-in drop. Nothing else moves; the sheet is opened many times a
 * day, so the motion is short enough to be felt and not watched.
 *
 * THE HANDLE IS REAL. A pull down on the grip or the header follows the
 * thumb (translateY, nothing else — compositor-only), resists upward, and
 * on release either springs back or, past a third of the sheet's height
 * or a flick faster than half a pixel per millisecond, finishes the drop
 * and closes. Dragging starts on the grip and the header only: the body
 * scrolls, and a scroll must never turn into a dismissal.
 *
 * REDUCED MOTION: the OS preference makes every close instant and every
 * arrival a cut — the CSS side kills the durations, and the JS side skips
 * the exit wait so the sheet is not left waiting for an animationend that
 * has already fired.
 *
 * THE CLOSE IS ONE FUNCTION. `useSheetClose()` (and the `SheetClose` X)
 * play the exit first and call the owner's onClose after it; a sheet the
 * owner unmounts directly after a write simply goes — the page underneath
 * has already changed, and that change is the feedback.
 */

const CloseContext = createContext<() => void>(() => {})

/** The animated close of the enclosing Sheet — for any button inside it. */
export function useSheetClose(): () => void {
  return useContext(CloseContext)
}

/** The X every sheet header carries. */
export function SheetClose() {
  const close = useSheetClose()
  return (
    <button className="icon-btn" onClick={close} aria-label={STR.commonClose}>
      <Icon name="x" size={22} />
    </button>
  )
}

const reducedMotion = (): boolean =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

/** Past this share of the sheet's height, a pull is a dismissal… */
const DISMISS_SHARE = 0.3
/** …and so is a flick this fast (px/ms), however short. */
const DISMISS_VELOCITY = 0.5
/** A pointer that has not moved this far is a tap, and taps stay taps. */
const DRAG_SLOP_PX = 6
/** The exit's duration, mirrored from app.css so a lost animationend
 *  cannot leave the sheet hanging. */
const EXIT_MS = 150

interface Drag {
  pointerId: number
  startY: number
  lastY: number
  lastT: number
  velocity: number
  dy: number
  captured: boolean
}

export function Sheet({
  label,
  onClose,
  tall = false,
  className,
  children,
}: {
  /** The dialog's accessible name — the same words as its title. */
  label: string
  onClose: () => void
  /** A long form that scrolls as a whole (app.css .sheet-tall). */
  tall?: boolean
  className?: string
  children: ReactNode
}) {
  const backdropRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<Drag | null>(null)
  const [phase, setPhase] = useState<'open' | 'closing' | 'dragging'>('open')
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const finished = useRef(false)

  const finish = useCallback(() => {
    if (finished.current) return
    finished.current = true
    onCloseRef.current()
  }, [])

  const close = useCallback(() => {
    if (finished.current) return
    if (reducedMotion()) { finish(); return }
    setPhase('closing')
  }, [finish])

  // The exit: the CSS animation runs, then the owner is told. The timer is
  // the belt to animationend's braces — a tab in the background never
  // fires animationend, and a sheet that cannot close is a trapped user.
  useEffect(() => {
    if (phase !== 'closing') return
    const el = panelRef.current
    const t = setTimeout(finish, EXIT_MS + 60)
    el?.addEventListener('animationend', finish)
    return () => { clearTimeout(t); el?.removeEventListener('animationend', finish) }
  }, [phase, finish])

  // Focus moves into the sheet on open and back out on close; Escape is
  // the keyboard's pull-down.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const panel = panelRef.current
    if (panel && !panel.contains(document.activeElement)) {
      const first = panel.querySelector<HTMLElement>('[autofocus]')
      ;(first ?? panel).focus({ preventScroll: true })
    }
    return () => {
      if (before && document.contains(before)) before.focus({ preventScroll: true })
    }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); close() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (phase === 'closing' || e.button !== 0) return
    const target = e.target as Element
    // Only the grip and the header pull the sheet; the body scrolls.
    if (!target.closest('.sheet-grip, .sheet-head')) return
    dragRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      lastY: e.clientY,
      lastT: e.timeStamp,
      velocity: 0,
      dy: 0,
      captured: false,
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const panel = panelRef.current
    if (!d || !panel || e.pointerId !== d.pointerId) return
    const raw = e.clientY - d.startY
    if (!d.captured) {
      if (Math.abs(raw) < DRAG_SLOP_PX) return
      // Capture only once it is a drag: capturing on the down would steal
      // the click from the X button under the same thumb.
      panel.setPointerCapture(e.pointerId)
      d.captured = true
      setPhase('dragging')
    }
    const dt = Math.max(1, e.timeStamp - d.lastT)
    d.velocity = (e.clientY - d.lastY) / dt
    d.lastY = e.clientY
    d.lastT = e.timeStamp
    // Upward pulls resist: the sheet is anchored to the bottom edge.
    d.dy = raw >= 0 ? raw : raw / 4
    panel.style.transform = `translateY(${d.dy}px)`
    const backdrop = backdropRef.current
    if (backdrop) {
      const share = Math.max(0, Math.min(1, d.dy / panel.offsetHeight))
      backdrop.style.setProperty('--sheet-veil', String(1 - share * 0.7))
    }
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = dragRef.current
    const panel = panelRef.current
    if (!d || !panel || e.pointerId !== d.pointerId) return
    dragRef.current = null
    if (!d.captured) return
    panel.releasePointerCapture(e.pointerId)
    const height = panel.offsetHeight
    const dismiss =
      e.type !== 'pointercancel' &&
      (d.dy > height * DISMISS_SHARE || (d.velocity > DISMISS_VELOCITY && d.dy > DRAG_SLOP_PX * 2))
    if (dismiss) {
      if (reducedMotion()) { finish(); return }
      // Finish the drop from where the thumb let go; the CSS exit would
      // snap back to the top first.
      panel.style.transition = `transform ${EXIT_MS}ms ease-in`
      panel.style.transform = `translateY(${height + 8}px)`
      backdropRef.current?.style.setProperty('--sheet-veil', '0')
      const t = setTimeout(finish, EXIT_MS + 60)
      panel.addEventListener('transitionend', () => { clearTimeout(t); finish() }, { once: true })
      setPhase('closing')
      return
    }
    // Not far enough: spring home.
    panel.style.transition = 'transform var(--dur) var(--ease-spring)'
    panel.style.transform = ''
    backdropRef.current?.style.removeProperty('--sheet-veil')
    panel.addEventListener('transitionend', () => { panel.style.transition = '' }, { once: true })
    setPhase('open')
  }

  return (
    <div
      ref={backdropRef}
      className={`sheet-backdrop${phase === 'closing' ? ' is-closing' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label={label}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className={`sheet${tall ? ' sheet-tall' : ''}${phase === 'dragging' ? ' is-dragging' : ''}${className ? ` ${className}` : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
      >
        {/* The grip: the visible bar sits inside a glove-height strip, so
            the pull does not have to land on four pixels. */}
        <div className="sheet-grip" aria-hidden="true"><span /></div>
        <CloseContext.Provider value={close}>{children}</CloseContext.Provider>
      </div>
    </div>
  )
}
