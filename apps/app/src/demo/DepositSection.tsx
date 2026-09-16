import { useState } from 'react'
import { Icon } from '@papa/icons'
import { formatRupees, ledgerDate } from '@papa/core'
import { SectionHead } from '../components/Shell.tsx'
import { Sheet, SheetClose } from '../components/Sheet.tsx'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import { STR } from '../strings.ts'
import type { DemoStore } from './store.ts'
import type { DepositRow, RefundBlocker } from './deposits.ts'

/**
 * Deposits on the khata page — the door the simulated year reached for in
 * SEP and again in DEC and did not find (`no-deposit-door`). The
 * projection has always handled hold/apply/refund to the paisa; only the
 * seed had ever written the kinds.
 *
 * WHAT EACH ROW SAYS. The amount in the mono money voice, the deposit's
 * own state as a quiet badge, the job it secures, and — for a deposit
 * still holding money — the two things a desk actually does with it:
 * put it against a bill, or give it back.
 *
 * THE REFUND IS THE CAREFUL ONE. Override 15 calls it "the most direct
 * money-loss path in the plan", and the server refuses it while the job is
 * not QC-clear. So the phone reads the same gate BEFORE the tap: a blocked
 * refund opens nothing — the reason is on the row, in words, where the desk
 * can read it to the client. When it is clear, the refund still sits behind
 * a HOLD, never a tap, because a knuckle must not hand back Rs 100,000.
 */
