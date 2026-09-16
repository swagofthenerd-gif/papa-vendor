import { useState } from 'react'
import { Icon } from '@papa/icons'
import { formatRupees, ledgerDate, signedRupees } from '@papa/core'
import { Sheet, SheetClose } from '../components/Sheet.tsx'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import { ReasonField } from '../components/ReasonField.tsx'
import { STR } from '../strings.ts'
import type { LedgerRow } from './khata.ts'

/**
 * The correction door (W13, `no-adjustment-door`).
 *
 * The year found the vocabulary already there — `reversal` names what it
 * voids, `write_off` is given-up debt, and the statement prints
 * "reversed" instead of a self-blaming "adjustment" — and no screen that
 * could write any of it. December's double-tapped Rs 30,000 damage charge
 * needed SQL typed on the owner's behalf.
 *
 * TWO DOORS, NOT ONE, because they are two different admissions:
 *
 *   Correct this — the line was a MISTAKE. A reversal, negating it
 *                  exactly, and both rows stay on the page because the
 *                  client saw both happen.
 *   Write it off — the line was RIGHT and the house has decided not to
 *                  chase it. Goodwill, or an absconded client. It must
 *                  never print as the house correcting its own error.
 *
 * Both need a reason (override 18: never fight the owner's judgement,
 * always record it — and the server's own constraint refuses a note-less
 * write-off), and both sit behind a HOLD rather than a tap: the ledger is
 * append-only, so a correction written by a knuckle is a correction
 * forever.
 */
export function LineSheet({
  line,
  onCorrect,
  onWriteOff,
  onClose,
}: {
  line: LedgerRow
  onCorrect: (reason: string) => void
  onWriteOff: (reason: string) => void
  onClose: () => void
}) {
  const [door, setDoor] = useState<'pick' | 'correct' | 'write_off'>('pick')
  const [reason, setReason] = useState('')

  const rupees = formatRupees(Math.abs(line.amountMinor))
  const owed = line.amountMinor > 0
  const ready = reason.trim().length > 0

  return (
    <Sheet label={STR.moneyLineTitle} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{STR.moneyLineTitle}</span>
        <SheetClose />
      </header>

      {/* The line itself, in the book's own voice, so the desk is certain
          which row it is about to change. */}
      <ul className="line-list">
        <li className="line line-stack">
          <span className="line-name">{STR.customerKindLabel(line.kind)}</span>
          <span className="line-note">
            {[ledgerDate(line.createdAt), line.jobLabel, line.note].filter(Boolean).join(' · ')}
          </span>
          <span className="line-code code">{signedRupees(line.amountMinor)}</span>
        </li>
      </ul>

      {door === 'pick' ? (
        <div className="session-actions">
          <button className="btn btn-outline btn-block" onClick={() => setDoor('correct')}>
            <Icon name="undo" size={18} /> {STR.moneyCorrectThis}
          </button>
          <p className="sheet-hint">{STR.moneyCorrectWhat}</p>
          {/* Writing off a payment would hand the client money they never
              asked for, so the door only exists on money OWED. */}
          {owed ? (
            <>
              <button className="btn btn-ghost btn-block" onClick={() => setDoor('write_off')}>
                <Icon name="hand" size={18} /> {STR.moneyWriteItOff}
              </button>
              <p className="sheet-hint">{STR.moneyWriteOffWhat}</p>
            </>
          ) : null}
        </div>
      ) : (
        <>
          <p className="sheet-hint">
            {door === 'correct' ? STR.moneyCorrectTitle : STR.moneyWriteOffTitle}
          </p>

          <ReasonField
            id="settle-reason"
            value={reason}
            placeholder={STR.moneyReasonPlaceholder}
            onChange={setReason}
            autoFocus
          />

          <HoldToFinish
            label={
              door === 'correct'
                ? STR.moneyCorrectHold(rupees)
                : STR.moneyWriteOffHold(rupees)
            }
            disabled={!ready}
            onFinish={() =>
              door === 'correct' ? onCorrect(reason.trim()) : onWriteOff(reason.trim())
            }
          />
        </>
      )}
    </Sheet>
  )
}
