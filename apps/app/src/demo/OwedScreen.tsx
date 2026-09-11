import { useState } from 'react'
import { Icon } from '@papa/icons'
import { formatRupees } from '@papa/core'
import { Shell, SectionHead, SettingsButton } from '../components/Shell.tsx'
import { KharchaSheet } from './KharchaSheet.tsx'
import { go, type View } from '../nav.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * Mera udhaar — every customer, biggest debt first.
 *
 * The Today board's "owed to me" figure opens here, and every row opens the
 * khata it summarises: figure → list → page, each step answerable. Clean
 * customers stay on the list below the owing ones — the page is the index of
 * every khata, not only of the debts — but the order and the subtitle keep
 * the debts on top, because that is the question the owner arrived with.
 *
 * Balances here are the same projection the khata page shows (khata.ts);
 * this screen adds nothing but rows — plus ONE header door: "Add expense",
 * the general kharcha entry (0019). It lives here because this is the money
 * surface the owner already visits, and the smallest honest door beats a
 * new tab. A header icon-btn, far from every row tap, so a thumb reaching
 * for a khata cannot land on a write.
 */
export function OwedScreen({ store }: { store: DemoStore }) {
  const view: View = { name: 'owed' }
  const [, setTick] = useState(0)
  const [adding, setAdding] = useState(false)
  const customers = store.customers()
  const owing = customers.filter((c) => c.balanceMinor > 0)

  return (
    <Shell
      view={view}
      title={STR.customerOwedTitle}
      subtitle={STR.customerOwedSubtitle(owing.length)}
      action={
        <>
          <button
            className="icon-btn"
            onClick={() => setAdding(true)}
            aria-label={STR.kharchaAddExpense}
          >
            <Icon name="receipt" size={22} />
          </button>
          <SettingsButton />
        </>
      }
    >
      {/* The two money doors that used to sit on Today's quick grid: the
          day's account and the expense book. Khata is the money tab now,
          so its home carries them; Today keeps only the money strip, which
          deep-links in. */}
      <div className="quick-grid">
        <button className="quick pressable" onClick={() => go({ name: 'hisaab' })}>
          <Icon name="clipboard" size={20} />
          <span className="quick-t">{STR.todayDinKaHisaab}</span>
          <span className="quick-s">{STR.todayWhatMovedToday}</span>
        </button>
        <button className="quick pressable" onClick={() => setAdding(true)}>
          <Icon name="receipt" size={20} />
          <span className="quick-t">{STR.kharchaAddExpense}</span>
          <span className="quick-s">{STR.kharchaMonthHeading}</span>
        </button>
      </div>

      {owing.length === 0 ? (
        <div className="empty">
          <Icon name="clipboard-check" size={36} />
          <p>{STR.customerNobodyOwes}</p>
        </div>
      ) : null}

      <section className="section">
        <SectionHead icon="scroll" title={STR.customerKhata} sub={STR.customerOwedTapOne} />
        <ul className="line-list">
          {customers.map((c) => (
            <li key={c.id}>
              <button
                className="line line-tap pressable"
                onClick={() => go({ name: 'customer', customerId: c.id })}
              >
                <span className="line-name">{c.name}</span>
                <span className="line-note">
                  {[
                    c.phone,
                    c.depositHeldMinor > 0
                      ? STR.customerDepositHeldLine(formatRupees(c.depositHeldMinor))
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                <span className={`line-code code${c.balanceMinor > 0 ? ' is-owed' : ''}`}>
                  {formatRupees(c.balanceMinor)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      {adding ? (
        <KharchaSheet
          title={STR.kharchaAddExpense}
          hint={null}
          onSave={(input) => {
            store.recordExpense(input, input.whenMs)
            setAdding(false)
            setTick((t) => t + 1)
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </Shell>
  )
}
