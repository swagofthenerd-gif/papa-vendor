import { useState } from 'react'
import { EXPENSE_KINDS, type ExpenseKind } from '@papa/core'
import { STR } from '../strings.ts'
import { Sheet, SheetClose } from '../components/Sheet.tsx'

/**
 * The kharcha entry sheet — money the house paid OUT, written as a past
 * fact (offline-safe by the CONTRIBUTING rule; nothing here allocates).
 *
 * One shape for both doors: the asset page's "Repair cost" opens it with
 * the kind LOCKED to repair and the unit pre-wired (`fixedKind` + `hint`),
 * and the money surface's "Add expense" opens it general, kinds as chips.
 * The amount arrives empty and nothing writes until the one button at the
 * bottom; closing the sheet writes nothing at all — the PaymentSheet's
 * contract, mirrored.
 *
 * BACKDATABLE, like a payment: "paid the workshop last Tuesday, recording
 * it now" must land on the day the money actually left, or the month's
 * profit line books it in the wrong month. The date field defaults to
 * today; an earlier day is filed at local noon so a timezone edge cannot
 * roll it across midnight into the neighbouring day.
 */
export function KharchaSheet({
  title,
  hint,
  fixedKind,
  onSave,
  onClose,
}: {
  title: string
  /** Where the money lands — 'For FX9-01 …' on the repair door. */
  hint: string | null
  /** When set, the door already knows the kind and no chips render. */
  fixedKind?: ExpenseKind
  onSave: (input: {
    kind: ExpenseKind
    amountMinor: number
    counterparty: string | null
    note: string | null
    whenMs: number
  }) => void
  onClose: () => void
}) {
  const [kind, setKind] = useState<ExpenseKind>(fixedKind ?? EXPENSE_KINDS[0])
  const [amount, setAmount] = useState('')
  const [counterparty, setCounterparty] = useState('')
  const [note, setNote] = useState('')
  const todayIso = isoToday()
  const [date, setDate] = useState(todayIso)

  const rupees = Number(amount)
  const valid = Number.isFinite(rupees) && rupees > 0

  const whenMs = (): number => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date === todayIso) return Date.now()
    const [y, m, d] = date.split('-').map(Number)
    return new Date(y, m - 1, d, 12).getTime()
  }

  return (
    <Sheet label={title} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{title}</span>
        <SheetClose />
      </header>

      {hint ? <p className="sheet-hint">{hint}</p> : null}

      {fixedKind === undefined ? (
        <div className="chip-row" role="group" aria-label={STR.kharchaHeading}>
          {EXPENSE_KINDS.map((k) => (
            <button
              key={k}
              className={`filter-chip${kind === k ? ' active' : ''}`}
              aria-pressed={kind === k}
              onClick={() => setKind(k)}
            >
              {STR.kharchaKindLabel(k)}
            </button>
          ))}
        </div>
      ) : null}

      <label className="field-label" htmlFor="kharcha-amount">{STR.kharchaAmount}</label>
      <input
        id="kharcha-amount"
        className="sheet-search code"
        type="number"
        inputMode="decimal"
        min="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        autoFocus
      />

      <label className="field-label" htmlFor="kharcha-paid-to">{STR.kharchaPaidToOptional}</label>
      <input
        id="kharcha-paid-to"
        className="sheet-search"
        placeholder={STR.kharchaPaidToPlaceholder}
        value={counterparty}
        onChange={(e) => setCounterparty(e.target.value)}
        autoCorrect="off"
        spellCheck={false}
      />

      <label className="field-label" htmlFor="kharcha-note">{STR.kharchaNoteOptional}</label>
      <input
        id="kharcha-note"
        className="sheet-search"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        autoCorrect="off"
        spellCheck={false}
      />

      <label className="field-label" htmlFor="kharcha-date">{STR.kharchaDatePaid}</label>
      <input
        id="kharcha-date"
        className="sheet-search"
        type="date"
        max={todayIso}
        value={date}
        onChange={(e) => setDate(e.target.value)}
      />
      <p className="sheet-hint">{STR.kharchaDatePaidHint}</p>

      <button
        className="btn btn-primary btn-lg sheet-submit"
        disabled={!valid}
        onClick={() =>
          onSave({
            kind,
            amountMinor: Math.round(rupees * 100),
            counterparty: counterparty.trim() || null,
            note: note.trim() || null,
            whenMs: whenMs(),
          })
        }
      >
        {STR.kharchaSaveExpense}
      </button>
    </Sheet>
  )
}

/** Local YYYY-MM-DD — the same shape the due-date editor speaks. */
function isoToday(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
