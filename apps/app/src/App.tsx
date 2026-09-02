import { useEffect, useState } from 'react'
import { Icon, IconSketchFilter } from '@papa/icons'
import { parseHash, go, type View } from './nav.ts'
import { Shell } from './components/Shell.tsx'
import { TodayScreen } from './demo/TodayScreen.tsx'
import { Gear, type GearFilter } from './routes/Gear.tsx'
import { Asset } from './routes/Asset.tsx'
import { DemoStore } from './demo/store.ts'
import { ScanScreen } from './demo/ScanScreen.tsx'
import { SessionScreen } from './demo/SessionScreen.tsx'
import { EnquiryScreen } from './demo/EnquiryScreen.tsx'
import { Tags } from './demo/Tags.tsx'
import { ImportScreen } from './demo/ImportScreen.tsx'

/**
 * The app shell.
 *
 * ONE shell, not two. The architecture proposed separate scanner and console
 * apps; that is a bet placed before the second use case exists, and its own
 * open-uncertainty list says to revisit at the end of phase 2. Route-level
 * code splitting gives most of the benefit at none of the cost, and the split
 * can happen when the duplication is MEASURED rather than predicted.
 *
 * THE SCAN SCREEN IS THE ONE ROUTE WITH NO CHROME. It takes the whole
 * viewport: a tab bar there would eat the camera's share of the height and put
 * a navigation target under a thumb that is holding a case.
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
      {failed ? (
        <Boot title="The local database would not start." detail={failed} />
      ) : store ? (
        <Routed view={view} store={store} />
      ) : (
        <Boot title="Opening the warehouse…" />
      )}
    </>
  )
}

function Boot({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="screen">
      <div className="empty">
        <Icon name="warehouse" size={40} />
        <p>{title}</p>
        {detail ? <p className="muted">{detail}</p> : null}
      </div>
    </div>
  )
}

function Routed({ view, store }: { view: View; store: DemoStore }) {
  // The scanner owns the whole viewport — no top bar, no tab bar.
  if (view.name === 'scan') {
    // KEYED, so moving to another job or turning the session around gives a
    // fresh component. React reuses an instance when only props change, and
    // the scan list, the photo counts and the "device full" banner all live in
    // that instance's state — so without this, opening the wedding job showed
    // the rows scanned for the TVC under the wedding's name.
    return (
      <ScanScreen
        key={`${view.jobId}:${view.mode}`}
        store={store}
        jobId={view.jobId}
        mode={view.mode}
      />
    )
  }

  switch (view.name) {
    case 'jobs':
      // The board owns desk state of its own now (the walk-in sheet, the
      // due-date editor), so it wires itself in demo/TodayScreen.tsx.
      return <TodayScreen store={store} />

    case 'gear': {
      // The Today counters deep-link here by filter rather than by text, so
      // "4 need a look" lands on those four instead of searching for the word.
      const asFilter = (['here', 'out', 'attention'] as const).find((f) => f === view.query)
      return (
        <Shell view={view} title="Gear" subtitle="Everything the house owns">
          <Gear
            rows={store.gearRows()}
            initialQuery={asFilter ? '' : (view.query ?? '')}
            initialFilter={(asFilter ?? 'all') as GearFilter}
          />
        </Shell>
      )
    }

    case 'asset': {
      const asset = store.assetView(view.assetId)
      return (
        <Shell
          view={view}
          title={asset?.name ?? 'Item'}
          subtitle={asset?.code}
          action={
            <button className="icon-btn" onClick={() => go({ name: 'gear' })} aria-label="Back to the gear">
              <Icon name="chevron-left" size={22} />
            </button>
          }
        >
          <Asset asset={asset} photoPairs={store.photoPairs(view.assetId)} />
        </Shell>
      )
    }

    case 'session':
      return <SessionScreen store={store} jobId={view.sessionId} />

    case 'enquiry':
      return (
        <Shell view={view} title="Kit list" subtitle="Paste what the client sent">
          <EnquiryScreen store={store} />
        </Shell>
      )

    case 'import':
      return (
        <Shell view={view} title="Load your gear" subtitle="Paste a list, check it, then add it">
          <ImportScreen store={store} />
        </Shell>
      )

    case 'settings':
      return (
        <Shell
          view={view}
          title="Labels"
          subtitle={`${store.seed.tags.length} tags · print, or open on another screen`}
        >
          <Tags store={store} />
        </Shell>
      )
  }
}
