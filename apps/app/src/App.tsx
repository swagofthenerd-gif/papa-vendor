import { useEffect, useState } from 'react'
import { IconSketchFilter } from '@papa/icons'
import { parseHash, go, type View } from './nav.ts'
import { Jobs, type JobRow } from './routes/Jobs.tsx'
import { SyncStrip } from './components/SyncStrip.tsx'
import { DemoStore } from './demo/store.ts'
import { ScanScreen } from './demo/ScanScreen.tsx'
import { EnquiryScreen } from './demo/EnquiryScreen.tsx'
import { Tags } from './demo/Tags.tsx'

/**
 * The app shell.
 *
 * ONE shell, not two. The architecture proposed separate scanner and console
 * apps; that is a bet placed before the second use case exists, and its own
 * open-uncertainty list says to revisit at the end of phase 2. Route-level
 * code splitting gives most of the benefit at none of the cost, and the split
 * can happen when the duplication is MEASURED rather than predicted.
 *
 * DEMO DATA, NO SERVER. There is no login yet, so the shell opens a local
 * database seeded with a plausible rental house instead of syncing one. The
 * scan engine, the outbox, the pull list and the kit-list reader underneath
 * are the real ones — only the server they would normally talk to is missing,
 * which shows up honestly as scans that queue and never send.
 */
export function App() {
  const [view, setView] = useState<View>(() => parseHash(window.location.hash))
  const [store, setStore] = useState<DemoStore | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    const onHash = () => setView(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  useEffect(() => {
    let cancelled = false
    DemoStore.open()
      .then((s) => { if (!cancelled) setStore(s) })
      .catch((e: unknown) => {
        if (!cancelled) setFailed(e instanceof Error ? e.message : String(e))
      })
    return () => { cancelled = true }
  }, [])

  return (
    <>
      {/* Mounted ONCE at the root. Without it every glyph renders unfiltered —
          which looks fine alone and obviously wrong beside one that is not. */}
      <IconSketchFilter />
      {failed ? <LoadFailed detail={failed} /> : store ? <Routed view={view} store={store} /> : <Booting />}
    </>
  )
}

function Booting() {
  return (
    <div className="screen">
      <div className="empty">
        <p>Loading the demo warehouse…</p>
      </div>
    </div>
  )
}

function LoadFailed({ detail }: { detail: string }) {
  return (
    <div className="screen">
      <div className="empty">
        <p>The local database would not start.</p>
        <p className="muted">{detail}</p>
      </div>
    </div>
  )
}

function Routed({ view, store }: { view: View; store: DemoStore }) {
  switch (view.name) {
    case 'jobs':
      return <Today store={store} />
    case 'scan':
      return <ScanScreen store={store} jobId={view.jobId} mode={view.mode} />
    case 'search':
      return <EnquiryScreen store={store} />
    case 'settings':
      return <Tags store={store} />
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

/**
 * Today's jobs, plus the two demo entry points that have no home in the real
 * navigation yet — the kit-list reader and the labels to scan.
 */
function Today({ store }: { store: DemoStore }) {
  const counts = store.outboxCounts()
  const jobs: JobRow[] = store.jobs().map((j) => ({
    id: j.id,
    label: j.label,
    contact: j.contact,
    expectedBack: null,
    expected: j.expected.length,
    scanned: store.scannedCount(j.id),
    departsAt: j.departsAt,
  }))

  return (
    <>
      <SyncStrip
        // Always "offline": there is no server in the demo, so pretending to
        // be connected would hide the one thing the strip exists to show.
        online={false}
        pending={counts.pending}
        oldestAgeMs={counts.oldestAgeMs}
        failures={counts.failures}
        onOpenFailures={() => {}}
      />
      {/* A job here starts the way it starts in real life: a client pastes a
          kit list into WhatsApp. The search icon in the header reaches the
          same screen. */}
      <Jobs jobs={jobs} userName={store.seed.userName} onNewJob={() => go({ name: 'search' })} />
      <nav className="demo-bar">
        {/* Demo-only. The real product prints these onto labels and sticks
            them on the gear, so there is nothing to reach in the app. */}
        <button className="btn btn-ghost" onClick={() => go({ name: 'settings' })}>
          Labels to scan
        </button>
      </nav>
    </>
  )
}
