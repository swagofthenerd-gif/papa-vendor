import { useState } from 'react'
import { Icon } from '@papa/icons'
import { formatRupees } from '@papa/core'
import type { ChargedButReturned } from '../demo/khata.ts'
import { STR } from '../strings.ts'

/**
 * The charged-then-returned notice — a NEEDS-A-DECISION card, shown on the
 * khata and the session summary wherever an uncorrected charge names an
 * item that has since been scanned home.
 *
 * POLICY (owner may overrule): the app never auto-reverses. The first tap
 * only ARMS a pre-filled correction draft; the second, explicit confirm —
 * naming the figure — is what writes the reversal. "We keep the money
 * anyway" is a real answer (a lost accessory inside the case, a settled
 * dispute), so dismissal is free: leave the notice alone and nothing
 * happens.
 */
export function ReversalNotice({
  item,
  onReverse,
}: {
  item: ChargedButReturned
  /** Writes the reversal — called only from the armed confirm tap. */
  onReverse: () => void
}) {
  const [armed, setArmed] = useState(false)
  const rupees = formatRupees(item.amountMinor)

  return (
    <div className="notice">
      <Icon name="question" size={18} />
      <div>
        <strong>
          {STR.customerChargedButReturned(rupees, item.assetCode, item.jobLabel)}
        </strong>
      </div>
      {armed ? (
        <button className="btn btn-sm btn-primary" onClick={onReverse}>
          {STR.customerReverseConfirm(rupees)}
        </button>
      ) : (
        <button className="btn btn-sm btn-ghost" onClick={() => setArmed(true)}>
          {STR.customerReverseDraft}
        </button>
      )}
    </div>
  )
}

/**
 * The charged-then-returned notices for one screen, as a list. The khata and
 * the session summary both surface the same NEEDS-A-DECISION cards over the
 * same store call; rendering them here keeps the confirm-arms-then-writes
 * policy — and the remount-on-write key — in exactly one place, so the two
 * screens cannot drift into two different reversal flows.
 *
 * `refreshKey` (each screen's re-read tick) rides in the key so a written
 * reversal remounts the card and clears its armed state, matching what each
 * screen did inline before this was lifted out.
 */
export function ReversalNotices({
  notices,
  refreshKey,
  onReverse,
}: {
  notices: ChargedButReturned[]
  refreshKey: number
  /** Writes the reversal for one entry — the owner's confirm tap. */
  onReverse: (entryId: string) => void
}) {
  return (
    <>
      {notices.map((n) => (
        <ReversalNotice
          key={`${n.entryId}-${refreshKey}`}
          item={n}
          onReverse={() => onReverse(n.entryId)}
        />
      ))}
    </>
  )
}
