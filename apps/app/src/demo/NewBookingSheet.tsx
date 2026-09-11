import { useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import { HOUR_MS } from '@papa/core'
import {
  defaultPickupMs,
  defaultReturnMs,
  explainConfirmRefusal,
  fromLocalInput,
  toLocalInput,
} from '../booking-view.ts'
import type { DemoStore } from './store.ts'
import type { CreateBookingResult } from './bookings.ts'
import { STR } from '../strings.ts'

export interface PrefillLine {
  productId: string
  productName: string
  qty: number
}

interface DraftLine {
  productId: string
  name: string
  qty: number
}

/**
 * The desk's "new booking" card — whose, when, what, and pencil or confirm.
 *
 * Two ways in: from an answered kit list (the matched lines arrive
 * prefilled) and as a walk-in from the calendar (the lines are picked from
 * the catalogue here). The customer is REQUIRED, unlike the job sheet: a
 * job can be the nephew's, but a promise is a promise TO someone, and the
 * calendar cannot name a collision against nobody.
 *
 * REFUSALS ARE SENTENCES, NEVER RAW ERRORS. When 'confirm now' meets a
 * unit already promised, the sheet says who holds it ('FX9-02 is already
 * promised to booking #5 (Bilal)') and that the pencil STANDS — the desk
 * fixes the clash on the booking's page, it does not lose the number.
 */
export function NewBookingSheet({
  store,
  prefill = [],
  initialStartMs,
  initialWindow,
  onDone,
  onClose,
}: {
  store: DemoStore
  /** Matched kit-list lines, when the sheet opens from the desk's reader. */
  prefill?: PrefillLine[]
  /** A day tapped on the calendar — the pickup defaults onto it. */
  initialStartMs?: number
  /** The exact dates a quote was priced over — "Book it" keeps them. */
  initialWindow?: { startMs: number; endMs: number }
  /** The booking's id when one was made (the caller lands on its page). */
  onDone: (bookingId: string | null) => void
  onClose: () => void
}) {
  const nowMs = Date.now()
  const pickup0 = initialWindow ? initialWindow.startMs
    : initialStartMs ? initialStartMs + 9 * HOUR_MS : defaultPickupMs(nowMs)
  const return0 = initialWindow ? initialWindow.endMs : defaultReturnMs(pickup0)
  const [who, setWho] = useState<string>('')
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')
  const [start, setStart] = useState(toLocalInput(pickup0))
  const [end, setEnd] = useState(toLocalInput(return0))
  const [lines, setLines] = useState<DraftLine[]>(
    prefill.map((l) => ({ productId: l.productId, name: l.productName, qty: l.qty })),
  )
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<'pencil' | 'confirmed'>('pencil')
  const [note, setNote] = useState('')
  const [problem, setProblem] = useState<string[] | null>(null)

  const customers = store.customers()
  const settings = store.bookingSettings()

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    const taken = new Set(lines.map((l) => l.productId))
    return store.catalogue
      .filter((c) => c.name.toLowerCase().includes(q) && !taken.has(c.id))
      .slice(0, 8)
  }, [store, query, lines])

  const startMs = fromLocalInput(start)
  const endMs = fromLocalInput(end)
  const customerReady = who === 'new' ? newName.trim().length > 0 : who.length > 0
  const ready = customerReady && lines.length > 0 && startMs !== null && endMs !== null && endMs > startMs

  const bump = (productId: string, delta: number) =>
    setLines((prev) =>
      prev
        .map((l) => (l.productId === productId ? { ...l, qty: l.qty + delta } : l))
        .filter((l) => l.qty > 0),
    )

  const create = () => {
    if (!ready || startMs === null || endMs === null) return
    let customerId = who
    if (who === 'new') {
      const id = store.createCustomer(newName.trim(), newPhone.trim() || null)
      if (!id) { setProblem([STR.bookingNewNoCustomer]); return }
      customerId = id
    }
    const result = store.createBooking({
      customerId,
      startMs,
      endMs,
      lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })),
      status: kind,
      note: note.trim() || null,
    }, nowMs)
    const said = explain(result, (id) => store.catalogue.find((c) => c.id === id)?.name ?? id)
    if (said) { setProblem(said); return }
    onDone(result.ok ? result.bookingId : null)
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.bookingNewTitle}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{STR.bookingNewTitle}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>

        {prefill.length > 0 ? (
          <p className="sheet-hint">{STR.bookingNewFromKitList(prefill.length)}</p>
        ) : null}

        <span className="field-label" id="new-booking-customer">{STR.bookingNewCustomerLabel}</span>
        <div className="chip-row" role="group" aria-labelledby="new-booking-customer">
          {customers.map((c) => (
            <button
              key={c.id}
              className={`filter-chip${who === c.id ? ' active' : ''}`}
              aria-pressed={who === c.id}
              onClick={() => setWho(c.id)}
            >
              {c.name}
            </button>
          ))}
          <button
            className={`filter-chip${who === 'new' ? ' active' : ''}`}
            aria-pressed={who === 'new'}
            onClick={() => setWho('new')}
          >
            <Icon name="user" size={14} /> {STR.todayNewCustomer}
          </button>
        </div>
        {who === '' ? <p className="sheet-hint">{STR.bookingNewCustomerNeeded}</p> : null}
        {who === 'new' ? (
          <>
            <label className="field-label" htmlFor="new-booking-cust-name">{STR.bookingNewCustomerNameLabel}</label>
            <input
              id="new-booking-cust-name"
              className="sheet-search"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={STR.todayCustomerNamePlaceholder}
              autoCorrect="off"
              spellCheck={false}
            />
            <label className="field-label" htmlFor="new-booking-cust-phone">{STR.bookingNewCustomerPhoneOptional}</label>
            <input
              id="new-booking-cust-phone"
              className="sheet-search"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              inputMode="tel"
              autoCorrect="off"
              spellCheck={false}
            />
          </>
        ) : null}

        <div className="field-pair">
          <div>
            <label className="field-label" htmlFor="new-booking-start">{STR.bookingNewStartLabel}</label>
            <input
              id="new-booking-start"
              className="sheet-search"
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="new-booking-end">{STR.bookingNewEndLabel}</label>
            <input
              id="new-booking-end"
              className="sheet-search"
              type="datetime-local"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>
        {startMs !== null && endMs !== null && endMs <= startMs ? (
          <p className="sheet-hint">{STR.bookingNewBadPeriod}</p>
        ) : null}

        <span className="field-label">{STR.bookingNewLinesLabel}</span>
        {lines.length === 0 ? <p className="sheet-hint">{STR.bookingNewNoLines}</p> : null}
        <ul className="line-list">
          {lines.map((l) => (
            <li key={l.productId} className="line booking-draft-line">
              <span className="line-name">{l.name}</span>
              <span className="qty-stepper">
                <button
                  className="icon-btn"
                  onClick={() => bump(l.productId, -1)}
                  aria-label={l.qty === 1 ? STR.bookingNewRemoveLineAria(l.name) : STR.bookingNewFewerAria(l.name)}
                >
                  <Icon name={l.qty === 1 ? 'trash' : 'chevron-down'} size={20} />
                </button>
                <span className="code qty-n">{l.qty}</span>
                <button
                  className="icon-btn"
                  onClick={() => bump(l.productId, 1)}
                  aria-label={STR.bookingNewMoreAria(l.name)}
                >
                  <Icon name="arrow-up-right" size={20} />
                </button>
              </span>
            </li>
          ))}
        </ul>
        <input
          className="sheet-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={STR.bookingNewSearchGear}
          aria-label={STR.bookingNewAddLine}
          autoCorrect="off"
          spellCheck={false}
        />
        {query.trim().length > 0 ? (
          results.length === 0 ? (
            <p className="sheet-hint">{STR.bookingNewNothingMatches(query.trim())}</p>
          ) : (
            <ul className="sheet-list">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    className="sheet-row"
                    onClick={() => {
                      setLines((prev) => [...prev, { productId: c.id, name: c.name, qty: 1 }])
                      setQuery('')
                    }}
                  >
                    <span className="sheet-row-name">{c.name}</span>
                    <Icon name="check" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : null}

        <span className="field-label" id="new-booking-kind">{STR.bookingNewKindLabel}</span>
        <div className="chip-row" role="group" aria-labelledby="new-booking-kind">
          <button
            className={`filter-chip${kind === 'pencil' ? ' active' : ''}`}
            aria-pressed={kind === 'pencil'}
            onClick={() => setKind('pencil')}
          >
            {STR.bookingNewPencil}
          </button>
          <button
            className={`filter-chip${kind === 'confirmed' ? ' active' : ''}`}
            aria-pressed={kind === 'confirmed'}
            onClick={() => setKind('confirmed')}
          >
            {STR.bookingNewConfirm}
          </button>
        </div>
        <p className="sheet-hint">
          {kind === 'pencil' ? STR.bookingNewPencilHint(settings.pencilTtlHours) : STR.bookingNewConfirmHint}
        </p>

        <label className="field-label" htmlFor="new-booking-note">{STR.bookingNewNoteLabel}</label>
        <input
          id="new-booking-note"
          className="sheet-search"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder={STR.bookingNewNotePlaceholder}
          autoCorrect="off"
          spellCheck={false}
        />

        {problem ? (
          <div className="notice notice-warn" role="alert">
            <Icon name="warning" size={18} />
            <div>
              {problem.map((p, i) => (i === 0 ? <strong key={i}>{p}</strong> : <p key={i}>{p}</p>))}
            </div>
          </div>
        ) : null}

        <button className="btn btn-primary btn-lg sheet-submit" disabled={!ready} onClick={create}>
          {kind === 'pencil' ? STR.bookingNewCreate : STR.bookingNewCreateConfirmed}
        </button>
      </div>
    </div>
  )
}

