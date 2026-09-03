import { useState } from 'react'
import { Icon } from '@papa/icons'
import { STR } from '../strings.ts'

/**
 * The desk's "make a job" card — three fields, none clever.
 *
 * Used two ways: from an answered kit list (the lines come along and become
 * the promised set) and as the Today board's walk-in path (no lines; the
 * gear gets scanned onto it at the dock, which is how a walk-in actually
 * happens). Only the label is required, because a job with no name cannot be
 * found on the board thirty seconds later; contact and due date are typed
 * when they are known and honestly absent when they are not — an empty date
 * renders as 'no date', never as a guess.
 */
export function NewJobSheet({
  linesNote,
  onCreate,
  onClose,
}: {
  /** What the promised set will be, when created from a kit list. */
  linesNote?: string
  onCreate: (input: { label: string; contact: string | null; expectedBack: string | null }) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState('')
  const [contact, setContact] = useState('')
  const [expectedBack, setExpectedBack] = useState('')

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
          disabled={label.trim().length === 0}
          onClick={() =>
            onCreate({
              label: label.trim(),
              contact: contact.trim() || null,
              expectedBack: expectedBack || null,
            })
          }
        >
          {STR.todayCreateJob}
        </button>
      </div>
    </div>
  )
}
