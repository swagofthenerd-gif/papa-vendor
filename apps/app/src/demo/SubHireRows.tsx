import { useState } from 'react'
import { Icon } from '@papa/icons'
import { bookingDateLabel, formatRupees } from '@papa/core'
import { go } from '../nav.ts'
import type { SubHireRow } from './network.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * One sub-hire as a ledger line: the stamp (BORROWED in, LENT out), what
 * and with whom, the unit when one is named (a door to its page), the
 * window, the money — or the honest 'unpriced' — and, while open, the
 * one door that closes it: 'Came back' for gear we lent, 'Returned to
 * them' for gear we borrowed. The store's refusals render inline under
 * the row, never as a crash: 'still out on a job — scan it in first'.
 */
export function SubHireLine({
  row,
  store,
  onChanged,
  showPartner = true,
}: {
  row: SubHireRow
  store: DemoStore
  onChanged: () => void
  /** Off on the partner's own page, where the name is the title. */
  showPartner?: boolean
}) {
  const [problem, setProblem] = useState<string | null>(null)
  const open = row.returnedAtMs === null

  const close = () => {
    const r = store.closeSubHire(row.id)
    if (!r.ok) {
      setProblem(
        r.reason === 'unit_out' ? STR.networkCloseRefusedUnitOut
          : r.reason === 'job_still_out' ? STR.networkCloseRefusedJobOut(r.stillOut)
            : r.reason === 'future' ? STR.networkCloseRefusedFuture
              : r.reason === 'before_start' ? STR.networkCloseRefusedBeforeStart
                : r.reason === 'already_closed' ? STR.networkCloseRefusedClosed
                  : STR.networkCloseRefusedNotFound,
      )
      return
    }
    onChanged()
  }

  const what = row.direction === 'in'
    ? STR.networkRowIn(row.qty, row.productName, row.partnerName)
    : STR.networkRowOut(row.qty, row.productName, row.partnerName)

  return (
    <li className={`line line-stack sub-hire-line${open ? '' : ' is-closed'}`}>
      <span className="line-name">
        <span key={open ? 'open' : 'closed'} className={`stamp stamp-small${open ? '' : ' stamp-struck'}`}>
          {row.direction === 'in' ? STR.networkBorrowedStamp : STR.networkLentStamp}
        </span>{' '}
        {showPartner ? what : `${row.qty} × ${row.productName}`}
      </span>
      <span className="line-note code">
        {STR.networkRowWindow(bookingDateLabel(row.fromMs), bookingDateLabel(row.untilMs))}
        {' · '}
        {row.agreedMinor === null ? STR.networkRowUnpriced : formatRupees(row.agreedMinor)}
        {row.returnedAtMs !== null ? ` · ${STR.networkRowReturned(bookingDateLabel(row.returnedAtMs))}` : ''}
      </span>
      <span className="job-actions sub-hire-doors">
        {row.assetId && row.assetCode ? (
          <button className="btn btn-sm btn-ghost" onClick={() => go({ name: 'asset', assetId: row.assetId! })}>
            <Icon name="box" size={16} /> {STR.networkRowUnit(row.assetCode)}
          </button>
        ) : null}
        {row.jobId && row.jobLabel ? (
          <button className="btn btn-sm btn-ghost" onClick={() => go({ name: 'scan', jobId: row.jobId!, mode: 'out' })}>
            <Icon name="truck" size={16} /> {row.jobLabel}
          </button>
        ) : null}
        {open ? (
          <button className="btn btn-sm btn-outline" onClick={close}>
            <Icon name="undo" size={16} /> {row.direction === 'in' ? STR.networkReturned : STR.networkCameBack}
          </button>
        ) : null}
      </span>
      {problem ? (
        <span className="line-note notice-inline" role="alert">
          <Icon name="warning" size={14} /> {problem}
        </span>
      ) : null}
    </li>
  )
}
