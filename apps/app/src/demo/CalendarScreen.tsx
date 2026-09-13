import { useEffect, useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import { dayStartMs } from '@papa/core'
import { go } from '../nav.ts'
import { Shell, SectionHead, SettingsButton } from '../components/Shell.tsx'
import { BookingList } from './BookingRows.tsx'
import { NewBookingSheet } from './NewBookingSheet.tsx'
import {
  WEEKDAYS_MON_FIRST,
  dayLabel,
  monthGrid,
  monthLabel,
  monthStartOf,
  shiftMonth,
} from '../booking-view.ts'
import { monthCounts } from './bookings.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * The promise calendar — a month at a time.
 *
 * Each day is a cell with two marks: the confirmed count as a red stamp
 * square and the pencilled count as a dashed grey one, the same two
 * instruments the list stamps use. Wedding-season months (ASSUMPTION
 * #wedding-season) shade the whole page a step darker with a caption, so
 * December reads as the busy season before a single cell is read.
 *
 * Tapping a day lists that day's bookings underneath. The list is the
 * same rows as everywhere else; each opens the booking's page. The clock
 * ticks once a minute so a pencil's countdown on a row stays honest
 * without a reload — computed from the stored expiry, never counted down.
 */
export function CalendarScreen({ store, initialDayMs }: { store: DemoStore; initialDayMs?: number }) {
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [monthMs, setMonthMs] = useState(() => monthStartOf(initialDayMs ?? nowMs))
  const [dayMs, setDayMs] = useState<number | null>(() => (initialDayMs ? dayStartMs(initialDayMs) : null))
  const [creating, setCreating] = useState(false)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  // tick is read so a write re-reads the month; the store is a database.
  void tick
  const days = useMemo(() => store.calendar(monthMs, nowMs), [store, monthMs, nowMs, tick])
  const byDay = useMemo(() => new Map(days.map((d) => [d.dayMs, d])), [days])
  const rows = useMemo(() => monthGrid(monthMs), [monthMs])
  const wedding = days.length > 0 && days[0].season === 'wedding'
  const counts = monthCounts(days)
  const today = dayStartMs(nowMs)
  const selected = dayMs !== null ? byDay.get(dayMs) : undefined

  return (
    <Shell
      view={{ name: 'calendar' }}
      title={STR.bookingCalendarTitle}
      subtitle={STR.bookingCalendarSubtitle}
      action={
        <>
          <button className="icon-btn" onClick={() => setCreating(true)} aria-label={STR.bookingNew}>
            <Icon name="clapperboard" size={22} />
          </button>
          <SettingsButton />
        </>
      }
    >
      <div className={`cal-month${wedding ? ' is-wedding' : ''}`}>
        <div className="cal-strip">
          <button
            className="icon-btn cal-nav"
            onClick={() => { setMonthMs((m) => shiftMonth(m, -1)); setDayMs(null) }}
            aria-label={STR.bookingPrevMonthAria}
          >
            <Icon name="chevron-left" size={24} />
          </button>
          <div className="cal-title">
            <h2>{monthLabel(monthMs)}</h2>
            <p className="section-sub">
              {STR.bookingMonthCounts(counts.confirmed, counts.pencilled)}
              {wedding ? <span className="cal-season"> · {STR.bookingSeasonWedding}</span> : null}
            </p>
          </div>
          <button
            className="icon-btn cal-nav"
            onClick={() => { setMonthMs((m) => shiftMonth(m, 1)); setDayMs(null) }}
            aria-label={STR.bookingNextMonthAria}
          >
            <Icon name="chevron-right" size={24} />
          </button>
        </div>

        <div className="cal-grid" role="grid" aria-label={monthLabel(monthMs)}>
          {WEEKDAYS_MON_FIRST.map((w) => (
            <span key={w} className="cal-weekday" role="columnheader">{w}</span>
          ))}
          {rows.flat().map((cell, i) =>
            cell === null ? (
              <span key={`pad-${i}`} className="cal-pad" aria-hidden="true" />
            ) : (
              <DayCell
                key={cell}
                dayMs={cell}
                confirmed={byDay.get(cell)?.confirmed.length ?? 0}
                pencilled={byDay.get(cell)?.pencilled.length ?? 0}
                isToday={cell === today}
                isSelected={cell === dayMs}
                onPick={() => setDayMs((d) => (d === cell ? null : cell))}
              />
            ),
          )}
        </div>

        <p className="cal-legend">
          <span className="cal-mark cal-mark-confirmed" aria-hidden="true" /> {STR.bookingLegendConfirmed}
          <span className="cal-mark cal-mark-pencil" aria-hidden="true" /> {STR.bookingLegendPencilled}
        </p>
      </div>

      <section className="section">
        <SectionHead
          icon="calendar"
          title={dayMs !== null ? STR.bookingDayHeading(dayLabel(dayMs)) : STR.bookingListHeading}
          sub={dayMs === null ? STR.bookingTapADay : undefined}
          action={
            <button className="btn btn-sm btn-outline" onClick={() => setCreating(true)}>
              <Icon name="clapperboard" size={16} /> {STR.bookingNew}
            </button>
          }
        />
        {/* An empty day and an empty month both open the new-booking
            sheet, prefilled with the day when one is picked. */}
        {dayMs !== null ? (
          <BookingList
            rows={selected ? [...selected.confirmed, ...selected.pencilled] : []}
            emptyText={STR.bookingNothingThatDay}
            onNew={() => setCreating(true)}
          />
        ) : (
          <BookingList
            rows={store.bookings({ status: 'live', fromMs: monthMs, untilMs: shiftMonth(monthMs, 1) }, nowMs)}
            emptyText={STR.bookingNoneThisMonth}
            onNew={() => setCreating(true)}
          />
        )}
      </section>

      {creating ? (
        <NewBookingSheet
          store={store}
          initialStartMs={dayMs ?? undefined}
          onDone={(bookingId) => {
            setCreating(false)
            setTick((t) => t + 1)
            if (bookingId) go({ name: 'booking', bookingId })
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </Shell>
  )
}

function DayCell({
  dayMs,
  confirmed,
  pencilled,
  isToday,
  isSelected,
  onPick,
}: {
  dayMs: number
  confirmed: number
  pencilled: number
  isToday: boolean
  isSelected: boolean
  onPick: () => void
}) {
  const d = new Date(dayMs).getDate()
  return (
    <button
      className={`cal-day pressable${isToday ? ' is-today' : ''}${isSelected ? ' is-selected' : ''}`}
      role="gridcell"
      aria-pressed={isSelected}
      aria-label={dayLabel(dayMs)}
      onClick={onPick}
    >
      <span className="cal-daynum code">{d}</span>
      <span className="cal-marks">
        {confirmed > 0 ? <span className="cal-mark cal-mark-confirmed code">{confirmed}</span> : null}
        {pencilled > 0 ? <span className="cal-mark cal-mark-pencil code">{pencilled}</span> : null}
      </span>
    </button>
  )
}
