import { useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import {
  dueStatus,
  formatRupees,
  ledgerDate,
  signedRupees,
  type LedgerEntryKind,
} from '@papa/core'
import { Shell, SectionHead } from '../components/Shell.tsx'
import { ReversalNotices } from '../components/ReversalNotice.tsx'
import { go, type View } from '../nav.ts'
import { shareText } from '../share.ts'
import { DueBadge } from '../routes/Today.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'
import { Sheet, SheetClose } from '../components/Sheet.tsx'
// --- W13 the money doors
import { DepositSection } from './DepositSection.tsx'
import { LineSheet } from './CorrectionSheet.tsx'
import type { LedgerRow } from './khata.ts'

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
 *
 * SINCE W13 EVERY LINE IS A DOOR. Tapping a row opens the correction
 * sheet — "correct this" or "write it off", both with a reason and both
 * behind a hold. A settled line reads as one story: struck through, with
 * the settlement's own words beneath it, the settling row not repeated
 * below. Deposits get their own section above the book, because security
 * money is not debt in either direction.
 */

/** Kinds a correction door opens on: money the desk wrote, not money the
 *  deposit machine moved and not a correction itself. */
const CORRECTABLE: ReadonlySet<LedgerEntryKind> = new Set([
  'charge', 'late_fee', 'damage_charge', 'payment',
])
export function KhataScreen({ store, customerId }: { store: DemoStore; customerId: string }) {
  const view: View = { name: 'customer', customerId }
  const [tick, setTick] = useState(0)
  const [paying, setPaying] = useState(false)
  // The line the correction door is open on (W13) — instance state, which
  // is why the route keys this screen by customer.
  const [settling, setSettling] = useState<LedgerRow | null>(null)
  // Duplicate questions the owner has answered with "both are real". Local
  // to the visit on purpose: it is an acknowledgement, not a ledger fact,
  // and nothing about the book changed.
  const [keptDuplicates, setKeptDuplicates] = useState<string[]>([])
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
    shareText(text)
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

  // The settlement rows — the lines the book renders as sub-lines of what
  // they settled rather than as rows of their own.
  const settlementIds = new Set([...customer.settled.values()].map((v) => v.byId))
  const duplicates = store
    .duplicateEntries({ customerId })
    .filter((d) => !keptDuplicates.includes(d.entryId) && !customer.settled.has(d.entryId))

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

      {/* Deposits (W13, `no-deposit-door`): security money is not debt in
          either direction, so it gets its own section rather than a line
          in the book — held, applied, refunded, with the refund's gate
          read before the tap. Above the book because a deposit is a
          STATE the desk acts on; the book below is history. */}
      <DepositSection
        key={`deposits-${tick}`}
        store={store}
        customerId={customerId}
        customerName={customer.name}
        heldMinor={customer.depositHeldMinor}
        jobs={customer.jobs}
        onWrite={() => setTick((t) => t + 1)}
      />

      {/* The double-tap question (W13, the second half of
          `no-adjustment-door`): two identical charge lines seconds apart
          are worth asking about, never worth refusing — two cracked
          filters is a real answer. The correction behind it is the
          ordinary one. */}
      {duplicates.map((d) => (
        <div className="notice notice-warn" key={d.entryId}>
          <Icon name="question" size={18} />
          <div>
            <strong>
              {STR.moneyDuplicateNotice(
                STR.customerKindLabel(d.kind),
                formatRupees(d.amountMinor),
                d.secondsApart,
              )}
            </strong>
          </div>
          <div className="row-actions">
            <button
              className="btn btn-sm btn-primary"
              onClick={() => {
                const line = customer.entries.find((e) => e.id === d.entryId)
                if (line) setSettling(line)
              }}
            >
              {STR.moneyCorrectThis}
            </button>
            <button
              className="btn btn-sm btn-ghost"
              onClick={() => setKeptDuplicates((k) => [...k, d.entryId])}
            >
              {STR.moneyDuplicateKeep}
            </button>
          </div>
        </div>
      ))}

      <section className="section">
        <SectionHead
          icon="scroll"
          title={STR.customerBookHeading}
          sub={
            customer.entries.length === 0
              ? STR.customerNothingInBook
              : STR.moneyLineDoorHint
          }
        />
        {customer.entries.length === 0 ? null : (
          <ul className="line-list khata-book">
            {customer.entries.map((e) => {
              // A settlement is not its own row: it is the sub-line under
              // the line it settled, so a correction reads as ONE story
              // instead of two mystery rows (W13). Both are still in the
              // book, and every projection still sums both.
              if (settlementIds.has(e.id)) return null
              const settled = customer.settled.get(e.id)
              const openable = settled === undefined && CORRECTABLE.has(e.kind) && e.depositId === null
              const body = (
                <>
                  <span className="line-name">{STR.customerKindLabel(e.kind)}</span>
                  <span className="line-note">
                    {[ledgerDate(e.createdAt), e.jobLabel, e.note]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                  <span className="line-code code">{signedRupees(e.amountMinor)}</span>
                  {settled ? (
                    <ul className="line-why">
                      <li>
                        {STR.moneySettledLine(
                          STR.customerKindLabel(settled.kind),
                          ledgerDate(settled.createdAt),
                          settled.note,
                        )}
                      </li>
                    </ul>
                  ) : null}
                </>
              )
              const cls = `line line-stack${settled ? ' line-settled' : ''}`
              return (
                <li key={e.id}>
                  {openable ? (
                    <button
                      className={`${cls} line-tap pressable`}
                      onClick={() => setSettling(e)}
                    >
                      {body}
                    </button>
                  ) : (
                    <div className={cls}>{body}</div>
                  )}
                </li>
              )
            })}
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

      {settling ? (
        <LineSheet
          line={settling}
          onCorrect={(reason) => {
            store.correctEntry(settling.id, reason)
            setSettling(null)
            setTick((t) => t + 1)
          }}
          onWriteOff={(reason) => {
            store.writeOffEntry(settling.id, reason)
            setSettling(null)
            setTick((t) => t + 1)
          }}
          onClose={() => setSettling(null)}
        />
      ) : null}

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
    <Sheet label={STR.customerRecordPayment} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{STR.customerRecordPayment}</span>
        <SheetClose />
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
    </Sheet>
  )
}
