import { useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import { addDays, formatRupees, trimNumber, type CalendarKind } from '@papa/core'
import { Shell, SectionHead } from '../components/Shell.tsx'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import { WEEKDAYS_MON_FIRST } from '../booking-view.ts'
import { go } from '../nav.ts'
import type { DemoStore } from './store.ts'
import type { CalendarDayRow } from './quotes.ts'
import { STR } from '../strings.ts'

/**
 * Settings → Rates: the rate card, the per-product day rates, the
 * calendar (0024 on the phone). Plain and fast: three sections, every
 * write optimistic and queued as the server's op, nothing modal.
 *
 * The card's three knobs (ASSUMPTIONS #week-rate, #weekend-free): a
 * number for the week, a number for the minimum, and the seven weekdays
 * as toggles — ticked means "does not bill". The rate list is every
 * product, unpriced ones included, each with its rate typed inline in
 * the code voice; an emptied field removes the entry, which is the
 * honest "no rate" and never Rs 0 (0024 D5). The calendar lists the
 * season as one range row and every holiday as its own; tapping a row
 * loads it into the form, and removal sits behind a hold.
 */
export function RatesScreen({ store }: { store: DemoStore }) {
  const [tick, setTick] = useState(0)
  const [query, setQuery] = useState('')
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [said, setSaid] = useState<string | null>(null)
  const [calDay, setCalDay] = useState('')
  const [calKind, setCalKind] = useState<CalendarKind>('holiday')
  const [calName, setCalName] = useState('')
  const [calMult, setCalMult] = useState('1.25')
  void tick
  const refresh = () => setTick((t) => t + 1)

  const card = store.rateCard()
  const [week, setWeek] = useState(String(card?.weekEqualsDays ?? 3))
  const [minDays, setMinDays] = useState(String(card?.minBillableDays ?? 1))
  const [mask, setMask] = useState<number[]>(card?.weekendMask ?? [])

  const saveCard = () => {
    const r = store.setRateCard({
      weekEqualsDays: Number(week),
      minBillableDays: Number(minDays),
      weekendMask: mask,
    })
    setSaid(r.ok ? STR.quoteCardSaved : null)
    refresh()
  }

  const rates = useMemo(() => {
    const q = query.trim().toLowerCase()
    const all = card?.rates ?? []
    return q.length === 0 ? all : all.filter((r) => r.productName.toLowerCase().includes(q))
  }, [card, query])
  const pricedCount = (card?.rates ?? []).filter((r) => r.dayRateMinor !== null).length

  const commitRate = (productId: string, current: number | null) => {
    const raw = drafts[productId]
    if (raw === undefined) return
    const trimmed = raw.trim()
    const next = trimmed.length === 0 ? null : Number(trimmed)
    if (next !== null && !(Number.isFinite(next) && next >= 0)) return
    const nextMinor = next === null ? null : Math.round(next * 100)
    if (nextMinor !== current) store.setRate(productId, nextMinor)
    setDrafts((d) => { const { [productId]: _gone, ...rest } = d; void _gone; return rest })
    refresh()
  }

  const days = store.calendarDays()
  const holidays = days.filter((d) => d.kind === 'holiday')
  const seasons = groupSeasons(days.filter((d) => d.kind === 'season'))

  const saveDay = () => {
    const r = store.setCalendarDay(calDay, calKind, calName, Number(calMult))
    if (r.ok) { setCalName(''); setCalDay(''); refresh() }
  }
  const loadDay = (d: CalendarDayRow) => {
    setCalDay(d.day); setCalKind(d.kind); setCalName(d.name); setCalMult(String(d.rateMultiplier))
  }
  const removeDay = () => {
    if (!calDay) return
    store.clearCalendarDay(calDay, calKind)
    setCalDay(''); setCalName('')
    refresh()
  }
  const removeSeason = (g: SeasonGroup) => {
    for (const d of g.days) store.clearCalendarDay(d.day, 'season')
    refresh()
  }

  return (
    <Shell
      view={{ name: 'rates' }}
      title={STR.quoteRatesTitle}
      subtitle={STR.quoteRatesSubtitle}
      action={
        <button className="icon-btn" onClick={() => go({ name: 'settings' })} aria-label={STR.commonClose}>
          <Icon name="x" size={22} />
        </button>
      }
    >
      <section className="section">
        <SectionHead
          icon="receipt"
          title={STR.quoteCardHeading}
          sub={card ? STR.quoteCardSub(card.name) : STR.quoteCardNone}
        />
        <div className="field-pair">
          <div>
            <label className="field-label" htmlFor="card-week">{STR.quoteCardWeekLabel}</label>
            <input
              id="card-week"
              className="sheet-search code"
              inputMode="decimal"
              value={week}
              onChange={(e) => setWeek(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="card-min">{STR.quoteCardMinDaysLabel}</label>
            <input
              id="card-min"
              className="sheet-search code"
              inputMode="numeric"
              value={minDays}
              onChange={(e) => setMinDays(e.target.value)}
            />
          </div>
        </div>
        <span className="field-label" id="card-weekend">{STR.quoteCardWeekendLabel}</span>
        <div className="chip-row weekday-row" role="group" aria-labelledby="card-weekend">
          {WEEKDAYS_MON_FIRST.map((label, i) => {
            const iso = i + 1
            const on = mask.includes(iso)
            return (
              <button
                key={label}
                className={`filter-chip${on ? ' active' : ''}`}
                aria-pressed={on}
                onClick={() => setMask((m) => (on ? m.filter((d) => d !== iso) : [...m, iso].sort((a, b) => a - b)))}
              >
                {label}
              </button>
            )
          })}
        </div>
        <p className="sheet-hint">{STR.quoteCardWeekendHint}</p>
        <button className="btn btn-primary btn-block" onClick={saveCard}>
          <Icon name="check" size={18} /> {STR.quoteCardSave}
        </button>
        {said ? (
          <div className="notice notice-ok" role="status">
            <Icon name="check" size={18} />
            <div><strong>{said}</strong></div>
          </div>
        ) : null}
      </section>

      {!card ? (
        <section className="section">
          <SectionHead icon="coins" title={STR.quoteRatesListHeading} />
          <div className="empty">
            <Icon name="coins" size={32} />
            <p>{STR.quoteRatesNoCard}</p>
            <button className="btn btn-outline" onClick={saveCard}>
              <Icon name="check" size={18} /> {STR.quoteCardSave}
            </button>
          </div>
        </section>
      ) : null}
      {card ? (
        <section className="section">
          <SectionHead
            icon="coins"
            title={STR.quoteRatesListHeading}
            sub={STR.quoteRatesListSub(pricedCount, card.rates.length)}
          />
          <input
            className="sheet-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={STR.quoteRatesSearch}
            aria-label={STR.quoteRatesSearch}
            autoCorrect="off"
            spellCheck={false}
          />
          <ul className="line-list">
            {rates.map((r) => {
              const draft = drafts[r.productId]
              const shown = draft ?? (r.dayRateMinor === null ? '' : String(Math.round(r.dayRateMinor / 100)))
              return (
                <li key={r.productId} className={`line rate-row${r.dayRateMinor === null ? ' is-unpriced' : ''}`}>
                  <span className="line-name">{r.productName}</span>
                  <span className="line-note">
                    {r.dayRateMinor === null ? STR.quoteRateUnpriced : STR.quoteRatePerDay(formatRupees(r.dayRateMinor))}
                  </span>
                  <input
                    className="sheet-search code rate-input"
                    inputMode="numeric"
                    aria-label={STR.quoteRateSetAria(r.productName)}
                    placeholder={STR.quoteRateFieldPlaceholder}
                    value={shown}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.productId]: e.target.value }))}
                    onBlur={() => commitRate(r.productId, r.dayRateMinor)}
                    onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
                  />
                </li>
              )
            })}
          </ul>
        </section>
      ) : null}

      <section className="section">
        <SectionHead
          icon="calendar"
          title={STR.quoteCalendarHeading}
          sub={STR.quoteCalendarSub(holidays.length, days.length - holidays.length)}
        />
        <ul className="line-list">
          {seasons.map((g) => (
            <li key={`${g.name}-${g.from}`} className="line line-stack calendar-row">
              <span className="line-name">
                {STR.quoteCalendarSeasonRange(g.name, g.from, g.until, g.days.length, `×${trimNumber(g.multiplier)}`)}
              </span>
              <span className="calendar-row-doors">
                <button className="btn btn-sm btn-ghost" onClick={() => loadDay(g.days[0])}>
                  <Icon name="chevron-right" size={16} /> {STR.quoteCalendarKindSeason}
                </button>
                <HoldToFinish label={STR.quoteCalendarRemoveAria(g.name, g.from)} onFinish={() => removeSeason(g)} />
              </span>
            </li>
          ))}
          {holidays.map((d) => (
            <li key={d.id} className="line calendar-row">
              <button className="line-tap calendar-row-tap" onClick={() => loadDay(d)}>
                <span className="line-name">{STR.quoteCalendarRow(d.name, d.day, `×${trimNumber(d.rateMultiplier)}`)}</span>
              </button>
            </li>
          ))}
        </ul>

        <span className="field-label">{STR.quoteCalendarAdd}</span>
        <div className="field-pair">
          <div>
            <label className="field-label" htmlFor="cal-day">{STR.quoteCalendarDayLabel}</label>
            <input
              id="cal-day"
              className="sheet-search"
              type="date"
              value={calDay}
              onChange={(e) => setCalDay(e.target.value)}
            />
          </div>
          <div>
            <label className="field-label" htmlFor="cal-mult">{STR.quoteCalendarMultiplierLabel}</label>
            <input
              id="cal-mult"
              className="sheet-search code"
              inputMode="decimal"
              value={calMult}
              onChange={(e) => setCalMult(e.target.value)}
            />
          </div>
        </div>
        <span className="field-label" id="cal-kind">{STR.quoteCalendarKindLabel}</span>
        <div className="chip-row" role="group" aria-labelledby="cal-kind">
          {(['holiday', 'season'] as const).map((k) => (
            <button
              key={k}
              className={`filter-chip${calKind === k ? ' active' : ''}`}
              aria-pressed={calKind === k}
              onClick={() => setCalKind(k)}
            >
              {k === 'holiday' ? STR.quoteCalendarKindHoliday : STR.quoteCalendarKindSeason}
            </button>
          ))}
        </div>
        <label className="field-label" htmlFor="cal-name">{STR.quoteCalendarNameLabel}</label>
        <input
          id="cal-name"
          className="sheet-search"
          value={calName}
          onChange={(e) => setCalName(e.target.value)}
          placeholder={STR.quoteCalendarNamePlaceholder}
          autoCorrect="off"
          spellCheck={false}
        />
        <p className="sheet-hint">{STR.quoteCalendarMultiplierHint}</p>
        <div className="session-actions">
          <button
            className="btn btn-primary btn-block"
            disabled={!calDay || calName.trim().length === 0 || !(Number(calMult) > 0)}
            onClick={saveDay}
          >
            <Icon name="check" size={18} /> {STR.quoteCalendarSave}
          </button>
          {calDay && days.some((d) => d.day === calDay && d.kind === calKind) ? (
            <HoldToFinish label={STR.quoteCalendarRemoveAria(calName || calKind, calDay)} onFinish={removeDay} />
          ) : null}
        </div>
      </section>
    </Shell>
  )
}

interface SeasonGroup {
  name: string
  multiplier: number
  from: string
  until: string
  days: CalendarDayRow[]
}

/** Consecutive season days with one name and multiplier fold into one
 *  range row — ninety rows of "Wedding season" is a list nobody reads. */
function groupSeasons(rows: CalendarDayRow[]): SeasonGroup[] {
  const out: SeasonGroup[] = []
  for (const d of rows) {
    const last = out[out.length - 1]
    if (last && last.name === d.name && last.multiplier === d.rateMultiplier && addDays(last.until, 1) === d.day) {
      last.until = d.day
      last.days.push(d)
    } else {
      out.push({ name: d.name, multiplier: d.rateMultiplier, from: d.day, until: d.day, days: [d] })
    }
  }
  return out
}

