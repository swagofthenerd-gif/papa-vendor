import { useState } from 'react'
import { Icon } from '@papa/icons'
import { DAY_MS } from '@papa/core'
import { go } from '../nav.ts'
import { fromLocalInput, toLocalInput } from '../booking-view.ts'
import { PartnerChips, PeriodFields, ProductPicker, optionalRupeesMinor } from './SubHireFields.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'
import { Sheet, SheetClose } from '../components/Sheet.tsx'

export interface SubHireInPrefill {
  productId?: string | null
  qty?: number
  startMs?: number
  endMs?: number
  partnerId?: string | null
  bookingId?: string | null
  jobId?: string | null
}

/**
 * Record a sub-hire IN — gear borrowed from a partner (0025 D2/D5/D6).
 *
 * Partner as chips, product by search (the catalogue, like the booking
 * sheet), the dates, the count, and three optional facts: a serial (the
 * unit is then created as borrowed — tag-able, scan-able, counted), the
 * agreed cost (blank means unpriced, never zero), a note. The refusals
 * are the store's, rendered as a notice; nothing writes until the one
 * button. Success shows the new unit's code and the label door: the
 * lookup scanner attaches an unknown label to a unit.
 */
export function SubHireInSheet({
  store,
  prefill,
  onDone,
  onClose,
}: {
  store: DemoStore
  prefill: SubHireInPrefill | null
  onDone: (subHireId: string) => void
  onClose: () => void
}) {
  const partners = store.partners()
  const nowMs = Date.now()
  const [partnerId, setPartnerId] = useState<string>(prefill?.partnerId ?? partners[0]?.id ?? '')
  const [productId, setProductId] = useState<string | null>(prefill?.productId ?? null)
  const [qty, setQty] = useState(String(prefill?.qty ?? 1))
  const [start, setStart] = useState(toLocalInput(prefill?.startMs ?? nowMs))
  const [end, setEnd] = useState(toLocalInput(prefill?.endMs ?? nowMs + DAY_MS))
  const [serial, setSerial] = useState('')
  const [cost, setCost] = useState('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<{ id: string; code: string | null; partner: string } | null>(null)

  const productName = productId ? (store.catalogue.find((c) => c.id === productId)?.name ?? null) : null

  const startMs = fromLocalInput(start)
  const endMs = fromLocalInput(end)
  const ready = partnerId.length > 0 && productId !== null && startMs !== null && endMs !== null

  const record = () => {
    if (!ready || startMs === null || endMs === null || productId === null) return
    const r = store.recordSubHireIn({
      partnerId,
      productId,
      startMs,
      endMs,
      qty: Number(qty),
      serial: serial.trim() || null,
      agreedCostMinor: optionalRupeesMinor(cost),
      bookingId: prefill?.bookingId ?? null,
      jobId: prefill?.jobId ?? null,
      note: note.trim() || null,
    })
    if (!r.ok) { setProblem(STR.networkSubHireRefusal(r.reason)); return }
    setDone({ id: r.subHireId, code: r.assetCode, partner: r.partnerName })
  }

  if (done) {
    return (
      <Sheet label={STR.networkSubHireInTitle} onClose={() => onDone(done.id)} tall>
        <header className="sheet-head">
          <span className="sheet-title">{STR.networkSubHireInTitle}</span>
          <SheetClose />
        </header>
        <div className="notice notice-ok">
          <Icon name="check-circle" size={18} />
          <div>
            <strong>
              {done.code
                ? STR.networkSubHireInDone(done.code, done.partner)
                : STR.networkSubHireInDoneNoUnit(done.partner)}
            </strong>
          </div>
        </div>
        {done.code ? <p className="asset-code code sub-hire-code">{done.code}</p> : null}
        <div className="session-actions">
          {done.code ? (
            <button
              className="btn btn-outline btn-block"
              onClick={() => go({ name: 'scan', jobId: 'lookup', mode: 'lookup' })}
            >
              <Icon name="tag" size={18} /> {STR.networkSubHireAttachLabel}
            </button>
          ) : null}
          <button className="btn btn-primary btn-block" onClick={() => onDone(done.id)}>
            {STR.commonClose}
          </button>
        </div>
      </Sheet>
    )
  }

  return (
    <Sheet label={STR.networkSubHireInTitle} onClose={onClose} tall>
      <header className="sheet-head">
        <span className="sheet-title">{STR.networkSubHireInTitle}</span>
        <SheetClose />
      </header>
      <p className="sheet-hint">{STR.networkSubHireInHint}</p>

      <PartnerChips
        id="sub-hire-partner"
        label={STR.networkSubHireFromLabel}
        partners={partners}
        value={partnerId}
        onChange={setPartnerId}
      />

      <ProductPicker
        id="sub-hire-product"
        catalogue={store.catalogue}
        productName={productName}
        onPick={setProductId}
        onClear={() => setProductId(null)}
      />

      <PeriodFields idPrefix="sub-hire" start={start} end={end} onStart={setStart} onEnd={setEnd} />

      <label className="field-label" htmlFor="sub-hire-qty">{STR.networkSubHireQtyLabel}</label>
      <input
        id="sub-hire-qty"
        className="sheet-search code"
        type="number"
        inputMode="numeric"
        min="1"
        value={qty}
        onChange={(e) => setQty(e.target.value)}
      />

      <label className="field-label" htmlFor="sub-hire-serial">{STR.networkSubHireSerialLabel}</label>
      <input
        id="sub-hire-serial"
        className="sheet-search code"
        value={serial}
        onChange={(e) => setSerial(e.target.value)}
        autoCorrect="off"
        autoCapitalize="characters"
        spellCheck={false}
      />
      <p className="sheet-hint">{STR.networkSubHireSerialHint}</p>

      <label className="field-label" htmlFor="sub-hire-cost">{STR.networkSubHireCostLabel}</label>
      <input
        id="sub-hire-cost"
        className="sheet-search code"
        type="number"
        inputMode="decimal"
        min="0"
        value={cost}
        onChange={(e) => setCost(e.target.value)}
      />
      <p className="sheet-hint">{STR.networkSubHireCostHint}</p>

      <label className="field-label" htmlFor="sub-hire-note">{STR.networkSubHireNoteLabel}</label>
      <input
        id="sub-hire-note"
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

      <button className="btn btn-primary btn-lg sheet-submit" disabled={!ready} onClick={record}>
        <Icon name="handshake" size={18} /> {STR.networkSubHireRecord}
      </button>
    </Sheet>
  )
}
