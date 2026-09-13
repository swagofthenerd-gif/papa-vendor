import { useState } from 'react'
import { Icon } from '@papa/icons'
import { Shell, SectionHead, SettingsButton } from '../components/Shell.tsx'
import { EnquiryScreen } from './EnquiryScreen.tsx'
import { BookingList } from './BookingRows.tsx'
import { NewBookingSheet, type PrefillLine } from './NewBookingSheet.tsx'
import { monthLabel, monthStartOf } from '../booking-view.ts'
import { go } from '../nav.ts'
import { monthCounts } from './bookings.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * The Desk — the client-facing tab: what a client asked for, and what
 * has been promised.
 *
 * Top to bottom: the kit-list reader exactly as it was (the only inbound
 * WhatsApp path in the product), then the calendar's door with this
 * month's two counts, then the live bookings soonest first. The reader's
 * answer can become a booking straight from its foot — the matched lines
 * arrive on the sheet prefilled — which is the loop the desk actually
 * runs: read the list, check the shelf AND the calendar, pencil it in,
 * reply.
 */
export function DeskScreen({ store }: { store: DemoStore }) {
  const [tick, setTick] = useState(0)
  const [booking, setBooking] = useState<{ lines: PrefillLine[]; window?: { startMs: number; endMs: number } } | null>(null)
  void tick
  const nowMs = Date.now()
  const monthMs = monthStartOf(nowMs)
  const counts = monthCounts(store.calendar(monthMs, nowMs))
  const live = store.bookings({ status: 'live' }, nowMs)

  return (
    <Shell
      view={{ name: 'desk' }}
      title={STR.bookingDeskTitle}
      subtitle={STR.bookingDeskSubtitle}
      action={<SettingsButton />}
    >
      <section className="section">
        <SectionHead icon="chat" title={STR.bookingKitListHeading} sub={STR.bookingKitListSub} />
        <EnquiryScreen store={store} onBook={(lines, window) => setBooking({ lines, window })} />
      </section>

      <section className="section">
        <SectionHead
          icon="calendar"
          title={STR.bookingCalendarHeading}
          sub={`${monthLabel(monthMs)} · ${STR.bookingMonthCounts(counts.confirmed, counts.pencilled)}`}
          action={
            <button className="btn btn-sm btn-outline" onClick={() => setBooking({ lines: [] })}>
              <Icon name="clapperboard" size={16} /> {STR.bookingNew}
            </button>
          }
        />
        <button className="btn btn-ghost btn-block" onClick={() => go({ name: 'calendar' })}>
          <Icon name="calendar" size={18} /> {STR.bookingOpenCalendar}
        </button>
      </section>

      <section className="section">
        <SectionHead icon="scroll" title={STR.bookingListHeading} sub={STR.bookingListSub(live.length)} />
        <BookingList rows={live} onNew={() => setBooking({ lines: [] })} />
      </section>

      {booking ? (
        <NewBookingSheet
          store={store}
          prefill={booking.lines}
          initialWindow={booking.window}
          onDone={(id) => {
            setBooking(null)
            setTick((t) => t + 1)
            if (id) go({ name: 'booking', bookingId: id })
          }}
          onClose={() => setBooking(null)}
        />
      ) : null}
    </Shell>
  )
}
