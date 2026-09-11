import { useEffect, useState } from 'react'
import { whatsAppShareUrl } from '@papa/core'
import { Icon, IconSketchFilter } from '@papa/icons'
import { parseHash, go, type View } from './nav.ts'
import { STR } from './strings.ts'
import { Shell, SettingsButton } from './components/Shell.tsx'
import { TodayScreen } from './demo/TodayScreen.tsx'
import { Gear, type GearFilter } from './routes/Gear.tsx'
import { Asset } from './routes/Asset.tsx'
import { DemoStore } from './demo/store.ts'
import { ScanScreen } from './demo/ScanScreen.tsx'
import { SessionScreen } from './demo/SessionScreen.tsx'
import { DeskScreen } from './demo/DeskScreen.tsx'
import { CalendarScreen } from './demo/CalendarScreen.tsx'
import { BookingScreen } from './demo/BookingScreen.tsx'
import { SettingsScreen } from './demo/SettingsScreen.tsx'
import { ImportScreen } from './demo/ImportScreen.tsx'
import { HisaabScreen } from './demo/HisaabScreen.tsx'
import { KharchaSheet } from './demo/KharchaSheet.tsx'
import { KhataScreen } from './demo/KhataScreen.tsx'
import { OwedScreen } from './demo/OwedScreen.tsx'
import { ClosedJobsScreen } from './demo/ClosedJobsScreen.tsx'
import { GintiScreen } from './demo/GintiScreen.tsx'
import { SwapSheet } from './demo/SwapSheet.tsx'
import { ServicedSheet } from './demo/ServicedSheet.tsx'
import { SehatSection } from './demo/SehatSection.tsx'
// --- network --- (0025)
import { PartnerScreen } from './demo/PartnerScreen.tsx'
import { LendOutSheet } from './demo/LendOutSheet.tsx'
import { PartnerSendSheet } from './demo/PartnerSendSheet.tsx'

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
        <Boot title={STR.commonDbWouldNotStart} detail={failed} />
      ) : store ? (
        <Routed view={view} store={store} />
      ) : (
        <Boot title={STR.commonOpeningWarehouse} />
      )}
    </>
  )
}

/**
 * One asset's page, plus the repair door (0019): "Repair cost" opens the
 * kharcha sheet with the kind locked to repair and THIS unit pre-wired, so
 * the workshop bill lands in the unit's cost history and the payback bar's
 * denominator in one write. `tick` re-reads the money facts after it.
 */
