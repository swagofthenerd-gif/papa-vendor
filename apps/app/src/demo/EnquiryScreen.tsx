import { useCallback, useMemo, useState } from 'react'
import type { AvailabilitySummary, AvailabilityWindow, CatalogueItem } from '@papa/core'
import { Enquiry } from '../routes/Enquiry.tsx'
import { NewJobSheet } from './NewJobSheet.tsx'
import { QuoteSheet } from './QuoteSheet.tsx'
import { defaultPickupMs, defaultReturnMs, fromLocalInput, toLocalInput } from '../booking-view.ts'
// --- network --- (0025): the reply card's Ask-the-market door.
import { AskTheMarketSheet, type Shortage } from './AskTheMarketSheet.tsx'
import { DAY_MS } from '@papa/core'
import { go } from '../nav.ts'
import { enquiryLines, type DemoStore } from './store.ts'
import type { EnquiryLine } from './quotes.ts'
import { STR } from '../strings.ts'

/**
 * The WhatsApp kit-list reader, wired to the demo catalogue.
 *
 * Paste a client's message, get back what is on the shelf and a reply to send.
 * No AI anywhere in it — matching runs on the device against the house's own
 * product names, offline, instantly, free.
 *
 * "Make a job from this" closes the loop the enquiry opens: the resolved
 * lines become the job's promised set, so the yes typed back into WhatsApp
 * and the pull list the tech scans against are the same fact.
 */
