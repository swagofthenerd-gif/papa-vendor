import { useState } from 'react'
import { Icon } from '@papa/icons'
import type { DemoStore } from './store.ts'
import type { PartnerRow } from './network.ts'
import { STR } from '../strings.ts'

/**
 * Add or edit a partner house — four fields and one button. Plain and
 * fast: the desk types "Kamran Rentals, 0301 …" between two calls. On
 * edit a cleared field KEEPS its old value (the RPC's rule, so a slip of
 * the thumb cannot blank a number); the name is the one thing required,
 * and one spelling per house is the store's refusal, rendered here.
 */
export function PartnerSheet({
  store,
  existing,
  onSaved,
  onClose,
}: {
  store: DemoStore
  existing: PartnerRow | null
  onSaved: (id: string) => void
  onClose: () => void
}) {
  const [name, setName] = useState(existing?.name ?? '')
  const [phone, setPhone] = useState(existing?.phone ?? '')
  const [city, setCity] = useState(existing?.city ?? 'Lahore')
  const [notes, setNotes] = useState(existing?.notes ?? '')
  const [problem, setProblem] = useState<string | null>(null)

  const save = () => {
    const r = store.upsertPartner({
      id: existing?.id ?? null,
      name,
      phone: phone.trim() || null,
      city: city.trim() || null,
      notes: notes.trim() || null,
    })
    if (!r.ok) {
      setProblem(
        r.reason === 'blank_name' ? STR.networkPartnerBlankName
          : r.reason === 'duplicate_name' ? STR.networkPartnerDuplicate
            : STR.networkPartnerNotFound,
      )
      return
    }
    onSaved(r.id)
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.networkPartnerSheetTitle}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{STR.networkPartnerSheetTitle}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>

        <label className="field-label" htmlFor="partner-name">{STR.networkPartnerNameLabel}</label>
        <input
          id="partner-name"
          className="sheet-search"
          value={name}
          onChange={(e) => { setName(e.target.value); setProblem(null) }}
          autoCorrect="off"
          spellCheck={false}
          autoFocus
        />

        <label className="field-label" htmlFor="partner-phone">{STR.networkPartnerPhoneLabel}</label>
        <input
          id="partner-phone"
          className="sheet-search code"
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />

        <label className="field-label" htmlFor="partner-city">{STR.networkPartnerCityLabel}</label>
        <input
          id="partner-city"
          className="sheet-search"
          value={city}
          onChange={(e) => setCity(e.target.value)}
          autoCorrect="off"
          spellCheck={false}
        />

        <label className="field-label" htmlFor="partner-notes">{STR.networkPartnerNoteLabel}</label>
        <input
          id="partner-notes"
          className="sheet-search"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder={STR.networkPartnerNotePlaceholder}
          autoCorrect="off"
          spellCheck={false}
        />

        {problem ? (
          <div className="notice notice-warn" role="alert">
            <Icon name="warning" size={18} />
            <div><strong>{problem}</strong></div>
          </div>
        ) : null}

        <button
          className="btn btn-primary btn-lg sheet-submit"
          disabled={name.trim().length === 0}
          onClick={save}
        >
          <Icon name="handshake" size={18} /> {STR.networkPartnerSave}
        </button>
      </div>
    </div>
  )
}