function AssetRoute({ store, assetId }: { store: DemoStore; assetId: string }) {
  const [tick, setTick] = useState(0)
  const [repairing, setRepairing] = useState(false)
  const [swapping, setSwapping] = useState(false)
  const [servicing, setServicing] = useState(false)
  // --- network --- the lend door and the partner broadcast (0025).
  const [lending, setLending] = useState(false)
  const [telling, setTelling] = useState(false)
  const bump = () => setTick((t) => t + 1)

  // tick is read so the lint stays honest that a re-render is the point — the
  // fleet writes below mutate the mirror in place, and bump() re-reads it.
  void tick
  const asset = store.assetView(assetId)
  // The unit's money facts — ledger earnings, the payback bar (its
  // denominator now carries the unit's repairs), and the month's
  // turned-away count for its product (the buy signal).
  const money = asset
    ? {
        ...store.assetEarnings(assetId),
        turnedAwayTimes: asset.productId
          ? store.turnedAwayFor(asset.productId).times
          : 0,
      }
    : null
  return (
    <Shell
      view={{ name: 'asset', assetId }}
      title={asset?.name ?? STR.gearItemFallback}
      subtitle={asset?.code}
      action={
        <>
          <button className="icon-btn" onClick={() => go({ name: 'gear' })} aria-label={STR.gearBackToTheGearAria}>
            <Icon name="chevron-left" size={22} />
          </button>
          <SettingsButton />
        </>
      }
    >
      <Asset
        asset={asset}
        money={money}
        promised={store.promisedSoon(assetId)}
        service={store.serviceFacts(assetId)}
        voiceNotes={store.voiceNotesFor(assetId)}
        photoPairs={store.photoPairs(assetId)}
        onProveIt={() => {
          const text = store.proveItText(assetId)
          if (!text) return
          // Same fallback pair as every share in the app: WhatsApp where
          // it exists, clipboard where it does not.
          const win = window.open(whatsAppShareUrl(text), '_blank', 'noopener')
          if (!win) void navigator.clipboard?.writeText(text).catch(() => {})
        }}
        onRepairCost={() => setRepairing(true)}
        onServiced={() => setServicing(true)}
        onVoiceSave={(rec) => {
          const r = store.captureVoiceNote({
            assetId,
            durationMs: rec.durationMs,
            dataUri: rec.dataUri,
            bytes: rec.bytes,
            mime: rec.mime,
          })
          bump()
          return r.ok ? { ok: true as const } : { ok: false as const, waiting: r.waiting }
        }}
        onMarkTerminal={(disposition, note, saleMinor) => {
          store.markTerminal(assetId, disposition, { note, saleAmountMinor: saleMinor })
          bump()
        }}
        onFound={() => { store.markFound(assetId); bump() }}
        onTheftReport={() => {
          const text = store.theftReportText(assetId)
          if (!text) return
          const win = window.open(whatsAppShareUrl(text), '_blank', 'noopener')
          if (!win) void navigator.clipboard?.writeText(text).catch(() => {})
        }}
        onSwap={() => setSwapping(true)}
        // --- network --- (0025): lend an owned unit; tell the partner
        // houses about a stolen one; name the house a borrowed one is from.
        onLend={store.lendable(assetId) ? () => setLending(true) : undefined}
        onTellPartners={store.stolenBroadcastFacts(assetId) ? () => setTelling(true) : undefined}
        borrowedFrom={store.subHireForAsset(assetId)}
      />
      {lending && asset ? (
        <LendOutSheet
          store={store}
          asset={{ id: assetId, code: asset.code, productId: asset.productId, name: asset.name }}
          onDone={() => { setLending(false); go({ name: 'jobs' }) }}
          onClose={() => setLending(false)}
        />
      ) : null}
      {telling && asset ? (
        <PartnerSendSheet
          title={STR.networkTellPartners}
          hint={STR.networkTellPartnersHint}
          partners={store.partners()}
          text={store.stolenBroadcastText(assetId) ?? ''}
          above={
            store.stolenBroadcastFacts(assetId)?.publicUrl
              ? null
              : <p className="sheet-hint">{STR.networkTellPartnersNoPage}</p>
          }
          onClose={() => setTelling(false)}
        />
      ) : null}
      {repairing && asset ? (
        <KharchaSheet
          title={STR.kharchaRepairCost}
          hint={STR.kharchaForAsset(asset.code)}
          fixedKind="repair"
          onSave={(input) => {
            store.recordExpense({ ...input, assetId }, input.whenMs)
            setRepairing(false)
            bump()
          }}
          onClose={() => setRepairing(false)}
        />
      ) : null}
      {servicing && asset ? (
        <ServicedSheet
          assetCode={asset.code}
          onSave={(input) => {
            store.recordServiced(assetId, input)
            setServicing(false)
            bump()
          }}
          onClose={() => setServicing(false)}
        />
      ) : null}
      {swapping && asset ? (
        <SwapSheet
          brokenCode={asset.code}
          jobLabel={asset.jobLabel ?? STR.gearOutFallback}
          substitutes={store.substitutesFor(assetId)}
          onPick={(substituteId) => {
            store.swapOntoJob(assetId, substituteId)
            setSwapping(false)
            bump()
          }}
          onClose={() => setSwapping(false)}
        />
      ) : null}
    </Shell>
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
        <Shell view={view} title={STR.gearTitle} subtitle={STR.gearSubtitle} action={<SettingsButton />}>
          <Gear
            rows={store.gearRows()}
            initialQuery={asFilter ? '' : (view.query ?? '')}
            initialFilter={(asFilter ?? 'all') as GearFilter}
          />
          {/* Sehat (0021): the fleet's health — service due, cycle
              ceilings, dead stock — on the search surface because fleet
              health is a gear question, beside the ginti it feeds. */}
          <SehatSection sehat={store.sehat()} />
          {/* The smallest honest door to finished jobs: off the boards is
              not gone. Lives on the search surface because "where did that
              job go" is a search question. */}
          <div className="session-actions">
            {/* Ginti lives on the search surface because a stocktake is a
                "walk the shelves" job, reached from where the gear lives. */}
            <button className="btn btn-ghost btn-block" onClick={() => go({ name: 'ginti' })}>
              <Icon name="scan" size={18} /> {STR.fleetGinti}
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => go({ name: 'closed' })}>
              <Icon name="clipboard-check" size={18} /> {STR.closedJobsDoor}
            </button>
          </div>
        </Shell>
      )
    }

    case 'asset':
      // KEYED like the scanner: the repair sheet and the refresh tick live
      // in instance state, and moving between two assets must not carry an
      // open sheet (wired to the WRONG unit) across.
      return <AssetRoute key={view.assetId} store={store} assetId={view.assetId} />

    case 'session':
      return <SessionScreen store={store} jobId={view.sessionId} />

    case 'hisaab':
      return <HisaabScreen store={store} />

    case 'customer':
      // KEYED for the same reason the scanner is: the payment sheet, the
      // copied flag and the tick all live in instance state, and React
      // reuses the instance when only props change — without the key,
      // moving between two customers would carry one khata's open sheet
      // onto the other's page.
      return <KhataScreen key={view.customerId} store={store} customerId={view.customerId} />

    case 'owed':
      return <OwedScreen store={store} />

    case 'closed':
      return <ClosedJobsScreen store={store} />

    case 'desk':
      return <DeskScreen store={store} />

    case 'calendar':
      return <CalendarScreen store={store} />

    case 'booking':
      // KEYED like the customer page: the open sheets and the tick live in
      // instance state, and two bookings must never share one.
      return <BookingScreen key={view.bookingId} store={store} bookingId={view.bookingId} />

    case 'import':
      return (
        <Shell view={view} title={STR.labelsLoadYourGear} subtitle={STR.labelsImportSubtitle}>
          <ImportScreen store={store} />
        </Shell>
      )

    case 'ginti':
      return (
        <Shell view={view} title={STR.fleetGinti} subtitle={STR.fleetGintiSubtitle}>
          <GintiScreen store={store} />
        </Shell>
      )

    case 'settings':
      return <SettingsScreen store={store} />

    // --- network --- (0025). KEYED like the customer page: the sheets and
    // the tick live in instance state, and two partners must not share one.
    case 'partner':
      return <PartnerScreen key={view.partnerId} store={store} partnerId={view.partnerId} />
  }
}
