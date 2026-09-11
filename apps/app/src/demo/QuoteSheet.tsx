import { useState } from 'react'
import { Icon } from '@papa/icons'
import { bookingDateLabel, formatRupees, trimNumber, whatsAppShareUrl, type QuoteLine } from '@papa/core'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import type { DemoStore } from './store.ts'
import type { EnquiryLine, QuoteView } from './quotes.ts'
import { STR } from '../strings.ts'

/** What the sheet prices: a booking on this phone, or a kit list that
 *  is not a booking yet. */
export type QuoteSource =
  | { kind: 'booking'; bookingId: string }
  | { kind: 'enquiry'; lines: EnquiryLine[]; startMs: number; endMs: number; customerId: string | null }

/**
 * The Quote sheet — the challan the kit list becomes.
 *
 * Each line typewritten (product · qty · days · rate = total); an
 * unpriced line wears the UNPRICED stamp with the rate field right
 * there, because "tell me the rate" is the desk's next act, not a trip
 * to settings. The trace folds under "How this was worked out": the six
 * steps of 0024 in plain words, so "why Rs 8,000" is answered on the
 * page, never argued from memory. INDICATIVE is a pencilled stamp — the
 * quote is a conversation until it is a confirmed, fully priced
 * booking; VERIFIED is the small stamp beside the client that earns a
 * lighter deposit (0025 D10).
 *
 * The override is the owner's last word (0024 D8): behind a hold, a
 * reason required, the card rate left struck through beside the new
 * number so the discount is always legible.
 */
