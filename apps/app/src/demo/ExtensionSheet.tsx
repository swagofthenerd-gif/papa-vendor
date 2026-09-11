import { useMemo, useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import { DAY_MS, bookingDateLabel, telUrl, type ExtensionCollision } from '@papa/core'
import { SwapSheet } from './SwapSheet.tsx'
import { collisionKey, type BookingView } from './bookings.ts'
import { collisionSentence, collisionStarts, collisionSubject, fromLocalInput, toLocalInput } from '../booking-view.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * The extension-collision screen — the highest-value single screen in the
 * research (0022 D10), and the reason the calendar exists.
 *
 * A client wants the gear two days longer. Before anything changes, the
 * new return is previewed against every downstream CONFIRMED promise, and
 * each one that breaks is a card: the unit, who it is promised to, when
 * their hold begins — and the three doors the desk actually has:
 *
 *   Substitute  move THEIR claim onto another free unit of the same
 *               product (reallocate_reservation) — the card disappears
 *               because the collision is genuinely gone;
 *   Sub-rent    record the intent to cover them from a partner house —
 *               the card is settled, the note lands on this booking, and
 *               the extension queues behind the intent op so the server
 *               sees the sub-rent land first (ASSUMPTION #sub-rent-intent);
 *   Call        dial them, or copy the name when the phone has no number.
 *               A call settles nothing by itself — it leads to one of the
 *               other two, or to their booking being changed on its page.
 *
 * Extend is live only once every card is gone or settled. A clean
 * preview says so in words: 'No one is waiting on this gear'.
 */
export function ExtensionSheet({
  store,
  booking,
  onExtended,
  onClose,
}: {
  store: DemoStore
  booking: BookingView
  onExtended: (untilMs: number) => void
  onClose: () => void
}) {
  const nowMs = Date.now()
  const [end, setEnd] = useState(toLocalInput(booking.customerEndMs + DAY_MS))
  const [settled, setSettled] = useState<Map<string, ExtensionCollision>>(new Map())
  const [substituting, setSubstituting] = useState<ExtensionCollision | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const [problem, setProblem] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const endMs = fromLocalInput(end)
  void tick
  const preview = useMemo(
    () => (endMs !== null ? store.extensionPreview(booking.id, endMs, nowMs) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [store, booking.id, endMs, tick],
  )
  const collisions = preview?.collisions ?? []
  const endsBeforeStart = endMs !== null && endMs <= booking.customerStartMs
  const open = collisions.filter((c) => !settled.has(collisionKey(c)))
  const canExtend = endMs !== null && !endsBeforeStart && open.length === 0

  const extend = () => {
    if (endMs === null) return
    const r = store.extendBooking(booking.id, endMs, nowMs, { acknowledged: [...settled.values()] })
    if (!r.extended) {
      setProblem(
        'reason' in r
          ? r.reason === 'ends_before_start' ? STR.bookingExtendEndsBeforeStart
            : r.reason === 'cancelled' ? STR.bookingIsCancelled(booking.bookingNo)
              : STR.bookingNotFound
          : STR.bookingExtendBlocked(r.collisions.length),
      )
      setTick((t) => t + 1)
      return
    }
    onExtended(r.customerEndMs)
  }

  const subRent = (c: ExtensionCollision) => {
    const r = store.noteSubRent(booking.id, {
      productId: c.productId,
      productName: c.productName,
      qty: c.kind === 'bulk' ? c.shortBy : 1,
      forBookingId: c.bookingId,
      forBookingNo: c.bookingNo,
    }, nowMs)
    if (!r.ok) return
    setSettled((prev) => new Map(prev).set(collisionKey(c), c))
  }

  const copyName = (c: ExtensionCollision) => {
    void navigator.clipboard?.writeText(c.customerName).catch(() => {})
    setCopied(collisionKey(c))
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.bookingExtendTitle(booking.bookingNo)}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{STR.bookingExtendTitle(booking.bookingNo)}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>
        <p className="sheet-hint">{STR.bookingExtendHint}</p>

        <label className="field-label" htmlFor="extend-end">{STR.bookingExtendNewEndLabel}</label>
        <input
          id="extend-end"
          className="sheet-search"
          type="datetime-local"
          value={end}
          onChange={(e) => { setEnd(e.target.value); setProblem(null) }}
        />
        <p className="sheet-hint code">
          {STR.bookingUntilLabel} {bookingDateLabel(booking.customerEndMs)}
          {preview ? ` → ${bookingDateLabel(preview.customerEndMs)}` : ''}
        </p>
        {endsBeforeStart ? <p className="sheet-hint">{STR.bookingExtendEndsBeforeStart}</p> : null}

        {!endsBeforeStart && endMs !== null && collisions.length === 0 ? (
          <div className="notice notice-ok">
            <Icon name="check-circle" size={18} />
            <div><strong>{STR.bookingExtendClean}</strong></div>
          </div>
        ) : null}

        {collisions.length > 0 ? (
          <ul className="collision-list">
            {collisions.map((c) => {
              const key = collisionKey(c)
              const done = settled.has(key)
              const phone = store.customerPhone(bookingCustomer(store, c.bookingId))
              return (
                <li key={key} className={`collision-card${done ? ' is-settled' : ''}`}>
                  <div className="collision-head">
                    <span className="code collision-subject">{collisionSubject(c)}</span>
                    {done ? <span className="stamp stamp-pencil">{STR.bookingCardSettled}</span> : <span className="stamp">{STR.bookingStatusConfirmed}</span>}
                  </div>
                  <p className="collision-line">
                    {STR.bookingCollisionCard(c.bookingNo, c.customerName, collisionStarts(c))}
                  </p>
                  {c.kind === 'bulk' ? (
                    <p className="collision-line">{STR.bookingCollisionBulk(c.shortBy, c.productName)}</p>
                  ) : null}
                  {done ? (
                    <p className="sheet-hint">{STR.bookingSubRentNoted}</p>
                  ) : (
                    <div className="collision-doors">
                      <button className="btn btn-sm btn-outline" onClick={() => subRent(c)}>
                        <Icon name="handshake" size={16} /> {STR.bookingDoorSubRent}
                      </button>
                      {c.kind === 'asset' ? (
                        <button className="btn btn-sm btn-outline" onClick={() => setSubstituting(c)}>
                          <Icon name="repeat" size={16} /> {STR.bookingDoorSubstitute}
                        </button>
                      ) : null}
                      {phone ? (
                        <a className="btn btn-sm btn-ghost" href={telUrl(phone)}>
                          <Icon name="phone" size={16} /> {STR.bookingDoorCall}
                        </a>
                      ) : (
                        <button className="btn btn-sm btn-ghost" onClick={() => copyName(c)}>
                          <Icon name="clipboard" size={16} />{' '}
                          {copied === key ? STR.bookingCopied : STR.bookingCopyName}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        ) : null}

        {settled.size > 0 ? <p className="sheet-hint">{STR.bookingSubRentHint}</p> : null}

        {problem ? (
          <div className="notice notice-warn" role="alert">
            <Icon name="warning" size={18} />
            <div><strong>{problem}</strong></div>
          </div>
        ) : null}

        <button className="btn btn-primary btn-lg sheet-submit" disabled={!canExtend} onClick={extend}>
          <Icon name="calendar" size={18} />{' '}
          {open.length > 0 ? STR.bookingExtendBlocked(open.length) : STR.bookingExtendNow}
        </button>
      </div>

      {substituting && substituting.kind === 'asset' ? (
        <SubstituteSheet
          store={store}
          collision={substituting}
          forBookingId={booking.id}
          onDone={() => { setSubstituting(null); setTick((t) => t + 1) }}
          onClose={() => setSubstituting(null)}
        />
      ) : null}
    </div>
  )
}

function bookingCustomer(store: DemoStore, bookingId: string): string {
  return store.booking(bookingId)?.customerId ?? ''
}

/**
 * The substitute door: the swap sheet's own picker, over the rival's
 * reservation. Tapping a unit IS the move; a collision on the new unit
 * is a sentence on this sheet, and nothing moved.
 */
function SubstituteSheet({
  store,
  collision,
  forBookingId,
  onDone,
  onClose,
}: {
  store: DemoStore
  collision: Extract<ExtensionCollision, { kind: 'asset' }>
  forBookingId: string
  onDone: () => void
  onClose: () => void
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const reservationId = store.reservationFor(collision)
  const substitutes = reservationId ? store.substitutesForReservation(reservationId) : []

  if (problem) {
    return (
      <div className="sheet-backdrop" role="dialog" aria-label={STR.bookingDoorSubstitute}>
        <div className="sheet">
          <header className="sheet-head">
            <span className="sheet-title">{STR.bookingDoorSubstitute}</span>
            <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
              <Icon name="x" size={22} />
            </button>
          </header>
          <div className="notice notice-warn" role="alert">
            <Icon name="warning" size={18} />
            <div><strong>{problem}</strong></div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <SwapSheet
      title={STR.bookingSubstituteTitle(collision.assetCode, collision.bookingNo)}
      hint={STR.bookingSubstituteHint(collision.productName)}
      emptyText={STR.bookingSubstituteNone}
      brokenCode={collision.assetCode}
      jobLabel={collision.customerName}
      substitutes={substitutes}
      onPick={(assetId) => {
        if (!reservationId) return
        const r = store.reallocateReservation(reservationId, assetId, forBookingId)
        if (!r.ok) {
          setProblem('collision' in r ? collisionSentence(r.collision) : STR.bookingSubstituteNone)
          return
        }
        onDone()
      }}
      onClose={onClose}
    />
  )
}
