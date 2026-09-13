import { useEffect, useState } from 'react'

/**
 * How the screens learn the background sync changed something (W9).
 *
 * The store is a database, not a React state tree, and every screen already
 * re-reads it on a local tick. The SyncLoop runs behind all of them, so
 * when a cycle lands rows it raises ONE window event and any mounted
 * screen that cares bumps its own tick — no context threaded through
 * twenty files, no re-render of a screen that is not looking.
 */
const EVENT = 'papa:sync'

export function notifySync(): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new Event(EVENT))
}

/** A counter that moves after every sync cycle that changed rows. */
export function useSyncTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((t) => t + 1)
    window.addEventListener(EVENT, bump)
    return () => window.removeEventListener(EVENT, bump)
  }, [])
  return tick
}
