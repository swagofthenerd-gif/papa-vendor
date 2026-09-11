import { useState } from 'react'
import { Icon } from '@papa/icons'
import { windowLabel, type ShortageLine } from '@papa/core'
import { PartnerSendSheet } from './PartnerSendSheet.tsx'
import { SubHireInSheet } from './SubHireInSheet.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/** A shortage as a screen names it: the product by id for the sub-hire
 *  door, by name for the message, and the dates it is short for. */
export interface Shortage extends ShortageLine {
  productId: string | null
  /** The booking the shortage would rescue, when there is one — rides the
   *  sub-hire so its op chains behind the booking's. */
  bookingId?: string | null
  jobId?: string | null
}

/**
 * "Ask the market" — the door on every shortage surface (the enquiry
 * answer, the confirm sheet's refusal, the extension collision's Sub-rent).
 * The shortage lines arrive pre-filled; the sheet is the partner send
 * sheet with them on top and the "They said yes" door at the foot, which
 * opens the sub-hire-in sheet with the first line pre-filled.
 */
export function AskTheMarketSheet({
  store,
  shortage,
  onRecorded,
  onClose,
}: {
  store: DemoStore
  shortage: Shortage[]
  /** A sub-hire was recorded from this ask. */
  onRecorded?: (subHireId: string) => void
  onClose: () => void
}) {
  const [recording, setRecording] = useState(false)
  const partners = store.partners()
  const text = store.askTheMarket(shortage)

  if (recording) {
    const first = shortage[0]
    return (
      <SubHireInSheet
        store={store}
        prefill={
          first
            ? {
                productId: first.productId,
                qty: first.qty,
                startMs: first.fromMs,
                endMs: first.untilMs,
                bookingId: first.bookingId ?? null,
                jobId: first.jobId ?? null,
              }
            : null
        }
        onDone={(id) => { onRecorded?.(id); onClose() }}
        onClose={() => setRecording(false)}
      />
    )
  }

  return (
    <PartnerSendSheet
      title={STR.networkAskMarket}
      hint={STR.networkAskMarketHint}
      partners={partners}
      text={text}
      above={
        <ul className="line-list shortage-list">
          {shortage.map((s, i) => (
            <li key={i} className="line line-stack">
              <span className="line-name">
                <span className="stamp stamp-small">{STR.networkAskMarketShortage}</span>{' '}
                {s.qty} × {s.productName}
              </span>
              <span className="line-note code">
                {STR.networkAskMarketWindowLabel}: {windowLabel(s.fromMs, s.untilMs)}
              </span>
            </li>
          ))}
        </ul>
      }
      foot={
        <button className="btn btn-primary btn-block" onClick={() => setRecording(true)}>
          <Icon name="handshake" size={18} /> {STR.networkAskMarketTheySaidYes}
        </button>
      }
      onClose={onClose}
    />
  )
}
