import { useEffect, useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import { bookingDateLabel, whatsAppShareUrl } from '@papa/core'
import { Shell, SectionHead, SettingsButton } from '../components/Shell.tsx'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import { BookingStamp } from './BookingRows.tsx'
import { ConfirmSheet } from './ConfirmSheet.tsx'
import { ExtensionSheet } from './ExtensionSheet.tsx'
import { go, type View } from '../nav.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * One booking's page — the promise, written out.
 *
 * Identity first (the number in the typewritten voice, the customer as a
 * door to the khata, the period in the calendar's one date voice), then
 * the stamp: CONFIRMED in red, a PENCIL with its live countdown, EXPIRED
 * or CANCELLED struck through. The countdown is recomputed once a minute
 * from the stored expiry — the CONTRIBUTING clock rule; nothing here
 * counts down on its own.
 *
 * The doors follow the app's placement rule: the writes that move the
 * day forward (Confirm, Extend, Convert) sit together; the share button
 * is read-only and sits apart; Cancel is destructive and lives at the
 * very bottom behind a hold, with its reason field, well away from
 * everything a thumb taps often.
 */
export function BookingScreen({ store, bookingId }: { store: DemoStore; bookingId: string }) {
  const view: View = { name: 'booking', bookingId }
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [, setTick] = useState(0)
  const [sheet, setSheet] = useState<'confirm' | 'extend' | null>(null)
  const [said, setSaid] = useState<string | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [cancelOpen, setCancelOpen] = useState(false)
  const saidTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const refresh = () => { setNowMs(Date.now()); setTick((t) => t + 1) }
  const say = (text: string) => {
    setSaid(text)
    if (saidTimer.current) clearTimeout(saidTimer.current)
    saidTimer.current = setTimeout(() => setSaid(null), 4000)
  }

  const b = store.booking(bookingId, nowMs)

  if (!b) {
    return (
      <Shell view={view} title={STR.bookingListHeading}>
        <div className="empty">
          <Icon name="question" size={36} />
          <p>{STR.bookingNoSuchBooking}</p>
          <button className="btn btn-ghost" onClick={() => go({ name: 'calendar' })}>
            {STR.bookingBackToCalendar}
          </button>
        </div>
      </Shell>
    )
  }

  const live = b.stamp === 'pencil' || b.stamp === 'confirmed' || b.stamp === 'draft'
  const confirmed = b.stamp === 'confirmed'

  const onSend = () => {
    const text = store.bookingConfirmText(bookingId, nowMs)
    if (!text) return
    const win = window.open(whatsAppShareUrl(text), '_blank', 'noopener')
    if (!win) void navigator.clipboard?.writeText(text).catch(() => {})
  }

  const onConvert = () => {
    const r = store.convertBookingToJob(bookingId, nowMs)
    if (!r.ok) {
      say(r.reason === 'already_has_job' ? STR.bookingConvertAlreadyJob
        : r.reason === 'not_confirmed' ? STR.bookingConvertNotConfirmed : STR.bookingNotFound)
      return
    }
    // The new job's home is the board — land on it ready to scan.
    go({ name: 'jobs' })
  }

  const onCancel = () => {
    const r = store.cancelBooking(bookingId, cancelReason.trim() || null, nowMs)
    if (!r.ok) {
      say(r.reason === 'job_open' ? STR.bookingJobOpen(b.bookingNo, r.jobLabel)
        : r.reason === 'already_cancelled' ? STR.bookingIsCancelled(b.bookingNo) : STR.bookingNotFound)
      return
    }
    setCancelOpen(false)
    refresh()
  }

  return (
    <Shell
      view={view}
      title={STR.bookingTitle(b.bookingNo)}
      subtitle={b.customerName}
      action={
        <>
          <button className="icon-btn" onClick={() => go({ name: 'calendar' })} aria-label={STR.bookingBackToCalendar}>
            <Icon name="chevron-left" size={22} />
          </button>
          <SettingsButton />
        </>
      }
    >
      <div className="asset-head booking-head">
        <div className="asset-id">
          <span className="asset-code code">{STR.bookingRowNo(b.bookingNo)}</span>
          <BookingStamp row={b} />
        </div>
        <button
          className="btn btn-sm btn-ghost"
          onClick={() => go({ name: 'customer', customerId: b.customerId })}
          aria-label={STR.todayOpenKhataAria(b.customerName)}
        >
          <Icon name="user" size={16} /> {b.customerName}
        </button>
        {b.season === 'wedding' ? <span className="badge badge-orange">{STR.bookingSeasonWedding}</span> : null}
      </div>

      <dl className="fact-grid">
        <div className="fact">
          <dt>{STR.bookingFromLabel}</dt>
          <dd className="code">{bookingDateLabel(b.customerStartMs)}</dd>
        </div>
        <div className="fact">
          <dt>{STR.bookingUntilLabel}</dt>
          <dd className="code">{bookingDateLabel(b.customerEndMs)}</dd>
        </div>
      </dl>
      {confirmed ? (
        <p className="section-sub">{STR.bookingHeldUntil(bookingDateLabel(b.blockedEndMs))}</p>
      ) : null}
      {b.stamp === 'expired' ? <p className="section-sub">{STR.bookingExpiredHint}</p> : null}
      {b.stamp === 'cancelled' && b.cancelReason ? (
        <p className="section-sub">{STR.bookingCancelReason(b.cancelReason)}</p>
      ) : null}

      {b.job ? (
        <div className="notice notice-ok">
          <Icon name="truck" size={18} />
          <div>
            <strong>{STR.bookingOnJob(b.job.label)}</strong>
            <p>
              <button className="btn btn-sm btn-ghost" onClick={() => go({ name: 'scan', jobId: b.job!.id, mode: 'out' })}>
                {STR.bookingOpenJob}
              </button>
            </p>
          </div>
        </div>
      ) : null}

      <section className="section">
        <SectionHead icon="box" title={STR.bookingLinesHeading} sub={STR.bookingItems(b.itemCount)} />
        <ul className="line-list">
          {b.lines.map((l) => (
            <li key={l.id} className="line">
              <span className="line-name">
                {l.assetCode ? STR.bookingLineDemanded(l.assetCode) : STR.bookingLineQty(l.qty, l.productName)}
              </span>
              <span className="line-note">
                {l.allocated.length > 0
                  ? <span className="code">{STR.bookingLineAllocated(l.allocated.map((a) => a.assetCode).join(', '))}</span>
                  : confirmed ? null : STR.bookingLineUnallocated}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {b.note ? (
        <section className="section">
          <SectionHead icon="scroll" title={STR.bookingNoteHeading} />
          <p className="booking-note">{b.note}</p>
        </section>
      ) : null}

      {said ? (
        <div className="notice notice-warn" role="status">
          <Icon name="warning" size={18} />
          <div><strong>{said}</strong></div>
        </div>
      ) : null}

      {live ? (
        <section className="section">
          <p className="section-sub">{STR.bookingWaitingToSend}</p>
          <div className="session-actions">
            {!confirmed ? (
              <button className="btn btn-primary btn-block" onClick={() => setSheet('confirm')}>
                <Icon name="check" size={18} /> {STR.bookingDoorConfirm}
              </button>
            ) : null}
            {confirmed ? (
              <button className="btn btn-outline btn-block" onClick={() => setSheet('extend')}>
                <Icon name="calendar" size={18} /> {STR.bookingDoorExtend}
              </button>
            ) : null}
            {confirmed && !b.job ? (
              <button className="btn btn-outline btn-block" onClick={onConvert}>
                <Icon name="truck" size={18} /> {STR.bookingDoorConvert}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {confirmed ? (
        <section className="section">
          <button className="btn btn-ghost btn-block" onClick={onSend}>
            <Icon name="send" size={18} /> {STR.bookingDoorSend}
          </button>
        </section>
      ) : null}

      {live ? (
        <section className="section fleet-danger">
          {cancelOpen ? (
            <div className="fleet-mark">
              <label className="field-label" htmlFor="cancel-reason">{STR.bookingCancelReasonLabel}</label>
              <input
                id="cancel-reason"
                className="sheet-search"
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                placeholder={STR.bookingCancelReasonPlaceholder}
                autoCorrect="off"
                spellCheck={false}
              />
              <button className="btn btn-danger btn-block" onClick={onCancel}>
                {STR.bookingDoorCancel}
              </button>
            </div>
          ) : (
            <div className="fleet-disclosure">
              <p className="section-sub">{STR.bookingCancelHint}</p>
              <HoldToFinish label={STR.bookingDoorCancel} onFinish={() => setCancelOpen(true)} />
            </div>
          )}
        </section>
      ) : null}

      {sheet === 'confirm' ? (
        <ConfirmSheet
          store={store}
          booking={b}
          onConfirmed={(codes) => {
            setSheet(null)
            refresh()
            say(codes ? `${STR.bookingConfirmed(b.bookingNo)} — ${STR.bookingConfirmedWith(codes)}` : STR.bookingConfirmed(b.bookingNo))
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'extend' ? (
        <ExtensionSheet
          store={store}
          booking={b}
          onExtended={(untilMs) => {
            setSheet(null)
            refresh()
            say(STR.bookingExtended(b.bookingNo, bookingDateLabel(untilMs)))
          }}
          onClose={() => { setSheet(null); refresh() }}
        />
      ) : null}
    </Shell>
  )
}
