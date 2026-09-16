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
import { HoldToFinish } from '../components/HoldToFinish.tsx'
// --- W13 the money doors
import { DepositSection } from './DepositSection.tsx'
import { LineSheet } from './CorrectionSheet.tsx'
import { BlacklistSection } from './BlacklistSection.tsx'
import type { LedgerRow, LifetimeValue } from './khata.ts'

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

      {/* The do-not-rent stamp (W13, `no-blacklist`): the loudest thing
          the page can say, so it is a rubber stamp and it sits directly
          under the figure, where the eye already is. */}
      {customer.blacklisted ? (
        <p className="khata-refused">
          <span className="stamp">{STR.moneyBlacklistStamp}</span>
          <span className="line-note">
            {STR.moneyBlacklistLine(
              customer.blacklistedAt === null ? '—' : ledgerDate(customer.blacklistedAt),
              customer.blacklistReason,
            )}
          </span>
        </p>
      ) : null}

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
                        {/* A late fee settled by a write-off is a WAIVER,
                            and it gets the waiver's own sentence (W13,
                            `waived-fee-invisible`): 'Rs 4,000 late fee —
                            waived on 12 Sep', the thing nobody could
                            remember next quarter. */}
                        {e.kind === 'late_fee' && settled.kind === 'write_off'
                          ? STR.moneyFeeWaived(
                              formatRupees(e.amountMinor),
                              ledgerDate(settled.createdAt),
                              settled.note,
                            )
                          : STR.moneySettledLine(
                              STR.customerKindLabel(settled.kind),
                              ledgerDate(settled.createdAt),
                              settled.note,
                            )}
                      </li>
                    </ul>
                  ) : null}
                </>
              )
              // Plain `.line`, not `.line-stack`: the amount belongs in the
              // money column on the right like every other ledger row, and
              // the settlement's sub-line spans the grid itself
              // (`.line-why { grid-column: 1 / -1 }`).
              const cls = `line${settled ? ' line-settled' : ''}`
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

      {/* What this client has been worth (W13, `no-lifetime-value-view`):
          the figures were always in the entries this page already loads;
          the page just never showed them. Below the book, because it is
          a summary OF the book, and above the jobs, because "is this
          client worth keeping" is the question the jobs answer. */}
      <WorthSection worth={store.lifetimeValue(customerId)} />

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

      {/* The decision itself (W13): at the bottom, because it is the
          rarest act on the page and the one that must never be a
          mis-tap — behind a hold, with a reason, like every refusal. */}
      {/* Write off what is owed (W13): the account-level answer the
          line-scoped door cannot give, because a payment on a running
          account is not attached to one charge. Down here with the
          do-not-rent decision — both are things a desk does once, about a
          client rather than about a line. */}
      {customer.balanceMinor > 0 ? (
        <BalanceWriteOff
          rupees={formatRupees(customer.balanceMinor)}
          onWriteOff={(reason) => {
            store.writeOffBalance(customerId, reason)
            setTick((t) => t + 1)
          }}
        />
      ) : null}

      <BlacklistSection
        store={store}
        customerId={customerId}
        blacklisted={customer.blacklisted}
        reason={customer.blacklistReason}
        sinceMs={customer.blacklistedAt}
        onWrite={() => setTick((t) => t + 1)}
      />

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
 * "Write off what is owed" (W13) — the whole balance, given up.
 *
 * Reveal-then-hold, like every other settlement: the button opens a
 * reason field and a hold, because forgiving a client's debt is a
 * decision the house makes once and lives with. The figure is in the
 * hold's own label, so the thumb that finishes it has read the number.
 */
function BalanceWriteOff({
  rupees,
  onWriteOff,
}: {
  rupees: string
  onWriteOff: (reason: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')

  if (!open) {
    return (
      <div className="session-actions">
        <button className="btn btn-ghost btn-block" onClick={() => setOpen(true)}>
          <Icon name="hand" size={18} /> {STR.moneyWriteOffBalance}
        </button>
      </div>
    )
  }
  return (
    <section className="section">
      <SectionHead icon="hand" title={STR.moneyWriteOffBalanceTitle} />
      <p className="section-sub">{STR.moneyWriteOffBalanceWhat}</p>
      <label className="field-label" htmlFor="writeoff-balance-why">{STR.moneyReasonLabel}</label>
      <input
        id="writeoff-balance-why"
        className="sheet-search"
        value={reason}
        placeholder={STR.moneyWriteOffBalanceReasonPlaceholder}
        onChange={(e) => setReason(e.target.value)}
        autoCorrect="off"
        spellCheck={false}
      />
      <HoldToFinish
        label={STR.moneyWriteOffBalanceHold(rupees)}
        disabled={reason.trim().length === 0}
        onFinish={() => { onWriteOff(reason.trim()); setOpen(false) }}
      />
    </section>
  )
}

/**
 * What this client has been worth (W13, `no-lifetime-value-view`).
 *
 * Billed, paid, written off, the jobs the money touched, the span of the
 * relationship and the average job — every one a sum over the
 * append-only book, so nothing here can drift from the rows above it. A
 * reversed charge and a waived fee are not worth: the house never had
 * that money.
 *
 * THE LIMIT IS ON THE SCREEN. This is what this phone's book knows, and
 * the section says so under the figures: a khata that started before the
 * app is a longer relationship than the numbers can show.
 */
function WorthSection({ worth }: { worth: LifetimeValue }) {
  if (worth.firstAt === null) {
    return (
      <section className="section">
        <SectionHead icon="trophy" title={STR.moneyWorthHeading} sub={STR.moneyWorthNothing} />
      </section>
    )
  }
  const span =
    worth.lastAt === null || worth.lastAt === worth.firstAt
      ? STR.moneyWorthFirstOnly(ledgerDate(worth.firstAt))
      : STR.moneyWorthSpan(ledgerDate(worth.firstAt), ledgerDate(worth.lastAt))

  return (
    <section className="section">
      <SectionHead icon="trophy" title={STR.moneyWorthHeading} sub={span} />
      <ul className="line-list">
        <li className="line">
          <span className="line-name">{STR.moneyWorthCharged}</span>
          <span className="line-code code">{formatRupees(worth.chargedMinor)}</span>
        </li>
        <li className="line">
          <span className="line-name">{STR.moneyWorthPaid}</span>
          <span className="line-code code">{formatRupees(worth.paidMinor)}</span>
        </li>
        {/* Only when there is one: a zero write-off column invites the
            reader to wonder what it means. */}
        {worth.writtenOffMinor > 0 ? (
          <li className="line">
            <span className="line-name">{STR.moneyWorthWrittenOff}</span>
            <span className="line-code code">{formatRupees(worth.writtenOffMinor)}</span>
          </li>
        ) : null}
        <li className="line">
          <span className="line-name">{STR.moneyWorthJobs}</span>
          <span className="line-code code">{worth.jobs}</span>
        </li>
        <li className="line">
          <span className="line-name">{STR.moneyWorthAverage}</span>
          {/* No average against a zero denominator — the honesty rule the
              payback bar keeps (@papa/core paybackPercent). */}
          <span className="line-code code">
            {worth.averageJobMinor === null
              ? STR.moneyWorthNoAverage
              : formatRupees(worth.averageJobMinor)}
          </span>
        </li>
      </ul>
      <p className="section-sub">{STR.moneyWorthLimit}</p>
    </section>
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
