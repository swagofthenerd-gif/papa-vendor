import { useState } from 'react'
import { Icon } from '@papa/icons'
import { STR } from '../strings.ts'
import type { JobCustomerChoice } from './store.ts'

/**
 * The desk's "make a job" card — the same three fields, plus WHOSE job it is.
 *
 * Used two ways: from an answered kit list (the lines come along and become
 * the promised set) and as the Today board's walk-in path (no lines; the
 * gear gets scanned onto it at the dock, which is how a walk-in actually
 * happens). Only the label is required, because a job with no name cannot be
 * found on the board thirty seconds later; contact and due date are typed
 * when they are known and honestly absent when they are not — an empty date
 * renders as 'no date', never as a guess.
 *
 * THE CUSTOMER PICKER is the year simulation's #1 finding made into a
 * control (`no-customer-on-desk-job`): without it, every job born at the
 * desk was unchargeable forever and the money book only worked for seeded
 * customers. Optional on purpose — the nephew case stays legal — but the
 * sheet says plainly what "no customer" costs, so the omission is a choice
 * rather than a trap. Choices are full-width rows, not a dropdown: gloved
 * thumbs get targets, and the "new customer" path is two fields inline, not
 * a detour to another screen the walk-in queue has no time for.
 */
export function NewJobSheet({
  linesNote,
  customers,
  onCreate,
  onClose,
}: {
  /** What the promised set will be, when created from a kit list. */
  linesNote?: string
  /** Every known customer, for the picker — the owed list's own rows. */
  customers: { id: string; name: string; phone: string | null }[]
  onCreate: (input: {
    label: string
    contact: string | null
    expectedBack: string | null
    customer: JobCustomerChoice
  }) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const [contact, setContact] = useState('')
  const [expectedBack, setExpectedBack] = useState('')
  // 'none' | 'new' | an existing customer id.
  const [who, setWho] = useState<string>('none')
  const [newName, setNewName] = useState('')
  const [newPhone, setNewPhone] = useState('')

  const customer: JobCustomerChoice =
    who === 'none'
      ? null
      : who === 'new'
        ? { kind: 'new', name: newName.trim(), phone: newPhone.trim() || null }
        : { kind: 'existing', id: who }

  // A "new customer" choice with no name yet is not creatable — a nameless
  // khata can never be found again — so the button waits for the name.
  const customerReady = who !== 'new' || newName.trim().length > 0

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.todayNewJob}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{STR.todayNewJob}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>

        {linesNote ? <p className="sheet-hint">{linesNote}</p> : null}

        <label className="field-label" htmlFor="new-job-label">{STR.todayWhatIsTheJob}</label>
        <input
          id="new-job-label"
          className="sheet-search"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={STR.todayJobLabelPlaceholder}
          autoFocus
          autoCorrect="off"
          spellCheck={false}
        />

        <span className="field-label" id="new-job-customer-label">
          {STR.todayCustomerOptional}
        </span>
        <div
          className="chip-row"
          role="group"
          aria-labelledby="new-job-customer-label"
        >
          <button
            className={`filter-chip${who === 'none' ? ' active' : ''}`}
            aria-pressed={who === 'none'}
            onClick={() => setWho('none')}
          >
            {STR.todayNoCustomer}
          </button>
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
        {who === 'none' ? (
          /* The cost of the omission, said out loud — the choice stays. */
          <p className="sheet-hint">{STR.todayNoCustomerHint}</p>
        ) : null}

        {who === 'new' ? (
          <>
            <label className="field-label" htmlFor="new-job-cust-name">
              {STR.todayCustomerNameLabel}
            </label>
            <input
              id="new-job-cust-name"
              className="sheet-search"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={STR.todayCustomerNamePlaceholder}
              autoCorrect="off"
              spellCheck={false}
            />
            <label className="field-label" htmlFor="new-job-cust-phone">
              {STR.todayCustomerPhoneOptional}
            </label>
            <input
              id="new-job-cust-phone"
              className="sheet-search"
              value={newPhone}
              onChange={(e) => setNewPhone(e.target.value)}
              inputMode="tel"
              autoCorrect="off"
              spellCheck={false}
            />
          </>
        ) : null}

        <label className="field-label" htmlFor="new-job-contact">{STR.todayContactOptional}</label>
        <input
          id="new-job-contact"
          className="sheet-search"
          value={contact}
          onChange={(e) => setContact(e.target.value)}
          placeholder={STR.todayContactPlaceholder}
          autoCorrect="off"
          spellCheck={false}
        />

        <label className="field-label" htmlFor="new-job-back">{STR.todayExpectedBackOptional}</label>
        <input
          id="new-job-back"
          className="sheet-search"
          type="date"
          value={expectedBack}
          onChange={(e) => setExpectedBack(e.target.value)}
        />

        <button
          className="btn btn-primary btn-lg sheet-submit"
          disabled={label.trim().length === 0 || !customerReady}
          onClick={() =>
            onCreate({
              label: label.trim(),
              contact: contact.trim() || null,
              expectedBack: expectedBack || null,
              customer,
            })
          }
        >
          {STR.todayCreateJob}
        </button>
      </div>
    </div>
  )
}
