import { useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import {
  dueStatus,
  formatRupees,
  ledgerDate,
  signedRupees,
  whatsAppShareUrl,
} from '@papa/core'
import { Shell, SectionHead } from '../components/Shell.tsx'
import { ReversalNotices } from '../components/ReversalNotice.tsx'
import { go, type View } from '../nav.ts'
import { DueBadge } from '../routes/Today.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * One customer's khata — the page the whole money book opens to.
 *
 * The page IS the ledger: the balance written big under the accountant's
 * double rule, then the book itself as ruled mono rows, newest first, then
 * the jobs the money hangs off. Everything shown is a projection over the
 * append-only entries (see @papa/core ledger.ts); the screen derives nothing.
 *
 * ACTION PLACEMENT IS DELIBERATE. "Record payment" — the one control that
 * WRITES — sits directly under the balance, and the two SHARE actions live
 * at the far bottom, below the book and the jobs. A thumb reaching to send
 * the client a reminder must never land on the button that records money as
 * received (semantic.css: adjacency, not size, is what prevents mis-taps).
 *
 * The share pair follows the app's one sharing rule: WhatsApp where it
 * exists, clipboard where it does not — and the app only DRAFTS; the send
 * stays the owner's, because the message's authority lives in who sent it.
 */
export function KhataScreen({ store, customerId }: { store: DemoStore; customerId: string }) {
  const view: View = { name: 'customer', customerId }
  const [tick, setTick] = useState(0)
  const [paying, setPaying] = useState(false)
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const customer = store.customer(customerId)

  if (!customer) {
    return (
      <Shell view={view} title={STR.customerKhata}>
        <div className="empty">
          <Icon name="question" size={36} />
          <p>{STR.customerNoSuchCustomer}</p>
          <button className="btn btn-ghost" onClick={() => go({ name: 'owed' })}>
            {STR.customerOwedTitle}
          </button>
        </div>
      </Shell>
    )
  }

  const onSendBalance = () => {
    const text = store.balanceText(customerId)
    if (!text) return
    const win = window.open(whatsAppShareUrl(text), '_blank', 'noopener')
    if (!win) void navigator.clipboard?.writeText(text).catch(() => {})
  }

  const onCopyStatement = () => {
    const text = store.statementText(customerId)
    if (!text) return
    void navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  const now = Date.now()

  return (
    <Shell
      view={view}
      title={customer.name}
      subtitle={customer.phone ?? STR.customerKhata}
      action={
        <button
          className="icon-btn"
          onClick={() => go({ name: 'owed' })}
          aria-label={STR.customerOwedTitle}
        >
          <Icon name="chevron-left" size={22} />
        </button>
      }
    >
      {/* The figure of the page. Mono, stat-sized, double-ruled — the
          challan-total voice. A negative balance renders as itself, and
          — POLICY (owner may overrule) — the sub-line SAYS it plainly:
          'You owe them Rs X', never a disguised 'Balance'. The house
          owing the customer is a fact, not a display bug. */}
      <div className="tally khata-balance">
        <p className="tally-line code">{formatRupees(customer.balanceMinor)}</p>
        <p className="tally-sub">
          {customer.balanceMinor < 0
            ? STR.customerHouseOwes(formatRupees(-customer.balanceMinor))
            : STR.customerBalanceHeading}
          {customer.depositHeldMinor > 0
            ? ` · ${STR.customerDepositHeldLine(formatRupees(customer.depositHeldMinor))}`
            : null}
        </p>
      </div>

      <button className="btn btn-primary btn-block" onClick={() => setPaying(true)}>
        <Icon name="clipboard-check" size={18} /> {STR.customerRecordPayment}
      </button>

      {/* Charged-then-returned: NEEDS-A-DECISION notices. POLICY (owner
          may overrule): a pre-filled reversal DRAFT behind a confirm tap,
          never an auto-reverse — see ReversalNotice. `tick` in the key
          re-reads the list after a write. */}
      <ReversalNotices
        notices={store.chargedButReturned({ customerId })}
        refreshKey={tick}
        onReverse={(entryId) => {
          store.reverseEntry(entryId)
          setTick((t) => t + 1)
        }}
      />

      <section className="section">
        <SectionHead
          icon="scroll"
          title={STR.customerBookHeading}
          sub={
            customer.entries.length === 0
              ? STR.customerNothingInBook
              : STR.customerEntriesNewestFirst(customer.entries.length)
          }
        />
        {customer.entries.length === 0 ? null : (
          <ul className="line-list">
            {customer.entries.map((e) => (
              <li key={e.id} className="line">
                <span className="line-name">{STR.customerKindLabel(e.kind)}</span>
                <span className="line-note">
                  {[ledgerDate(e.createdAt), e.jobLabel, e.note]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className="line-code code">{signedRupees(e.amountMinor)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {customer.jobs.length > 0 ? (
        <section className="section">
          <SectionHead icon="clipboard-check" title={STR.customerLinkedJobs} />
          <ul className="line-list">
            {customer.jobs.map((j) => (
              <li key={j.id} className="line">
                <span className="line-name">{j.label}</span>
                {j.status === 'closed' ? (
                  <span className="line-code">
                    <span className="badge">{STR.customerJobClosed}</span>
                  </span>
                ) : (
                  <span className="line-code">
                    <DueBadge due={dueStatus(j.expectedBack, now)} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* The share pair — drafts only, and far from the write button. */}
      <div className="session-actions">
        <button className="btn btn-outline btn-block" onClick={onSendBalance}>
          <Icon name="send" size={18} /> {STR.customerSendBalance}
        </button>
        <button className="btn btn-ghost btn-block" onClick={onCopyStatement}>
          <Icon name="clipboard" size={18} />{' '}
          {copied ? STR.customerCopied : STR.customerMonthlyStatement}
        </button>
      </div>

      {paying ? (
        <PaymentSheet
          customerName={customer.name}
          onSave={(amountMinor, method, note) => {
            store.recordPayment(customerId, amountMinor, method, note)
            setPaying(false)
            setTick((t) => t + 1)
          }}
          onClose={() => setPaying(false)}
        />
      ) : null}
    </Shell>
  )
}

/**
 * Record money received — a PAST FACT, so it works with no server. Amount in
 * rupees at the keyboard, minor units in the book; the method chips are the
 * four ways money actually arrives at a Lahore desk, and the chosen one rides
 * in the entry's note so the book says HOW as well as how much.
 */
function PaymentSheet({
  customerName,
  onSave,
  onClose,
}: {
  customerName: string
  onSave: (amountMinor: number, method: string, note: string | null) => void
  onClose: () => void
}) {
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const methods = [
    STR.customerMethodCash,
    STR.customerMethodJazzCash,
    STR.customerMethodEasypaisa,
    STR.customerMethodBank,
  ]
  const [method, setMethod] = useState(methods[0])

  const rupees = Number(amount)
  const valid = Number.isFinite(rupees) && rupees > 0

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.customerRecordPayment}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{STR.customerRecordPayment}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>

        <p className="sheet-hint">{customerName}</p>

        <label className="field-label" htmlFor="pay-amount">{STR.customerPaymentAmount}</label>
        <input
          id="pay-amount"
          className="sheet-search code"
          type="number"
          inputMode="decimal"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          autoFocus
        />

        <div className="chip-row" role="group" aria-label={STR.customerRecordPayment}>
          {methods.map((m) => (
            <button
              key={m}
              className={`filter-chip${method === m ? ' active' : ''}`}
              aria-pressed={method === m}
              onClick={() => setMethod(m)}
            >
              {m}
            </button>
          ))}
        </div>

        <label className="field-label" htmlFor="pay-note">{STR.customerPaymentNoteOptional}</label>
        <input
          id="pay-note"
          className="sheet-search"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          autoCorrect="off"
          spellCheck={false}
        />

        <button
          className="btn btn-primary btn-lg sheet-submit"
          disabled={!valid}
          onClick={() => onSave(Math.round(rupees * 100), method, note.trim() || null)}
        >
          {STR.customerSavePayment}
        </button>
      </div>
    </div>
  )
}
