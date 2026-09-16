import { useState } from 'react'
import { Icon } from '@papa/icons'
import { ledgerDate } from '@papa/core'
import { SectionHead } from '../components/Shell.tsx'
import { Sheet, SheetClose } from '../components/Sheet.tsx'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import { STR } from '../strings.ts'
import type { DemoStore } from './store.ts'

/**
 * "Do not rent to this client" — the switch the gate never had (W13,
 * year finding `no-blacklist`).
 *
 * `customers.blacklisted` has existed since 0017 and `confirm_booking`
 * has refused a blacklisted client BY NAME since W5; nothing could set
 * it, so FEB's Rs 2.6M loss and the day-14 rung's "consider a blacklist"
 * both ended in a shrug. 0029's `set_customer_blacklisted` is the door.
 *
 * PLACED AT THE BOTTOM ON PURPOSE. It is the rarest act on the page and
 * the most consequential, so it is nowhere near the thumb that records a
 * payment, and it sits behind a hold with a reason. Turning it ON needs
 * the sentence (override 18 — and the server refuses a reason-less one);
 * lifting it needs none, because letting a client back in refuses
 * nobody.
 */
export function BlacklistSection({
  store,
  customerId,
  blacklisted,
  reason,
  sinceMs,
  onWrite,
}: {
  store: DemoStore
  customerId: string
  blacklisted: boolean
  reason: string | null
  sinceMs: number | null
  onWrite: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <section className="section">
      <SectionHead
        icon="ban"
        title={STR.moneyBlacklistHeading}
        sub={
          blacklisted
            ? STR.moneyBlacklistLine(sinceMs === null ? '—' : ledgerDate(sinceMs), reason)
            : STR.moneyBlacklistOpen
        }
      />
      <button className="btn btn-ghost btn-block" onClick={() => setOpen(true)}>
        <Icon name={blacklisted ? 'check-circle' : 'ban'} size={18} />{' '}
        {blacklisted ? STR.moneyBlacklistOff : STR.moneyBlacklistOn}
      </button>

      {open ? (
        <BlacklistSheet
          blacklisted={blacklisted}
          onSave={(on, why) => {
            store.setBlacklisted(customerId, on, why)
            setOpen(false)
            onWrite()
          }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </section>
  )
}

function BlacklistSheet({
  blacklisted,
  onSave,
  onClose,
}: {
  blacklisted: boolean
  onSave: (on: boolean, reason: string | null) => void
  onClose: () => void
}) {
  const [why, setWhy] = useState('')
  const title = blacklisted ? STR.moneyBlacklistOff : STR.moneyBlacklistOn
  const ready = blacklisted || why.trim().length > 0

  return (
    <Sheet label={title} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{title}</span>
        <SheetClose />
      </header>

      {blacklisted ? null : <p className="sheet-hint">{STR.moneyBlacklistWhat}</p>}

      {blacklisted ? null : (
        <>
          <label className="field-label" htmlFor="blacklist-why">{STR.moneyReasonLabel}</label>
          <input
            id="blacklist-why"
            className="sheet-search"
            value={why}
            placeholder={STR.moneyBlacklistReasonPlaceholder}
            onChange={(e) => setWhy(e.target.value)}
            autoCorrect="off"
            spellCheck={false}
            autoFocus
          />
        </>
      )}

      <HoldToFinish
        label={blacklisted ? STR.moneyBlacklistLiftHold : STR.moneyBlacklistHold}
        disabled={!ready}
        onFinish={() => onSave(!blacklisted, blacklisted ? null : why.trim())}
      />
    </Sheet>
  )
}
