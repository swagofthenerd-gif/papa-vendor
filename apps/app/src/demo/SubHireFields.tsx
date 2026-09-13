import { useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import type { CatalogueItem } from '@papa/core'
import type { PartnerRow } from './network.ts'
import { STR } from '../strings.ts'

/**
 * The fields the two sub-hire sheets share (SubHireInSheet, LendOutSheet):
 * the partner as chips, the product by search with the pick shown as a
 * clearable chip, the from/until pair, and the one reading of an optional
 * rupees field. One home, so borrowing and lending cannot drift into two
 * spellings of the same form.
 */

/** A blank field is 'unpriced' (null), never zero; a number is paisa. */
export function optionalRupeesMinor(text: string): number | null {
  const rupees = Number(text)
  return text.trim().length > 0 && Number.isFinite(rupees) ? Math.round(rupees * 100) : null
}

/** The partner houses as one-of chips, with the honest line when there
 *  are none to pick. `id` labels the group for the screen reader. */
export function PartnerChips({
  id,
  label,
  partners,
  value,
  onChange,
}: {
  id: string
  label: string
  partners: PartnerRow[]
  value: string
  onChange: (partnerId: string) => void
}) {
  return (
    <>
      <span className="field-label" id={id}>{label}</span>
      <div className="chip-row" role="group" aria-labelledby={id}>
        {partners.map((p) => (
          <button
            key={p.id}
            className={`filter-chip${value === p.id ? ' active' : ''}`}
            aria-pressed={value === p.id}
            onClick={() => onChange(p.id)}
          >
            {p.name}
          </button>
        ))}
      </div>
      {partners.length === 0 ? <p className="sheet-hint">{STR.networkAskMarketNoPartners}</p> : null}
    </>
  )
}

/**
 * The product: a catalogue search (like the booking sheet's) until one is
 * picked, then the pick as a chip whose × clears it. The search text lives
 * here — nothing outside needs it.
 */
export function ProductPicker({
  id,
  catalogue,
  productName,
  onPick,
  onClear,
}: {
  id: string
  catalogue: CatalogueItem[]
  /** The picked product's name, or null while searching. */
  productName: string | null
  onPick: (productId: string) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState('')
  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return []
    return catalogue.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 8)
  }, [catalogue, query])

  return (
    <>
      <label className="field-label" htmlFor={id}>{STR.networkSubHireProductLabel}</label>
      {productName ? (
        <div className="chip-row">
          <button className="filter-chip active" aria-pressed onClick={onClear}>
            {productName} <Icon name="x" size={12} />
          </button>
        </div>
      ) : (
        <>
          <input
            id={id}
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
                  <button className="sheet-row" onClick={() => { onPick(c.id); setQuery('') }}>
                    <span>{c.name}</span>
                    <Icon name="chevron-right" size={16} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </>
  )
}

/** From / until as datetime-local, ids `${idPrefix}-start` and `-end`. */
export function PeriodFields({
  idPrefix,
  start,
  end,
  onStart,
  onEnd,
}: {
  idPrefix: string
  start: string
  end: string
  onStart: (value: string) => void
  onEnd: (value: string) => void
}) {
  return (
    <div className="field-pair">
      <div>
        <label className="field-label" htmlFor={`${idPrefix}-start`}>{STR.networkSubHireStartLabel}</label>
        <input id={`${idPrefix}-start`} className="sheet-search" type="datetime-local" value={start} onChange={(e) => onStart(e.target.value)} />
      </div>
      <div>
        <label className="field-label" htmlFor={`${idPrefix}-end`}>{STR.networkSubHireEndLabel}</label>
        <input id={`${idPrefix}-end`} className="sheet-search" type="datetime-local" value={end} onChange={(e) => onEnd(e.target.value)} />
      </div>
    </div>
  )
}
