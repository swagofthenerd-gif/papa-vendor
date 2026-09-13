import { Icon } from '@papa/icons'
import { bookingDateLabel } from '@papa/core'
import { go } from '../nav.ts'
import type { BookingRow } from './bookings.ts'
import { STR } from '../strings.ts'

/**
 * The booking vocabulary every list shares — one stamp, one row — so the
 * calendar's day list, the desk's list and the Today board's Promised
 * section cannot drift into three readings of "pencil".
 *
 * THE STAMP. A confirmed booking is the rubber stamp proper: margin-red,
 * crooked, the one loud thing in the book. A pencil is exactly that — a
 * pencilled note, grey and dashed, because a pencil is a conversation and
 * must never read as a promise. An expired or cancelled one is the pencil
 * struck through. The countdown chip beside a live pencil is recomputed
 * by the caller from the stored expiry and an injected clock.
 */
export function BookingStamp({ row }: { row: Pick<BookingRow, 'stamp' | 'pencil'> }) {
  switch (row.stamp) {
    case 'confirmed':
      // Keyed by status: a change of word is a fresh stamp, and the
      // 120ms landing (app.css .stamp) plays exactly then.
      return <span key="confirmed" className="stamp">{STR.bookingStatusConfirmed}</span>
    case 'pencil':
      return (
        <span key="pencil" className="stamp stamp-pencil">
          {STR.bookingPencilLeft(row.pencil.hours, row.pencil.minutes)}
        </span>
      )
    case 'expired':
      return <span key="expired" className="stamp stamp-struck">{STR.bookingStatusExpired}</span>
    case 'cancelled':
      return <span key="cancelled" className="stamp stamp-struck">{STR.bookingStatusCancelled}</span>
    default:
      return <span className="badge">{STR.bookingStatusDraft}</span>
  }
}

/** #no · customer · N items · the stamp — one tap opens the page. */
export function BookingListRow({ row }: { row: BookingRow }) {
  return (
    <li>
      <button
        className="line line-tap pressable booking-line"
        onClick={() => go({ name: 'booking', bookingId: row.id })}
      >
        <span className="line-name">
          <span className="code booking-no">{STR.bookingRowNo(row.bookingNo)}</span>{' '}
          {row.customerName}
        </span>
        <span className="line-note">
          {bookingDateLabel(row.customerStartMs)} · {STR.bookingItems(row.itemCount)}
        </span>
        <span className="line-code booking-line-stamp">
          <BookingStamp row={row} />
        </span>
      </button>
    </li>
  )
}

export function BookingList({
  rows,
  onNew,
  emptyText = STR.bookingNoneYet,
}: {
  rows: BookingRow[]
  /** The one door that fills an empty list: the new-booking sheet. */
  onNew?: () => void
  emptyText?: string
}) {
  if (rows.length === 0) {
    return (
      <div className="empty">
        <Icon name="calendar" size={36} />
        <p>{emptyText}</p>
        {onNew ? (
          <button className="btn btn-outline" onClick={onNew}>
            <Icon name="clapperboard" size={18} /> {STR.bookingNew}
          </button>
        ) : null}
      </div>
    )
  }
  return (
    <ul className="line-list">
      {rows.map((r) => (
        <BookingListRow key={r.id} row={r} />
      ))}
    </ul>
  )
}