/** The refusal as sentences, or null when the create went through. The
 *  create's own refusals are one line each; a confirm refusal is worded
 *  by the Confirm sheet's shared helper, and where it was the calendar
 *  that said no (a collision, a shortfall, the credential gate, a
 *  blacklist) a second line says the pencil stands. */
function explain(r: CreateBookingResult, nameOf: (productId: string) => string): string[] | null {
  if (r.ok) return null
  if ('reason' in r) {
    switch (r.reason) {
      case 'bad_period': return [STR.bookingNewBadPeriod]
      case 'no_lines': return [STR.bookingNewNoLines]
      case 'no_customer': return [STR.bookingNewNoCustomer]
      case 'bad_qty': return [STR.bookingNewNoLines]
      case 'unknown_product': return [STR.bookingNewUnknownProduct]
      case 'consumable': return [STR.bookingNewConsumable(nameOf(r.productId))]
      case 'unknown_asset':
      case 'not_rentable': return [STR.bookingNewUnknownProduct]
    }
  }
  const said = [explainConfirmRefusal(r, r.bookingNo)]
  const pencilStands = 'collision' in r
    || r.reason === 'short' || r.reason === 'needs_credentials' || r.reason === 'blacklisted'
  if (pencilStands) said.push(STR.bookingNewPencilStands(r.bookingNo))
  return said
}