export function DepositSection({
  store,
  customerId,
  customerName,
  heldMinor,
  jobs,
  onWrite,
}: {
  store: DemoStore
  customerId: string
  customerName: string
  /** The pot, as the page's own projection already computed it — passed in
   *  rather than re-read, so the head and the balance line cannot disagree. */
  heldMinor: number
  /** The customer's jobs, for the "against which job" picker. */
  jobs: { id: string; label: string }[]
  /** Re-read the page after a write. */
  onWrite: () => void
}) {
  const [taking, setTaking] = useState(false)
  const [applying, setApplying] = useState<DepositRow | null>(null)
  const [refunding, setRefunding] = useState<DepositRow | null>(null)

  const deposits = store.deposits(customerId)

  return (
    <section className="section">
      <SectionHead
        icon="shield"
        title={STR.moneyDepositsHeading}
        sub={
          heldMinor > 0
            ? STR.moneyDepositsHeldSub(formatRupees(heldMinor))
            : STR.moneyDepositsNone
        }
      />

      {deposits.length > 0 ? (
        <ul className="line-list">
          {deposits.map((d) => {
            const blockers = d.state === 'refunded' ? [] : store.refundBlockers(d.jobId)
            return (
              <li key={d.id} className="line line-stack">
                <span className="line-name code">{formatRupees(d.amountMinor)}</span>
                <span className="line-note">
                  {[
                    ledgerDate(d.heldAt),
                    d.jobLabel,
                    d.note,
                    d.state === 'refunded'
                      ? STR.moneyDepositRefunded(formatRupees(d.refundedMinor ?? 0))
                      : d.appliedMinor > 0
                        ? STR.moneyDepositApplied(formatRupees(d.appliedMinor))
                        : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="line-code">
                  <span
                    className={
                      d.state === 'refunded'
                        ? 'badge badge-green'
                        : d.state === 'partially_applied'
                          ? 'badge badge-orange'
                          : 'badge'
                    }
                  >
                    {STR.moneyDepositStamp(d.state)}
                  </span>
                </span>
                {d.remainingMinor > 0 ? (
                  <div className="row-actions">
                    <button className="btn btn-sm btn-outline" onClick={() => setApplying(d)}>
                      <Icon name="coins" size={16} /> {STR.moneyDepositApply}
                    </button>
                    {blockers.length === 0 ? (
                      <button className="btn btn-sm btn-ghost" onClick={() => setRefunding(d)}>
                        <Icon name="undo" size={16} /> {STR.moneyDepositRefund}
                      </button>
                    ) : (
                      // Disabled, and SAYING WHY — the server's own refusal,
                      // read before the tap instead of an hour later as a card.
                      <button className="btn btn-sm btn-ghost" disabled>
                        <Icon name="ban" size={16} /> {STR.moneyDepositRefundBlocked}
                      </button>
                    )}
                  </div>
                ) : null}
                {blockers.length > 0 && d.remainingMinor > 0 ? (
                  <ul className="line-why">
                    {blockers.map((b) => (
                      <li key={b.reason}>{STR.moneyDepositBlocker(b.reason, b.count)}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      ) : null}

      <button className="btn btn-outline btn-block" onClick={() => setTaking(true)}>
        <Icon name="shield" size={18} /> {STR.moneyTakeDeposit}
      </button>

      {taking ? (
        <TakeDepositSheet
          customerName={customerName}
          jobs={jobs}
          onSave={(amountMinor, jobId, note) => {
            store.holdDeposit({ customerId, amountMinor, jobId, note })
            setTaking(false)
            onWrite()
          }}
          onClose={() => setTaking(false)}
        />
      ) : null}

      {applying ? (
        <ApplyDepositSheet
          store={store}
          deposit={applying}
          onSave={(amountMinor, note) => {
            store.applyDeposit(applying.id, amountMinor, note)
            setApplying(null)
            onWrite()
          }}
          onClose={() => setApplying(null)}
        />
      ) : null}

      {refunding ? (
        <RefundDepositSheet
          deposit={refunding}
          blockers={store.refundBlockers(refunding.jobId)}
          onRefund={(note) => {
            store.refundDeposit(refunding.id, note)
            setRefunding(null)
            onWrite()
          }}
          onClose={() => setRefunding(null)}
        />
      ) : null}
    </section>
  )
}

/**
 * Take a deposit — the amount, how it is held, and which job it secures.
 * Cash or cheque is a CHIP rather than free text because the refund
 * conversation is different for the two, and the note then carries the
 * cheque number that makes a held cheque findable.
 * ASSUMPTION: cash or a held cheque are the two forms. See
 * docs/assumptions.md#deposit-norms
 */
function TakeDepositSheet({
  customerName,
  jobs,
  onSave,
  onClose,
}: {
  customerName: string
  jobs: { id: string; label: string }[]
  onSave: (amountMinor: number, jobId: string | null, note: string | null) => void
  onClose: () => void
}) {
  const forms = [STR.moneyDepositCash, STR.moneyDepositCheque]
  const [amount, setAmount] = useState('')
  const [form, setForm] = useState(forms[0])
  const [note, setNote] = useState('')
  const [jobId, setJobId] = useState<string>(jobs[0]?.id ?? '')

  const rupees = Number(amount)
  const valid = Number.isFinite(rupees) && rupees > 0

  return (
    <Sheet label={STR.moneyTakeDeposit} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{STR.moneyTakeDeposit}</span>
        <SheetClose />
      </header>

      <p className="sheet-hint">{customerName}</p>

      <label className="field-label" htmlFor="dep-amount">{STR.moneyDepositAmount}</label>
      <input
        id="dep-amount"
        className="sheet-search code"
        type="number"
        inputMode="decimal"
        min="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        autoFocus
      />

      <div className="chip-row" role="group" aria-label={STR.moneyDepositHowHeld}>
        {forms.map((f) => (
          <button
            key={f}
            className={`filter-chip${form === f ? ' active' : ''}`}
            aria-pressed={form === f}
            onClick={() => setForm(f)}
          >
            {f}
          </button>
        ))}
      </div>

      <label className="field-label" htmlFor="dep-note">{STR.moneyDepositNoteOptional}</label>
      <input
        id="dep-note"
        className="sheet-search"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        autoCorrect="off"
        spellCheck={false}
      />

      <label className="field-label" htmlFor="dep-job">{STR.moneyDepositAgainstJob}</label>
      <select
        id="dep-job"
        className="sheet-search"
        value={jobId}
        onChange={(e) => setJobId(e.target.value)}
      >
        <option value="">{STR.moneyDepositNoJob}</option>
        {jobs.map((j) => (
          <option key={j.id} value={j.id}>{j.label}</option>
        ))}
      </select>

      <button
        className="btn btn-primary btn-lg sheet-submit"
        disabled={!valid}
        onClick={() =>
          onSave(
            Math.round(rupees * 100),
            jobId || null,
            [form, note.trim()].filter(Boolean).join(' — ') || null,
          )
        }
      >
        {STR.moneyDepositSave}
      </button>
    </Sheet>
  )
}

/**
 * Put held money against a bill. The chips are the real answers — the
 * whole account, or one live charge on this deposit's own job — and each
 * fills the amount, which the desk can still edit. Never more than is
 * held: the input is capped, the same way the server caps it.
 */
function ApplyDepositSheet({
  store,
  deposit,
  onSave,
  onClose,
}: {
  store: DemoStore
  deposit: DepositRow
  onSave: (amountMinor: number, note: string | null) => void
  onClose: () => void
}) {
  const targets = store.depositApplyTargets(deposit.id)
  const [amount, setAmount] = useState(
    targets.balanceMinor > 0 ? String(targets.balanceMinor / 100) : '',
  )
  const [note, setNote] = useState('')

  const rupees = Number(amount)
  const minor = Math.round(rupees * 100)
  const tooMuch = minor > deposit.remainingMinor
  const valid = Number.isFinite(rupees) && rupees > 0 && !tooMuch

  return (
    <Sheet label={STR.moneyDepositApplyTitle} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{STR.moneyDepositApplyTitle}</span>
        <SheetClose />
      </header>

      <p className="sheet-hint">
        {STR.moneyDepositRemaining(formatRupees(deposit.remainingMinor))}
      </p>

      <div className="chip-row" role="group" aria-label={STR.moneyDepositApplyPick}>
        {targets.balanceMinor > 0 ? (
          <button
            className="filter-chip"
            onClick={() => setAmount(String(targets.balanceMinor / 100))}
          >
            {STR.moneyDepositApplyBalance(formatRupees(targets.balanceMinor))}
          </button>
        ) : null}
        {targets.charges.map((c) => (
          <button
            key={c.id}
            className="filter-chip"
            onClick={() =>
              setAmount(String(Math.min(c.amountMinor, deposit.remainingMinor) / 100))
            }
          >
            {STR.moneyDepositApplyCharge(
              STR.customerKindLabel(c.kind),
              formatRupees(c.amountMinor),
            )}
          </button>
        ))}
      </div>

      <label className="field-label" htmlFor="dep-apply-amount">{STR.moneyDepositAmount}</label>
      <input
        id="dep-apply-amount"
        className="sheet-search code"
        type="number"
        inputMode="decimal"
        min="0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      {tooMuch ? (
        <p className="sheet-hint">
          {STR.moneyDepositApplyTooMuch(formatRupees(deposit.remainingMinor))}
        </p>
      ) : null}

      <label className="field-label" htmlFor="dep-apply-note">{STR.moneyDepositNoteOptional}</label>
      <input
        id="dep-apply-note"
        className="sheet-search"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        autoCorrect="off"
        spellCheck={false}
      />

      <button
        className="btn btn-primary btn-lg sheet-submit"
        disabled={!valid}
        onClick={() => onSave(minor, note.trim() || null)}
      >
        {STR.moneyDepositApplySave}
      </button>
    </Sheet>
  )
}

/** Give the remainder back — behind a HOLD, with the server's re-check
 *  said out loud so a later refusal is expected, not a surprise. */
function RefundDepositSheet({
  deposit,
  blockers,
  onRefund,
  onClose,
}: {
  deposit: DepositRow
  blockers: RefundBlocker[]
  onRefund: (note: string | null) => void
  onClose: () => void
}) {
  const [note, setNote] = useState('')
  const rupees = formatRupees(deposit.remainingMinor)

  return (
    <Sheet label={STR.moneyDepositRefundTitle} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{STR.moneyDepositRefundTitle}</span>
        <SheetClose />
      </header>

      <div className="tally">
        <p className="tally-line code">{rupees}</p>
        <p className="tally-sub">{deposit.jobLabel ?? STR.moneyDepositNoJob}</p>
      </div>

      {blockers.length > 0 ? (
        <div className="notice notice-warn">
          <Icon name="ban" size={18} />
          <div>
            <strong>{STR.moneyDepositRefundBlocked}</strong>
            <ul className="line-why">
              {blockers.map((b) => (
                <li key={b.reason}>{STR.moneyDepositBlocker(b.reason, b.count)}</li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}

      <label className="field-label" htmlFor="dep-refund-note">{STR.moneyDepositNoteOptional}</label>
      <input
        id="dep-refund-note"
        className="sheet-search"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        autoCorrect="off"
        spellCheck={false}
      />

      <p className="sheet-hint">{STR.moneyDepositServerChecksAgain}</p>

      <HoldToFinish
        label={STR.moneyDepositRefundHold(rupees)}
        disabled={blockers.length > 0}
        onFinish={() => onRefund(note.trim() || null)}
      />
    </Sheet>
  )
}
