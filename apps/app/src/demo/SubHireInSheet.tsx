import { useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import { go } from '../nav.ts'
import { fromLocalInput, toLocalInput } from '../booking-view.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

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
  const [query, setQuery] = useState('')
  const [qty, setQty] = useState(String(prefill?.qty ?? 1))
  const [start, setStart] = useState(toLocalInput(prefill?.startMs ?? nowMs))
  const [end, setEnd] = useState(toLocalInput(prefill?.endMs ?? nowMs + 24 * 3_600_000))
  const [serial, setSerial] = useState('')
  const [cost, setCost] = useState('')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<{ id: string; code: string | null; partner: string } | null>(null)

  const productName = productId ? (store.catalogue.find((c) => c.id === productId)?.name ?? null) : null
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    return store.catalogue.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
  }, [store, query])

  const startMs = fromLocalInput(start)
  const endMs = fromLocalInput(end)
  const rupees = Number(cost)
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
      agreedCostMinor: cost.trim().length > 0 && Number.isFinite(rupees) ? Math.round(rupees * 100) : null,
      bookingId: prefill?.bookingId ?? null,
      jobId: prefill?.jobId ?? null,
      note: note.trim() || null,
    })
    if (!r.ok) { setProblem(STR.networkSubHireRefusal(r.reason)); return }
    setDone({ id: r.subHireId, code: r.assetCode, partner: r.partnerName })
  }

  if (done) {
    return (
      <div className="sheet-backdrop" role="dialog" aria-label={STR.networkSubHireInTitle}>
        <div className="sheet">
          <header className="sheet-head">
            <span className="sheet-title">{STR.networkSubHireInTitle}</span>
            <button className="icon-btn" onClick={() => onDone(done.id)} aria-label={STR.commonClose}>
              <Icon name="x" size={22} />
            </button>
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
        </div>
      </div>
    )
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.networkSubHireInTitle}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{STR.networkSubHireInTitle}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>
        <p className="sheet-hint">{STR.networkSubHireInHint}</p>

        <span className="field-label" id="sub-hire-partner">{STR.networkSubHireFromLabel}</span>
        <div className="chip-row" role="group" aria-labelledby="sub-hire-partner">
          {partners.map((p) => (
            <button
              key={p.id}
              className={`filter-chip${partnerId === p.id ? ' active' : ''}`}
              aria-pressed={partnerId === p.id}
              onClick={() => setPartnerId(p.id)}
            >
              {p.name}
            </button>
          ))}
        </div>
        {partners.length === 0 ? <p className="sheet-hint">{STR.networkAskMarketNoPartners}</p> : null}

        <label className="field-label" htmlFor="sub-hire-product">{STR.networkSubHireProductLabel}</label>
        {productName ? (
          <div className="chip-row">
            <button className="filter-chip active" aria-pressed onClick={() => setProductId(null)}>
              {productName} <Icon name="x" size={12} />
            </button>
          </div>
        ) : (
          <>
            <input
              id="sub-hire-product"
              className="sheet-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={STR.networkSubHireProductSearch}
              aria-label={STR.networkSubHireProductSearchAria}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
            />
            {results.length > 0 ? (
              <ul className="sheet-list">
                {results.map((c) => (
                  <li key={c.id}>
                    <button className="sheet-row" onClick={() => { setProductId(c.id); setQuery('') }}>
                      <span>{c.name}</span>
                      <Icon name="chevron-right" size={16} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}

        <div className="field-pair">
          <div>
            <label className="field-label" htmlFor="sub-hire-start">{STR.networkSubHireStartLabel}</label>
            <input id="sub-hire-start" className="sheet-search" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div>
            <label className="field-label" htmlFor="sub-hire-end">{STR.networkSubHireEndLabel}</label>
            <input id="sub-hire-end" className="sheet-search" type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>

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
      </div>
    </div>
  )
}