export function EnquiryScreen({
  store,
  onBook,
}: {
  store: DemoStore
  /** Pencil a booking from the answered list — the resolved lines,
   *  product and quantity, go to the sheet prefilled, with the dates the
   *  reply card carried when the desk set them. */
  onBook?: (lines: EnquiryLine[], window?: { startMs: number; endMs: number }) => void
}) {
  const [summary, setSummary] = useState<AvailabilitySummary | null>(null)
  const [creating, setCreating] = useState(false)
  const [asking, setAsking] = useState<Shortage[] | null>(null) // --- network ---
  const [pricing, setPricing] = useState(false)
  // The dates the client asked for: tomorrow 09:00 → the day after, 18:00
  // by default, the same defaults the booking sheet opens on. With them
  // set, the shelf answer subtracts confirmed bookings over the window
  // (0022 D6) and the reply carries a quote.
  const [win, setWin] = useState(() => {
    const pickup = defaultPickupMs(Date.now())
    return { start: toLocalInput(pickup), end: toLocalInput(defaultReturnMs(pickup)) }
  })
  const availabilityWindow = windowOf(win.start, win.end)
  const windowValid = availabilityWindow !== null
  // The turned-away demand log records ONCE per answered list, at the
  // moment the answer is USED (reply copied, or a job made) — a pasted
  // list the owner abandons was a draft, not a turned-away client, and
  // copying twice is one incident, not two.
  const [demandLogged, setDemandLogged] = useState(false)

  const onPaste = useCallback(
    (text: string) => {
      if (text.trim().length === 0) { setSummary(null); return }
      setSummary(store.checkKitList(text, availabilityWindow))
      setDemandLogged(false)
    },
    [store, availabilityWindow],
  )

  const onWindowChange = useCallback(
    (start: string, end: string) => {
      setWin({ start, end })
      // The dates changed under an answered list: re-answer it, so the
      // commitment layer and the reply's quote follow the new window.
      setSummary((prev) => (prev ? store.recheck(prev.lines, windowOf(start, end)) : prev))
    },
    [store],
  )

  const logDemand = useCallback(
    (current: AvailabilitySummary) => {
      if (demandLogged) return
      store.recordTurnedAway(current)
      setDemandLogged(true)
    },
    [store, demandLogged],
  )

  const onResolve = useCallback(
    (lineIndex: number, item: CatalogueItem) => {
      // The tech tapped the right product for a line the matcher would not
      // guess at. Re-checking the whole summary keeps the counts and the reply
      // consistent with the lines — recomputing only the one line is how the
      // reply drifts out of step with what is on screen.
      setSummary((prev) => {
        if (!prev) return prev
        const lines = prev.lines.map((l, i) =>
          i === lineIndex
            ? { ...l, productId: item.id, productName: item.name, confidence: 'exact' as const }
            : l,
        )
        return store.recheck(lines, availabilityWindow)
      })
    },
    [store, availabilityWindow],
  )

  const onCopyReply = useCallback(() => {
    if (!summary) return
    // The reply plus the indicative day-rate line — composed in the store so
    // what is copied and what is previewed are the same text.
    void navigator.clipboard?.writeText(store.replyText(summary, availabilityWindow)).catch(() => {})
    // Copying the reply is the answer being USED — the shortages in it are
    // now turned-away demand, and the product pages start counting them.
    logDemand(summary)
  }, [store, summary, logDemand, availabilityWindow])

  // What the sheet will actually promise: resolved lines only. Said out loud
  // on the sheet, because a job that silently drops the two unresolved lines
  // is a truck missing gear nobody decided to leave behind.
  const linesNote = useMemo(() => {
    if (!summary) return undefined
    const resolved = summary.lines.filter((l) => l.productId)
    const units = resolved.reduce((n, l) => n + l.quantity, 0)
    const unresolved = summary.lines.length - resolved.length
    const base = STR.enquiryLinesGoOnTheJob(units, resolved.length)
    return unresolved > 0
      ? STR.enquiryUnconfirmedLeftOut(base, unresolved)
      : base
  }, [summary])

  // --- network --- the short lines as an ask: what the shelf minus the
  // calendar cannot cover. The ask carries the reply card's dates when the
  // desk has set them; while they are blank or backwards it names
  // today → tomorrow and the desk corrects it in the sub-hire sheet.
  const askMarket = () => {
    if (!summary) return
    const now = Date.now()
    const fromMs = availabilityWindow?.startMs ?? now
    const untilMs = availabilityWindow?.endMs ?? now + DAY_MS
    setAsking(
      summary.lines
        .filter((l) => (l.state === 'short' || l.state === 'none') && l.productId)
        .map((l) => ({
          productId: l.productId as string,
          productName: l.productName ?? l.raw,
          qty: Math.max(1, l.wanted - Math.max(0, l.onHand - l.confirmedOverlap)),
          fromMs,
          untilMs,
        })),
    )
  }

  return (
    <>
      <Enquiry
        summary={summary}
        reply={summary ? store.replyText(summary, availabilityWindow) : ''}
        onAskMarket={askMarket}
        onPaste={onPaste}
        onResolve={onResolve}
        onCopyReply={onCopyReply}
        onCreateJob={() => setCreating(true)}
        onBook={
          onBook
            ? () => {
                if (!summary) return
                onBook(enquiryLines(summary), availabilityWindow ?? undefined)
              }
            : undefined
        }
        window={{ ...win, valid: windowValid }}
        onWindowChange={onWindowChange}
        onPrice={() => setPricing(true)}
      />
      {asking && asking.length > 0 ? (
        <AskTheMarketSheet store={store} shortage={asking} onClose={() => setAsking(null)} />
      ) : null}
      {pricing && summary && availabilityWindow ? (
        <QuoteSheet
          store={store}
          source={{
            kind: 'enquiry',
            lines: enquiryLines(summary),
            startMs: availabilityWindow.startMs,
            endMs: availabilityWindow.endMs,
            customerId: null,
          }}
          onClose={() => setPricing(false)}
          onBook={
            onBook
              ? (lines, s, e) => { setPricing(false); onBook(lines, { startMs: s, endMs: e }) }
              : undefined
          }
          onChanged={() => setSummary((prev) => (prev ? store.recheck(prev.lines, availabilityWindow) : prev))}
        />
      ) : null}
      {creating && summary ? (
        <NewJobSheet
          linesNote={linesNote}
          customers={store.customers()}
          onCreate={(input) => {
            store.createJobFromLines(summary.lines, input)
            // A job made from the list is the other way the answer gets
            // used — same one-incident rule as the reply copy.
            logDemand(summary)
            setCreating(false)
            // The new job's home is the board — land on it ready to scan.
            go({ name: 'jobs' })
          }}
          onClose={() => setCreating(false)}
        />
      ) : null}
    </>
  )
}

/** The two datetime-local values as a window, or null while they are
 *  blank or backwards — the one reading every consumer above shares. */
function windowOf(start: string, end: string): AvailabilityWindow | null {
  const a = fromLocalInput(start)
  const b = fromLocalInput(end)
  return a !== null && b !== null && b > a ? { startMs: a, endMs: b } : null
}
