import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Icon } from '@papa/icons'
import { moneyLabel } from '@papa/core'
import { Session } from '../routes/Session.tsx'
import { CloseJobButton, CustomerChip } from '../routes/Today.tsx'
import { manifestText } from '../session-summary.ts'
import { Shell } from '../components/Shell.tsx'
import { ReversalNotices } from '../components/ReversalNotice.tsx'
import { go, type View } from '../nav.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * The handover summary — live session or long finished.
 *
 * Finished sessions are rebuilt from the outbox plus the scan_sessions row
 * written when they opened, so "done" on this card no longer destroys the
 * only record of the morning. The empty state below is therefore reachable
 * only when NO session was ever recorded on this job — arriving on the URL
 * cold — and it says that, rather than rendering an empty tally: a summary
 * of zeros looks exactly like a session where nothing was scanned, which is
 * the one thing a tech must never be shown after a morning's work.
 */
export function SessionScreen({ store, jobId }: { store: DemoStore; jobId: string }) {
  const summary = store.sessionSummary(jobId)
  const view: View = { name: 'session', sessionId: jobId }
  const [parchi, setParchi] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'charge' | 'latefee' | null>(null)
  const [written, setWritten] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  // The khata a dock charge would land in, and the overdue return's
  // late-fee draft — both null when the facts do not support them, and
  // the affordances then never render (never a dead button).
  const customer = store.customerForJob(jobId)
  const lateFee = store.lateFeeDraftFor(jobId)
  // Close-job facts: the rule's number, and whether the job is still open
  // at all (a closed job's handover stays reviewable; the button does not
  // render for it — done twice is not more done). `tick` re-reads both.
  const jobOpen = store.job(jobId) !== undefined
  const stillOut = store.stillOut(jobId)

  const onShare = useCallback(() => {
    if (!summary) return
    const text = manifestText(summary)
    // WhatsApp where it exists, clipboard where it does not. Both end with the
    // list in the client's chat, which is the only outcome that matters.
    const url = `https://wa.me/?text=${encodeURIComponent(text)}`
    const win = window.open(url, '_blank', 'noopener')
    if (!win) void navigator.clipboard?.writeText(text).catch(() => {})
  }, [summary])

  if (!summary) {
    return (
      <Shell view={view} title={STR.sessionHandover} subtitle={STR.sessionNothingOpen}>
        <div className="empty">
          <Icon name="clipboard-check" size={36} />
          <p>{STR.sessionNothingScannedYet}</p>
          <p className="muted">{STR.sessionScanAndItWillBeHere}</p>
          <button className="btn btn-outline" onClick={() => go({ name: 'jobs' })}>
            {STR.commonBackToToday}
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell view={view} title={STR.sessionHandover} subtitle={summary.jobLabel}>
      <Session
        summary={summary}
        chargeCustomerName={customer?.name ?? null}
        lateFee={
          lateFee
            ? {
                dueLabel: lateFee.dueLabel,
                perDayLabel: moneyLabel(lateFee.perDay),
                unpriced: lateFee.perDay.unpriced,
              }
            : null
        }
        onShareWhatsApp={onShare}
        onShowParchi={() => {
          // The challan is stamped when the button is pressed — the moment
          // the truck is actually at the gate, not the moment scanning began.
          const text = store.parchiText(jobId)
          if (text) setParchi(text)
        }}
        onBackToScanning={() => go({ name: 'scan', jobId, mode: 'out' })}
        onDone={() => {
          store.endSession()
          go({ name: 'jobs' })
        }}
        onChargeClient={() => setSheet('charge')}
        onDraftLateFee={() => setSheet('latefee')}
      />

      {/* The job's doors, under the handover: the khata chip (when a
          customer is wired) and Close job — live only once everything is
          back, the same rule the server enforces (0018 D3), with the
          honest count as its disabled reason. */}
      <div className="job-actions">
        <CustomerChip customer={customer} />
        {jobOpen ? (
          <CloseJobButton
            stillOut={stillOut}
            onClose={() => {
              if (store.closeJob(jobId).ok) {
                store.endSession()
                go({ name: 'jobs' })
              }
            }}
          />
        ) : null}
      </div>

      {/* Charged-then-returned: the dock's own NEEDS-A-DECISION notice.
          POLICY (owner may overrule): a reversal draft behind a confirm
          tap, never an auto-reverse — see ReversalNotice. */}
      <ReversalNotices
        notices={store.chargedButReturned({ jobId })}
        refreshKey={tick}
        onReverse={(entryId) => {
          store.reverseEntry(entryId)
          setTick((t) => t + 1)
        }}
      />

      {written && customer ? (
        /* The receipt of the write, with the door to the khata it landed
           in — the one place the figure can be checked and, if the desk
           mis-typed, adjusted with a further entry, never an edit. */
        <div className="notice">
          <Icon name="check" size={18} />
          <div>
            <strong>{STR.sessionChargeWritten(customer.name)}</strong>
          </div>
          <button
            className="btn btn-sm btn-ghost"
            onClick={() => go({ name: 'customer', customerId: customer.id })}
          >
            {STR.sessionViewKhata}
          </button>
        </div>
      ) : null}

      {sheet === 'charge' && customer ? (
        <KhataChargeSheet
          title={STR.sessionChargeClient}
          hint={STR.sessionChargeGoesTo(customer.name)}
          // Prefilled from what the reconciliation priced the gap at —
          // when it priced anything. Editable: the figure agreed at the
          // dock is the owner's, not the list's.
          initialAmount={
            summary.missingValue.priced > 0
              ? String(Math.round(summary.missingValue.totalMinor / 100))
              : ''
          }
          initialNote=""
          onSave={(amountMinor, note) => {
            if (store.chargeClient(jobId, amountMinor, note)) {
              setSheet(null)
              setWritten('charge')
            }
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {sheet === 'latefee' && customer && lateFee ? (
        <KhataChargeSheet
          title={STR.sessionLateFee}
          hint={STR.sessionChargeGoesTo(customer.name)}
          sub={STR.sessionLateFeeNeverAuto}
          initialAmount={
            lateFee.draft.priced > 0
              ? String(Math.round(lateFee.draft.totalMinor / 100))
              : ''
          }
          // The note carries the arithmetic's basis — '3 days late' — so
          // the ledger line explains itself when the client asks.
          initialNote={lateFee.dueLabel}
          onSave={(amountMinor, note) => {
            if (store.recordLateFee(jobId, amountMinor, note)) {
              setSheet(null)
              setWritten('latefee')
            }
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}

      {parchi ? (
        <ParchiOverlay
          jobLabel={summary.jobLabel}
          text={parchi}
          onClose={() => setParchi(null)}
        />
      ) : null}
    </Shell>
  )
}

/**
 * The dock's charge sheet — one shape for the damage/extras charge and the
 * confirmed late fee. The amount arrives PREFILLED from the facts on screen
 * and stays fully editable; nothing writes until the one button at the
 * bottom, and closing the sheet writes nothing at all.
 */
function KhataChargeSheet({
  title,
  hint,
  sub,
  initialAmount,
  initialNote,
  onSave,
  onClose,
}: {
  title: string
  hint: string
  sub?: string
  initialAmount: string
  initialNote: string
  onSave: (amountMinor: number, note: string | null) => void
  onClose: () => void
}) {
  const [amount, setAmount] = useState(initialAmount)
  const [note, setNote] = useState(initialNote)
  const rupees = Number(amount)
  const valid = Number.isFinite(rupees) && rupees > 0

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={title}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>

        <p className="sheet-hint">{hint}</p>
        {sub ? <p className="sheet-hint">{sub}</p> : null}

        <label className="field-label" htmlFor="charge-amount">{STR.sessionChargeAmount}</label>
        <input
          id="charge-amount"
          className="sheet-search code"
          type="number"
          inputMode="decimal"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />

        <label className="field-label" htmlFor="charge-note">{STR.sessionChargeNoteOptional}</label>
        <input
          id="charge-note"
          className="sheet-search"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoCorrect="off"
          spellCheck={false}
        />

        <button
          className="btn btn-primary btn-lg sheet-submit"
          disabled={!valid}
          onClick={() => onSave(Math.round(rupees * 100), note.trim() || null)}
        >
          {STR.sessionWriteInKhata}
        </button>
      </div>
    </div>
  )
}

/**
 * The parchi, full screen — this phone IS the gate pass.
 *
 * Hard black-on-white regardless of theme: the gate is the one place this app
 * is guaranteed to be read in direct sun, and a QR code is the one element
 * that must not inherit a softened palette — maximum luminance and contrast
 * is exactly what the sun theme itself does, so white is right in every
 * theme. The job label is big above the code so the guard knows which truck
 * this pass belongs to before anything is scanned.
 *
 * Closing is a plain tap anywhere — nothing here writes, so there is nothing
 * a mis-tap can destroy.
 */
function ParchiOverlay({
  jobLabel,
  text,
  onClose,
}: {
  jobLabel: string
  text: string
  onClose: () => void
}) {
  const [image, setImage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Level M to match the label encoder the round-trip test pins down, and
    // a wide margin: the quiet zone is what lets another phone's camera lock
    // on at arm's length through two layers of glass.
    QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 3,
      width: 640,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => { if (!cancelled) setImage(url) })
      .catch(() => { if (!cancelled) setImage(null) })
    return () => { cancelled = true }
  }, [text])

  return (
    <div
      className="parchi-overlay"
      role="dialog"
      aria-label={STR.sessionParchiGatePassAria}
      onClick={onClose}
    >
      <p className="parchi-job">{jobLabel}</p>
      {image ? (
        <img className="parchi-qr" src={image} alt={STR.sessionChallanAsQrAlt} />
      ) : (
        <div className="parchi-qr parchi-qr-empty" />
      )}
      <p className="parchi-hint">{STR.sessionAnyPhoneCameraReadsThis}</p>
    </div>
  )
}
