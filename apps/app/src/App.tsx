import { useEffect, useState } from 'react'
import { IconSketchFilter } from '@papa/icons'
import { parseHash, type View } from './nav.ts'
import { Jobs } from './routes/Jobs.tsx'

/**
 * The app shell.
 *
 * ONE shell, not two. The architecture proposed separate scanner and console
 * apps; that is a bet placed before the second use case exists, and its own
 * open-uncertainty list says to revisit at the end of phase 2. Route-level
 * code splitting gives most of the benefit at none of the cost, and the split
 * can happen when the duplication is MEASURED rather than predicted.
 */
export function App() {
  const [view, setView] = useState<View>(() => parseHash(window.location.hash))

  useEffect(() => {
    const onHash = () => setView(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  return (
    <>
      {/* Mounted ONCE at the root. Without it every glyph renders unfiltered —
          which looks fine alone and obviously wrong beside one that is not. */}
      <IconSketchFilter />
      {render(view)}
    </>
  )
}

function render(view: View) {
  switch (view.name) {
    case 'jobs':
      return <Jobs jobs={[]} userName="Not signed in" onNewJob={() => {}} />
    default:
      // Every other route is wired in the next phase. Failing soft here rather
      // than throwing keeps a stale deep link from white-screening a phone.
      return (
        <div className="screen">
          <div className="empty">
            <p>Not built yet.</p>
            <p className="muted">{view.name}</p>
          </div>
        </div>
      )
  }
}
