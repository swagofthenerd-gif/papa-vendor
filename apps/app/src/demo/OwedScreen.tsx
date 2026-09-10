import { Icon } from '@papa/icons'
import { formatRupees } from '@papa/core'
import { Shell, SectionHead } from '../components/Shell.tsx'
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
 * this screen adds nothing but rows.
 */
export function OwedScreen({ store }: { store: DemoStore }) {
  const view: View = { name: 'owed' }
  const customers = store.customers()
  const owing = customers.filter((c) => c.balanceMinor > 0)

  return (
    <Shell
      view={view}
      title={STR.customerOwedTitle}
      subtitle={STR.customerOwedSubtitle(owing.length)}
      action={
        <button
          className="icon-btn"
          onClick={() => go({ name: 'jobs' })}
          aria-label={STR.commonBackToToday}
        >
          <Icon name="chevron-left" size={22} />
        </button>
      }
    >
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
    </Shell>
  )
}