export function QuoteSheet({
  store,
  source,
  onClose,
  onBook,
  onChanged,
}: {
  store: DemoStore
  source: QuoteSource
  onClose: () => void
  /** The enquiry's "Book it" — the same lines and dates go to the sheet. */
  onBook?: (lines: EnquiryLine[], startMs: number, endMs: number) => void
  /** A rate or an override was written — the page underneath re-reads. */
  onChanged?: () => void
}) {
  const [tick, setTick] = useState(0)
  const [rateDraft, setRateDraft] = useState<Record<string, string>>({})
  const [overriding, setOverriding] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [ovRate, setOvRate] = useState('')
  const [ovReason, setOvReason] = useState('')
  const [said, setSaid] = useState<string | null>(null)
  void tick

  const quote: QuoteView | null = source.kind === 'booking'
    ? store.quoteFor(source.bookingId)
    : store.quoteForLines(source.lines, source.startMs, source.endMs, source.customerId)

  const refresh = () => { setTick((t) => t + 1); onChanged?.() }
  const title = quote?.bookingNo ? STR.quoteSheetTitleFor(quote.bookingNo) : STR.quoteSheetTitle

  if (!quote || quote.lines.length === 0) {
    return (
      <div className="sheet-backdrop" role="dialog" aria-label={title}>
        <div className="sheet">
          <header className="sheet-head">
            <span className="sheet-title">{title}</span>
            <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
              <Icon name="x" size={22} />
            </button>
          </header>
          <p className="sheet-hint">{quote ? STR.quoteNoLines : STR.bookingNotFound}</p>
        </div>
      </div>
    )
  }

  const rs = formatRupees
  const s1 = quote.steps.billableDays
  const s2 = quote.steps.weekRule
  const s3 = quote.steps.cardRates
  const s4 = quote.steps.calendarMultiplier
  const s5 = quote.steps.overrides
  const t = quote.totals

  const setRate = (l: QuoteLine) => {
    if (!l.productId) return
    const rupees = Number(rateDraft[l.productId] ?? '')
    if (!Number.isFinite(rupees) || rupees < 0) return
    const r = store.setRate(l.productId, Math.round(rupees * 100))
    if (r.ok) { setRateDraft((d) => ({ ...d, [l.productId as string]: '' })); refresh() }
  }

  const openOverride = (l: QuoteLine) => {
    setEditing(l.lineId)
    setOvRate(l.override ? String(Math.round(l.override.rateMinor / 100)) : '')
    setOvReason(l.override?.reason ?? '')
    setSaid(null)
  }

  const saveOverride = (l: QuoteLine, clear: boolean) => {
    if (!l.lineId) return
    const rupees = Number(ovRate)
    if (!clear && !(Number.isFinite(rupees) && rupees >= 0)) return
    const r = store.setLineOverride(l.lineId, clear ? null : Math.round(rupees * 100), ovReason)
    if (!r.ok) { setSaid(r.reason === 'needs_reason' ? STR.quoteOverrideNeedsReason : STR.bookingNotFound); return }
    setEditing(null)
    setSaid(null)
    refresh()
  }

  const onSend = () => {
    const text = store.quoteTextOf(quote)
    const win = window.open(whatsAppShareUrl(text), '_blank', 'noopener')
    if (!win) {
      void navigator.clipboard?.writeText(text).catch(() => {})
      setSaid(STR.quoteCopied)
    }
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={title}>
      <div className="sheet quote-sheet">
        <header className="sheet-head">
          <span className="sheet-title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>

        <div className="quote-head">
          <span className="code">
            {bookingDateLabel(quote.customerStartMs)} → {bookingDateLabel(quote.customerEndMs)}
          </span>
          <span className="quote-stamps">
            {t.indicative ? <span className="stamp stamp-pencil stamp-small">{STR.quoteStampIndicative}</span> : null}
            {quote.flags?.verified && !quote.flags.blacklisted
              ? <span className="stamp stamp-small">{STR.quoteStampVerified}</span> : null}
          </span>
        </div>
        {quote.customerName ? <p className="section-sub">{quote.customerName}</p> : null}

        <ul className="line-list quote-lines">
          {quote.lines.map((l, i) => {
            const key = l.lineId ?? `${l.productId ?? 'x'}-${i}`
            const name = l.assetCode ? `${l.productName} ${l.assetCode}` : l.productName
            return (
              <li key={key} className={`line quote-line${l.priced ? '' : ' is-unpriced'}`}>
                <span className="line-name">{name}</span>
                {l.priced && l.effectiveRateMinor !== null ? (
                  <>
                    <span className="line-code code quote-line-total">{rs(l.lineTotalMinor ?? 0)}</span>
                    <span className="line-note code">
                      {l.override && l.override.originalRateMinor !== null ? (
                        <s className="quote-strike">{rs(l.override.originalRateMinor)}</s>
                      ) : null}
                      {l.override && l.override.originalRateMinor !== null ? ' ' : ''}
                      {STR.quoteLineDays(l.qty, l.billableDays, rs(l.effectiveRateMinor))}
                      {l.multiplierApplied && l.multiplier !== 1 ? ` × ${trimNumber(l.multiplier)}` : ''}
                    </span>
                    {l.override?.reason ? (
                      <span className="line-note">{STR.quoteLineOverridden(l.override.reason)}</span>
                    ) : null}
                  </>
                ) : (
                  <>
                    <span className="line-code quote-line-total">
                      <span className="stamp stamp-small">{STR.quoteStampUnpriced}</span>
                    </span>
                    <span className="line-note code">{STR.quoteLineDays(l.qty, l.billableDays, '—')}</span>
                    {l.productId && !l.override ? (
                      <span className="quote-rate-field">
                        <input
                          className="sheet-search code"
                          inputMode="numeric"
                          aria-label={STR.quoteRateFieldLabel(l.productName)}
                          placeholder={STR.quoteRateFieldPlaceholder}
                          value={rateDraft[l.productId] ?? ''}
                          onChange={(e) => setRateDraft((d) => ({ ...d, [l.productId as string]: e.target.value }))}
                          onKeyDown={(e) => { if (e.key === 'Enter') setRate(l) }}
                        />
                        <button className="btn btn-sm btn-outline" onClick={() => setRate(l)}>
                          {STR.quoteRateSave}
                        </button>
                      </span>
                    ) : null}
                  </>
                )}
                {overriding && l.lineId && editing !== l.lineId ? (
                  <span className="quote-rate-field">
                    <button className="btn btn-sm btn-ghost" onClick={() => openOverride(l)}>
                      <Icon name="wrench" size={16} /> {STR.quoteOverrideDoor}
                    </button>
                  </span>
                ) : null}
                {editing === l.lineId && l.lineId ? (
                  <div className="quote-override">
                    <span className="field-label">{STR.quoteOverrideTitle(name)}</span>
                    <label className="field-label" htmlFor={`ov-rate-${l.lineId}`}>{STR.quoteOverrideRateLabel}</label>
                    <input
                      id={`ov-rate-${l.lineId}`}
                      className="sheet-search code"
                      inputMode="numeric"
                      value={ovRate}
                      onChange={(e) => setOvRate(e.target.value)}
                    />
                    <label className="field-label" htmlFor={`ov-reason-${l.lineId}`}>{STR.quoteOverrideReasonLabel}</label>
                    <input
                      id={`ov-reason-${l.lineId}`}
                      className="sheet-search"
                      value={ovReason}
                      onChange={(e) => setOvReason(e.target.value)}
                      placeholder={STR.quoteOverrideReasonPlaceholder}
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <div className="session-actions">
                      <button className="btn btn-primary btn-block" onClick={() => saveOverride(l, false)}>
                        {STR.quoteOverrideSave}
                      </button>
                      {l.override ? (
                        <button className="btn btn-ghost btn-block" onClick={() => saveOverride(l, true)}>
                          {STR.quoteOverrideClear}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </li>
            )
          })}
        </ul>

        <div className="tally quote-tally">
          <p className="tally-line">
            <span>{STR.quoteTotalLabel}</span>
            <strong className="code">
              {rs(t.subtotalMinor)}
              {t.unpricedCount > 0 ? <span className="tally-short"> {STR.quoteTotalUnpriced(t.unpricedCount)}</span> : null}
            </strong>
          </p>
          {t.subHireCostMinor > 0 ? (
            <p className="tally-sub code">{STR.quoteSubHireLine(rs(t.subHireCostMinor), rs(t.marginMinor))}</p>
          ) : null}
          {quote.flags ? (
            <p className="tally-sub">{STR.quoteDepositLabel}: {STR.quoteDepositHint(quote.flags.depositHint)}</p>
          ) : null}
          {t.unpricedCount > 0 ? (
            <p className="tally-sub">{STR.quoteIndicativeUnpriced(t.unpricedCount)}</p>
          ) : t.indicative ? (
            <p className="tally-sub">{STR.quoteIndicativeNotConfirmed}</p>
          ) : null}
        </div>

        <details className="quote-trace">
          <summary>{STR.quoteHowHeading}</summary>
          <ol className="quote-steps">
            <li>{STR.quoteStepDays(s1.calendarDays, s1.firstDay)}</li>
            {s1.weekendDaysDropped > 0 ? (
              <li>{STR.quoteStepWeekendDropped(s1.weekendDaysDropped, s1.droppedDates.join(', '))}</li>
            ) : null}
            {s1.minApplied ? <li>{STR.quoteStepMinApplied(s1.minBillableDays)}</li> : null}
            <li>{STR.quoteStepWeekRule(s2.billableDays, s1.countedDays, s2.weeks, s2.weekEqualsDays, s2.remainderDays)}</li>
            <li>
              {quote.rateCard
                ? STR.quoteStepCardRates(s3.pricedLines, s3.unpricedLines, quote.rateCard.name)
                : STR.quoteStepNoCard}
            </li>
            <li>
              {s4.drivenBy && s4.multiplier !== 1
                ? STR.quoteStepMultiplier(s4.drivenBy.name, s4.drivenBy.day, `×${trimNumber(s4.multiplier)}`)
                : STR.quoteStepMultiplierNone}
            </li>
            {s5.overriddenLines > 0 ? <li>{STR.quoteStepOverrides(s5.overriddenLines)}</li> : null}
          </ol>
        </details>

        {said ? (
          <div className="notice notice-warn" role="status">
            <Icon name="warning" size={18} />
            <div><strong>{said}</strong></div>
          </div>
        ) : null}

        <div className="session-actions">
          <button className="btn btn-primary btn-block" onClick={onSend}>
            <Icon name="send" size={18} /> {STR.quoteDoorSend}
          </button>
          {source.kind === 'enquiry' && onBook ? (
            <button
              className="btn btn-outline btn-block"
              onClick={() => onBook(source.lines, source.startMs, source.endMs)}
            >
              <Icon name="calendar" size={18} /> {STR.quoteDoorBook}
            </button>
          ) : null}
        </div>

        {source.kind === 'booking' && !overriding ? (
          <div className="fleet-disclosure quote-override-door">
            <p className="section-sub">{STR.quoteOverrideHint}</p>
            <HoldToFinish label={STR.quoteOverrideDoor} onFinish={() => setOverriding(true)} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
