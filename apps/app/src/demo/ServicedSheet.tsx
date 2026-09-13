import { useState } from 'react'
import { STR } from '../strings.ts'
import { Sheet, SheetClose } from '../components/Sheet.tsx'

/**
 * The Serviced sheet — the reset end of the usage nudge (0021 D2), one flow:
 * a note about what was done, and an OPTIONAL cost. A cost writes a repair
 * on the kharcha book named to this unit — its cost history and the payback
 * bar's honest denominator move — and the serviced event carries the link.
 *
 * The KharchaSheet contract, mirrored: nothing writes until the one button
 * at the bottom, and closing the sheet writes nothing at all. Both fields
 * are optional on purpose — "the boy cleaned it, no bill" is a real
 * service, and forcing a figure would invent money.
 */
export function ServicedSheet({
  assetCode,
  onSave,
  onClose,
}: {
  assetCode: string
  onSave: (input: {
    note: string | null
    costMinor: number | null
    counterparty: string | null
  }) => void
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState('')
  const [counterparty, setCounterparty] = useState('')

  const rupees = Number(amount)
  const costMinor =
    amount.trim().length > 0 && Number.isFinite(rupees) && rupees > 0
      ? Math.round(rupees * 100)
      : null

  return (
    <Sheet label={STR.sehatServicedTitle} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{STR.sehatServicedTitle}</span>
        <SheetClose />
      </header>

      <p className="sheet-hint">{STR.sehatServicedHint(assetCode)}</p>

      <label className="field-label" htmlFor="serviced-note">
        {STR.sehatServicedNoteLabel}
      </label>
      <input
        id="serviced-note"
        className="sheet-search"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        autoCorrect="off"
        spellCheck={false}
        autoFocus
      />

      <label className="field-label" htmlFor="serviced-cost">
        {STR.sehatServicedCostLabel}
      </label>
      <input
        id="serviced-cost"
        className="sheet-search code"
        type="number"
        inputMode="decimal"
        min="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />

      {costMinor !== null ? (
        <>
          <label className="field-label" htmlFor="serviced-paid-to">
            {STR.kharchaPaidToOptional}
          </label>
          <input
            id="serviced-paid-to"
            className="sheet-search"
            placeholder={STR.kharchaPaidToPlaceholder}
            value={counterparty}
            onChange={(e) => setCounterparty(e.target.value)}
            autoCorrect="off"
            spellCheck={false}
          />
        </>
      ) : null}

      <button
        className="btn btn-primary btn-lg sheet-submit"
        onClick={() =>
          onSave({
            note: note.trim() || null,
            costMinor,
            counterparty: counterparty.trim() || null,
          })
        }
      >
        {STR.sehatServicedConfirm}
      </button>
    </Sheet>
  )
}
