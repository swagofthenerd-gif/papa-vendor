import { useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import { DAY_MS } from '@papa/core'
import { fromLocalInput, toLocalInput } from '../booking-view.ts'
import { PartnerChips, PeriodFields, ProductPicker, optionalRupeesMinor } from './SubHireFields.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * Lend gear to a partner — sub-hire OUT (0025 D3/D4/D6).
 *
 * Partner as chips, then either a named unit (arriving pre-wired from an
 * asset page's "Lend to a partner") or a product by search with a
 * specific unit picked from the lendable ones — owned, in the fleet, on
 * the shelf — or "whichever is free". Dates, the agreed charge (blank is
 * unpriced; a number lands on their khata), a note. One button. Success
 * lands on the Today board, where the 'Sub-hire → X' job sits in Going
 * out wearing the SUB-HIRE stamp, waiting to be scanned onto.
 */
export function LendOutSheet({
  store,
  asset,
  partnerId: initialPartner,
  onDone,
  onClose,
}: {
  store: DemoStore
  /** A unit to lend, when the door was on its page. */
  asset: { id: string; code: string; productId: string | null; name: string } | null
  partnerId?: string | null
  onDone: (jobId: string, label: string) => void
  onClose: () => void
}) {
  const partners = store.partners()
  const nowMs = Date.now()
  const [partnerId, setPartnerId] = useState<string>(initialPartner ?? partners[0]?.id ?? '')
  const [productId, setProductId] = useState<string | null>(asset?.productId ?? null)
  const [assetId, setAssetId] = useState<string | null>(asset?.id ?? null)
  const [qty, setQty] = useState('1')
  const [start, setStart] = useState(toLocalInput(nowMs))
  const [end, setEnd] = useState(toLocalInput(nowMs + DAY_MS))
  const [charge, setCharge] = useState('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const productName = productId ? (store.catalogue.find((c) => c.id === productId)?.name ?? asset?.name ?? null) : null
  const units = useMemo(() => (productId && !asset ? store.lendableUnits(productId) : []), [store, productId, asset])

  const startMs = fromLocalInput(start)
  const endMs = fromLocalInput(end)
  const ready = partnerId.length > 0 && (assetId !== null || productId !== null) && startMs !== null && endMs !== null

  const lend = () => {
    if (!ready || startMs === null || endMs === null) return
    const r = store.recordSubHireOut({
      partnerId,
      startMs,
      endMs,
      assetId,
      productId,
      qty: assetId ? 1 : Number(qty),
      agreedChargeMinor: optionalRupeesMinor(charge),
      note: note.trim() || null,
    })
    if (!r.ok) { setProblem(STR.networkSubHireRefusal(r.reason)); return }
    onDone(r.jobId, r.jobLabel)
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.networkLendTitle}>
      <div className="sheet sheet-tall">
        <header className="sheet-head">
          <span className="sheet-title">{STR.networkLendTitle}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>
        <p className="sheet-hint">{STR.networkLendHint}</p>

        <PartnerChips
          id="lend-partner"
          label={STR.networkLendPartnerLabel}
          partners={partners}
          value={partnerId}
          onChange={setPartnerId}
        />

        {asset ? (
          <>
            <label className="field-label" htmlFor="lend-product">{STR.networkSubHireProductLabel}</label>
            <p className="sheet-hint code">{asset.code} · {asset.name}</p>
          </>
        ) : (
          <ProductPicker
            id="lend-product"
            catalogue={store.catalogue}
            productName={productName}
            onPick={setProductId}
            onClear={() => { setProductId(null); setAssetId(null) }}
          />
        )}

        {productId && !asset ? (
          <>
            <span className="field-label" id="lend-unit">{STR.networkSubHireUnitLabel}</span>
            <div className="chip-row" role="group" aria-labelledby="lend-unit">
              <button
                className={`filter-chip${assetId === null ? ' active' : ''}`}
                aria-pressed={assetId === null}
                onClick={() => setAssetId(null)}
              >
                {STR.networkSubHireAnyUnit(Number(qty) || 1, productName ?? '')}
              </button>
              {units.map((u) => (
                <button
                  key={u.id}
                  className={`filter-chip code${assetId === u.id ? ' active' : ''}`}
                  aria-pressed={assetId === u.id}
                  onClick={() => { setAssetId(u.id); setQty('1') }}
                >
                  {u.code}
                </button>
              ))}
            </div>
            {assetId === null ? (
              <>
                <label className="field-label" htmlFor="lend-qty">{STR.networkSubHireQtyLabel}</label>
                <input
                  id="lend-qty"
                  className="sheet-search code"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                />
              </>
            ) : null}
          </>
        ) : null}

        <PeriodFields idPrefix="lend" start={start} end={end} onStart={setStart} onEnd={setEnd} />

        <label className="field-label" htmlFor="lend-charge">{STR.networkSubHireChargeLabel}</label>
        <input
          id="lend-charge"
          className="sheet-search code"
          type="number"
          inputMode="decimal"
          min="0"
          value={charge}
          onChange={(e) => setCharge(e.target.value)}
        />
        <p className="sheet-hint">{STR.networkSubHireChargeHint}</p>

        <label className="field-label" htmlFor="lend-note">{STR.networkSubHireNoteLabel}</label>
        <input
          id="lend-note"
          className="sheet-search"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoCorrect="off"
          spellCheck={false}
        />

        {problem ? (
          <div className="notice notice-warn" role="alert">
            <Icon name="warning" size={18} />
            <div><strong>{problem}</strong></div>
          </div>
        ) : null}

        <button className="btn btn-primary btn-lg sheet-submit" disabled={!ready} onClick={lend}>
          <Icon name="truck" size={18} /> {STR.networkLendRecord}
        </button>
      </div>
    </div>
  )
}
