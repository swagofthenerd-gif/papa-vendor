import { useMemo, useRef, useState } from 'react'
import { formatRupees, moneyLabel } from '@papa/core'
import { Icon } from '@papa/icons'
import { Shell, SectionHead } from '../components/Shell.tsx'
import { go, parseHash, type View } from '../nav.ts'
import { DueBadge } from '../routes/Today.tsx'
import { dayAccountText, monthKey, monthStep, msOfMonth, type DayItem } from './hisaab.ts'
import type { KharchaSlice } from './kharcha.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * Din ka hisaab — the day's account, on screen.
 *
 * Everything rendered here is derived in hisaab.ts from local tables; this
 * component adds nothing but layout. Dense but calm: counts up top, then the
 * day per job in the order it happened, then what is still out and to whom.
 *
 * TRUST IS VISIBLY DISTINCT. Items taken on trust carry their own mark and
 * their own colour — countable in the totals, but never dressed as an
 * observation. The evening reader must be able to see at a glance how much of
 * today's account is belief.
 *
 * The copy button produces the compact WhatsApp version and stops there: the
 * owner forwards it to his staff group himself, because the authority of the
 * message lives in WHO sent it, not in the app that drafted it.
 *
 * AND SINCE W13, THE MONTH BEHIND THE DAY (`no-month-history-screen`).
 * `moneyStrip(nowMs)` and `monthProfit(nowMs)` could always answer any
 * month; every caller hardcoded `Date.now()`, so the owner could not see
 * last month from this one. The picker is two taps and a title — the
 * maths was already honest — and it is deep-linkable as
 * `#/hisaab?m=YYYY-MM`, so a WhatsApp'd link opens on the right month.
 * Picking a past month replaces the day's sections with that month's
 * account: what went out and came back, the kharcha, the profit, and the
 * statement links collections week actually needs. A past month has no
 * 'today' under it, and the screen does not pretend otherwise.
 */
