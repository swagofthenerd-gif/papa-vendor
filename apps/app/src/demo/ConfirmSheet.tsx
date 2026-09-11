import { useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import { bookingDateLabel, formatRupees } from '@papa/core'
import { explainConfirmRefusal } from '../booking-view.ts'
import type { DemoStore } from './store.ts'
import type { BookingView, ConfirmPlan } from './bookings.ts'
import { STR } from '../strings.ts'
// --- network --- (0025): the `short` refusal's door.
import { AskTheMarketSheet, type Shortage } from './AskTheMarketSheet.tsx'

/**
 * The Confirm sheet — what confirming WOULD do, then the one button.
 *
 * Per line, the three-layer answer over the hold window (0022 D6): here
 * now, pencilled, confirmed for these dates — the desk sees all three
 * numbers and applies judgement; the plan underneath applies the law.
 * The allocation preview names the exact units confirm will bind
 * (least-utilised first, D4), so 'FX9-02' is on screen before it is on
 * the client's WhatsApp.
 *
 * The buffer toggle is override 7: a same-day turnaround holds the fleet
 * for exactly the client's dates. The credential gate (D9) shows as a
 * notice with the manager's note field, never as a dead button: the
 * refusal says what it needs, and the note is the override.
 */
export function ConfirmSheet({
  store,
  booking,
  onConfirmed,
  onClose,
}: {
  store: DemoStore
  booking: BookingView
  onConfirmed: (codes: string) => void
  onClose: () => void
}) {
  const [sameDay, setSameDay] = useState(false)
  const [overrideNote, setOverrideNote] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [asking, setAsking] = useState<Shortage[] | null>(null) // --- network ---
  const nowMs = Date.now()

  const opts = {
    blockedPeriod: sameDay ? { startMs: booking.customerStartMs, endMs: booking.customerEndMs } : null,
    credentialOverrideNote: overrideNote.trim() || null,
  }
  const plan: ConfirmPlan = useMemo(
    () => store.planConfirm(booking.id, opts, nowMs),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, booking.id, sameDay, overrideNote],
  )
  const holdStart = plan.ok ? plan.blockedStartMs : (sameDay ? booking.customerStartMs : booking.blockedStartMs)
  const holdEnd = plan.ok ? plan.blockedEndMs : (sameDay ? booking.customerEndMs : booking.blockedEndMs)

  const layers = useMemo(
    () => booking.lines.map((l) => {
      const productId = l.productId ?? productOfAsset(store, l.assetId)
      return productId ? store.availabilityFor(productId, holdStart, holdEnd, nowMs) : null
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, booking, holdStart, holdEnd],
  )

  const gate = !plan.ok && 'reason' in plan && plan.reason === 'needs_credentials' ? plan : null
  // --- network --- a shortfall is a question for the partner houses.
  const short = !plan.ok && 'reason' in plan && plan.reason === 'short' ? plan.short : null
  const refusal = !plan.ok && !gate ? explainConfirmRefusal(plan, booking.bookingNo) : null

  const confirm = () => {
    const r = store.confirmBooking(booking.id, opts, nowMs)
    if (!r.ok) { setProblem(explainConfirmRefusal(r, booking.bookingNo)); return }
    onConfirmed(r.allocations.map((a) => a.assetCode).join(', '))
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.bookingConfirmSheetTitle(booking.bookingNo)}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{STR.bookingConfirmSheetTitle(booking.bookingNo)}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>
        <p className="sheet-hint">{STR.bookingConfirmSheetHint}</p>

        <ul className="line-list">
          {booking.lines.map((l, i) => {
            const layer = layers[i]
            const planned = plan.ok ? plan.plan.filter((p) => p.lineId === l.id) : []
            const bulk = plan.ok ? plan.bulkPlan.find((p) => p.lineId === l.id) : undefined
            return (
              <li key={l.id} className="line line-stack">
                <span className="line-name">
                  {l.assetCode
                    ? STR.bookingLineDemanded(l.assetCode)
                    : STR.bookingLineQty(l.qty, l.productName)}
                </span>
                {layer ? (
                  <span className="line-note">
                    {STR.bookingLayerLine(layer.hereNow, layer.pencilledOverlap, layer.confirmedOverlap)}
                  </span>
                ) : null}
                {planned.length > 0 ? (
                  <span className="line-note code">
                    {STR.bookingWillTake(planned.map((p) => p.assetCode).join(', '))}
                  </span>
                ) : bulk ? (
                  <span className="line-note">{STR.bookingWillHold(bulk.qty)}</span>
                ) : null}
              </li>
            )
          })}
        </ul>

        <label className="toggle-row">
          <input
            type="checkbox"
            checked={sameDay}
            onChange={(e) => setSameDay(e.target.checked)}
          />
          <span>
            <strong>{STR.bookingSameDayTurnaround}</strong>
            <span className="sheet-hint">{STR.bookingSameDayHint}</span>
          </span>
        </label>
        <p className="sheet-hint code">
          {STR.bookingHoldWindow(bookingDateLabel(holdStart), bookingDateLabel(holdEnd))}
        </p>

        {gate ? (
          <>
            <div className="notice notice-warn">
              <Icon name="shield" size={18} />
              <div>
                <strong>{STR.bookingNeedsCredentials(formatRupees(gate.exposureMinor))}</strong>
              </div>
            </div>
            <label className="field-label" htmlFor="confirm-override">{STR.bookingOverrideNoteLabel}</label>
            <input
              id="confirm-override"
              className="sheet-search"
              value={overrideNote}
              onChange={(e) => setOverrideNote(e.target.value)}
              placeholder={STR.bookingOverrideNotePlaceholder}
              autoCorrect="off"
              spellCheck={false}
            />
          </>
        ) : null}

        {refusal || problem ? (
          <div className="notice notice-warn" role="alert">
            <Icon name="warning" size={18} />
            <div><strong>{problem ?? refusal}</strong></div>
          </div>
        ) : null}
        {short ? (
          <button
            className="btn btn-outline btn-block"
            onClick={() => setAsking([{
              productId: short.productId,
              productName: short.productName,
              qty: Math.max(1, short.wanted - short.available),
              fromMs: holdStart,
              untilMs: holdEnd,
              bookingId: booking.id,
            }])}
          >
            <Icon name="handshake" size={18} /> {STR.networkAskMarket}
          </button>
        ) : null}

        <button
          className="btn btn-primary btn-lg sheet-submit"
          disabled={!plan.ok}
          onClick={confirm}
        >
          <Icon name="check" size={18} /> {STR.bookingConfirmNow}
        </button>
      </div>
      {asking ? (
        <AskTheMarketSheet store={store} shortage={asking} onClose={() => setAsking(null)} />
      ) : null}
    </div>
  )
}

function productOfAsset(store: DemoStore, assetId: string | null): string | null {
  if (!assetId) return null
  return store.assetView(assetId)?.productId ?? null
}