export function HisaabScreen({ store }: { store: DemoStore }) {
  // The real clock, read once: everything time-derived below is computed
  // from it at render, never welded (CONTRIBUTING's injectable-clock rule).
  const todayMs = useMemo(() => Date.now(), [])
  // The chosen month, initialised from the hash so a deep link lands on
  // it, and written back to the hash on every step so the address bar
  // stays shareable. State rather than a prop because the route's own
  // component is not this screen's to change.
  const [monthMs, setMonthMs] = useState(() => {
    const m = parseHash(window.location.hash)
    const from = m.name === 'hisaab' && m.month ? msOfMonth(m.month) : null
    return from ?? todayMs
  })
  // Which route names a given month — ONE place, because it is asked for
  // the address bar on this render and again for every step of the picker.
  // This month carries no query, exactly as gear's `q` is omitted rather
  // than set to undefined, so a parsed view compares equal to the literal
  // that produced it (nav.ts).
  const viewFor = (ms: number): View =>
    monthKey(ms) === monthKey(todayMs)
      ? { name: 'hisaab' }
      : { name: 'hisaab', month: monthKey(ms) }
  const view = viewFor(monthMs)

  const step = (by: number) => {
    const next = monthStep(monthMs, by)
    setMonthMs(next)
    go(viewFor(next))
  }

  // Computed once per mount; the screen is a report, not a live feed.
  const account = useMemo(() => store.dayAccount(todayMs), [store, todayMs])
  // The chosen month's whole account (W13) — its own snapshot, re-read
  // when the picker moves.
  const monthly = useMemo(
    () => store.monthAccount(monthMs, todayMs),
    [store, monthMs, todayMs],
  )
  // The account already answered "is this the month with a today in it"
  // (hisaab.ts); the screen reads its answer rather than re-deriving one.
  const isThisMonth = monthly.isThisMonth
  const month = monthly.profit
  const [copiedName, setCopiedName] = useState<string | null>(null)
  const nameTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyStatement = (customerId: string) => {
    const text = store.statementText(customerId, monthMs)
    if (!text) return
    void navigator.clipboard?.writeText(text).catch(() => {})
    setCopiedName(customerId)
    if (nameTimer.current) clearTimeout(nameTimer.current)
    nameTimer.current = setTimeout(() => setCopiedName(null), 1500)
  }

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCopy = () => {
    void navigator.clipboard?.writeText(dayAccountText(account)).catch(() => {})
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  const quiet =
    account.wentOut === 0 &&
    account.cameBack === 0 &&
    account.photos === 0 &&
    account.unknownTags === 0

  return (
    <Shell
      view={view}
      title={STR.hisaabTitle}
      subtitle={account.dayLabel}
      action={
        <button className="icon-btn" onClick={() => go({ name: 'jobs' })} aria-label={STR.commonBackToToday}>
          <Icon name="chevron-left" size={22} />
        </button>
      }
    >
      {/* The picker (W13): back, the month's own name, forward — and
          forward is dead on the current month, because there is no
          account of a month that has not happened. */}
      <div className="month-picker">
        <button
          className="icon-btn"
          onClick={() => step(-1)}
          aria-label={STR.moneyMonthPrev}
        >
          <Icon name="chevron-left" size={22} />
        </button>
        <span className="month-picker-label code">
          {monthly.monthLabel}
          {isThisMonth ? <span className="line-note"> {STR.moneyMonthThis}</span> : null}
        </span>
        <button
          className="icon-btn"
          onClick={() => step(1)}
          disabled={isThisMonth}
          aria-label={STR.moneyMonthNext}
        >
          <Icon name="chevron-right" size={22} />
        </button>
      </div>

      {isThisMonth ? (
      <>
      <div className="stat-strip">
        <div className="stat">
          <span className="stat-n code">{account.wentOut}</span>
          <span className="stat-label">{STR.hisaabStatWentOut}</span>
        </div>
        <div className="stat">
          <span className="stat-n code">{account.cameBack}</span>
          <span className="stat-label">{STR.hisaabStatCameBack}</span>
        </div>
        <div className={`stat${account.onTrust > 0 ? ' is-warn' : ''}`}>
          <span className="stat-n code">{account.onTrust}</span>
          <span className="stat-label">{STR.hisaabStatOnTrust}</span>
        </div>
        <div className="stat">
          <span className="stat-n code">{account.photos}</span>
          <span className="stat-label">{STR.hisaabStatPhotos}</span>
        </div>
      </div>

      <div className="hisaab-bar">
        <button className="btn btn-primary btn-block" onClick={onCopy}>
          <Icon name="clipboard" size={18} />{' '}
          {copied ? STR.hisaabCopied : STR.hisaabCopyTheDaysAccount}
        </button>
      </div>

      {account.unknownTags > 0 ? (
        <div className="notice notice-warn">
          <Icon name="tag-off" size={18} />
          <div>
            <strong>
              {STR.hisaabUnknownLabelsScanned(account.unknownTags)}
            </strong>
            <p>{STR.hisaabLabelsNeverSeen}</p>
          </div>
        </div>
      ) : null}

      {quiet ? (
        <div className="empty">
          <Icon name="clipboard" size={36} />
          <p>{STR.hisaabNothingToday}</p>
          <p className="muted">{STR.hisaabTheAccountFillsItself}</p>
        </div>
      ) : (
        account.jobs.map((g) => (
          <section className="section" key={g.jobId || 'no-job'}>
            <SectionHead
              icon="clipboard-check"
              title={g.jobLabel}
              sub={jobLine(g.out.length, g.back.length, g.photos)}
            />
            {g.out.length > 0 ? <DayList heading={STR.hisaabWentOutHeading} items={g.out} /> : null}
            {g.back.length > 0 ? <DayList heading={STR.hisaabCameBackHeading} items={g.back} /> : null}
          </section>
        ))
      )}

      {/* The day's expense side (0019): what the house PAID today, its own
          section with the day's total — an honest empty line on a day
          nothing was spent, because "no kharcha" is a fact, not a blank. */}
      <KharchaSection
        slice={account.kharcha}
        sub={
          account.kharcha.rows.length === 0
            ? STR.kharchaDayNone
            : STR.kharchaDaySpent(formatRupees(account.kharcha.totalMinor))
        }
      />

      <section className="section">
        <SectionHead
          icon="undo"
          title={STR.hisaabStillOut}
          sub={
            account.stillOut.length === 0
              ? STR.hisaabEverythingIsHome
              : STR.hisaabWithTheClient
          }
        />
        {account.stillOut.length === 0 ? null : (
          <ul className="line-list">
            {account.stillOut.map((j) => {
              // Replacement value of what the job is holding. The label says
              // '+N unpriced' itself; a fully unpriced job shows no figure —
              // the count is still the fact, money is only added when known.
              const value = moneyLabel(j.value)
              return (
                <li key={j.id} className="line">
                  <span className="line-name">{j.label}</span>
                  <span className="line-note">
                    {STR.commonItemsStillOut(j.out)}
                    {value !== null ? ` · ${value}` : ''}
                  </span>
                  <span className="line-code">
                    <DueBadge due={j.due} />
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {/* The dead-stock line (0021 D4): idle capital said in money, only
          when it exists — 'Idle 90+ days: 2 items · Rs 45,00,000'. Rows
          live on the Sehat surface (the Gear screen); the day's account
          carries the one line the owner forwards. */}
      {account.deadStock.items > 0 ? (
        <section className="section">
          <SectionHead
            icon="hourglass"
            title={STR.sehatDeadStock(account.deadStock.days)}
            sub={
              STR.gearItemCount(account.deadStock.items) +
              (moneyLabel(account.deadStock.value) !== null
                ? ` · ${moneyLabel(account.deadStock.value)}`
                : '')
            }
          />
        </section>
      ) : null}

      </>
      ) : (
        /* A past month: its own account, in the same grammar. What moved,
           what was spent, then the statements. The day's sections are
           gone rather than empty — a month is not a day with no scans. */
        <>
          <div className="stat-strip">
            <div className="stat">
              <span className="stat-n code">{monthly.wentOut}</span>
              <span className="stat-label">{STR.hisaabStatWentOut}</span>
            </div>
            <div className="stat">
              <span className="stat-n code">{monthly.cameBack}</span>
              <span className="stat-label">{STR.hisaabStatCameBack}</span>
            </div>
          </div>

          {monthly.wentOut === 0 && monthly.cameBack === 0 ? (
            <div className="empty">
              <Icon name="calendar" size={36} />
              <p>{STR.moneyMonthNothingMoved}</p>
            </div>
          ) : null}

          <KharchaSection
            slice={monthly.kharcha}
            sub={
              monthly.kharcha.rows.length === 0
                ? STR.moneyMonthKharchaNone
                : STR.moneyMonthKharchaSpent(formatRupees(monthly.kharcha.totalMinor))
            }
          />

          <section className="section">
            <SectionHead
              icon="scroll"
              title={STR.moneyMonthStatements}
              sub={
                monthly.customers.length === 0
                  ? STR.moneyMonthNobody
                  : STR.moneyMonthStatementsSub
              }
            />
            {monthly.customers.length === 0 ? null : (
              <ul className="line-list khata-book">
                {monthly.customers.map((c) => (
                  <li key={c.id}>
                    <button
                      className="line line-stack line-tap pressable"
                      onClick={() => copyStatement(c.id)}
                    >
                      <span className="line-name">{c.name}</span>
                      <span className="line-note">
                        {copiedName === c.id
                          ? STR.moneyMonthCopied
                          : STR.moneyMonthBilled(
                              formatRupees(c.billedMinor),
                              formatRupees(c.paidMinor),
                            )}
                      </span>
                      <span className={`line-code code${c.balanceMinor > 0 ? ' is-owed' : ''}`}>
                        {formatRupees(c.balanceMinor)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      {/* The month's statement (0019): earned and spent as plain rows,
          then the profit line under the accountant's double rule — the
          same tally voice as the khata balance. When the month recorded
          no expenses the head SAYS so, and the profit line then honestly
          equals the billing. */}
      <section className="section">
        <SectionHead
          icon="scroll"
          title={STR.kharchaMonthHeading}
          sub={
            month.expenseCount === 0
              ? STR.kharchaNoExpensesThisMonth
              : month.monthLabel
          }
        />
        <ul className="line-list">
          <li className="line">
            <span className="line-name">{STR.kharchaMonthEarned}</span>
            <span className="line-code code">{formatRupees(month.earnedMinor)}</span>
          </li>
          <li className="line">
            <span className="line-name">{STR.kharchaMonthSpent}</span>
            <span className="line-code code">{formatRupees(month.spentMinor)}</span>
          </li>
        </ul>
        <div className="tally">
          <p className="tally-line code">{formatRupees(month.profitMinor)}</p>
          <p className="tally-sub">{STR.kharchaMonthProfitLabel}</p>
        </div>
      </section>
    </Shell>
  )
}

/**
 * What the house paid out inside a window — ONE section, read twice: the
 * day's kharcha and, since W13, the chosen month's. The rows are the same
 * expense book in the same grammar, so the only thing that differs is the
 * sentence under the heading (today's total, or the month's), which the
 * caller supplies. Two copies of this list would be two places to keep a
 * kharcha row's shape in step (docs/principles.md #4).
 *
 * The empty case is a HEAD WITH NO LIST, both times: "no kharcha" is a
 * fact worth stating, and an empty ul is not a way of saying it.
 */
function KharchaSection({ slice, sub }: { slice: KharchaSlice; sub: string }) {
  return (
    <section className="section">
      <SectionHead icon="receipt" title={STR.kharchaHeading} sub={sub} />
      {slice.rows.length === 0 ? null : (
        <ul className="line-list">
          {slice.rows.map((e) => (
            <li key={e.id} className="line">
              <span className="line-name">{STR.kharchaKindLabel(e.kind)}</span>
              <span className="line-note">
                {[e.counterparty, e.assetCode, e.jobLabel, e.note]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
              <span className="line-code code">{formatRupees(e.amountMinor)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** '8 out · 2 back · 3 photos' — only the parts that happened. */
function jobLine(out: number, back: number, photos: number): string {
  const parts: string[] = []
  if (out > 0) parts.push(STR.hisaabNOut(out))
  if (back > 0) parts.push(STR.hisaabNBack(back))
  if (photos > 0) parts.push(STR.hisaabNPhotos(photos))
  return parts.length > 0 ? parts.join(' · ') : STR.hisaabPhotographedOnly
}

function DayList({ heading, items }: { heading: string; items: DayItem[] }) {
  const trust = items.filter((i) => i.assumed).length
  return (
    <div className="hisaab-list">
      <h3 className="hisaab-sub">
        {heading}
        {trust > 0 ? <span className="hisaab-trust-count">{STR.hisaabOnTrustCount(trust)}</span> : null}
      </h3>
      <ul className="line-list">
        {items.map((i) => (
          <li key={i.assetId} className={`line${i.assumed ? ' line-assumed' : ''}`}>
            <span className="line-name">{i.name ?? STR.commonUnknownItem}</span>
            {i.assumed ? (
              // A belief, not an observation — same vocabulary as the
              // handover screen, so the two never disagree about what
              // 'assumed' means.
              <span className="line-note">{STR.hisaabTakenOnTrust}</span>
            ) : null}
            <span className="line-code code">{i.code ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
