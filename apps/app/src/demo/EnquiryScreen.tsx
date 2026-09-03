import { useCallback, useMemo, useState } from 'react'
import type { AvailabilitySummary, CatalogueItem } from '@papa/core'
import { Enquiry } from '../routes/Enquiry.tsx'
import { NewJobSheet } from './NewJobSheet.tsx'
import { go } from '../nav.ts'
import type { DemoStore } from './store.ts'
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
export function EnquiryScreen({ store }: { store: DemoStore }) {
  const [summary, setSummary] = useState<AvailabilitySummary | null>(null)
  const [creating, setCreating] = useState(false)

  const onPaste = useCallback(
    (text: string) => {
      if (text.trim().length === 0) { setSummary(null); return }
      setSummary(store.checkKitList(text))
    },
    [store],
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
        return store.recheck(lines)
      })
    },
    [store],
  )

  const onCopyReply = useCallback(() => {
    if (!summary) return
    // The reply plus the indicative day-rate line — composed in the store so
    // what is copied and what is previewed are the same text.
    void navigator.clipboard?.writeText(store.replyText(summary)).catch(() => {})
  }, [store, summary])

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

  return (
    <>
      <Enquiry
        summary={summary}
        reply={summary ? store.replyText(summary) : ''}
        onPaste={onPaste}
        onResolve={onResolve}
        onCopyReply={onCopyReply}
        onCreateJob={() => setCreating(true)}
      />
      {creating && summary ? (
        <NewJobSheet
          linesNote={linesNote}
          onCreate={(input) => {
            store.createJobFromLines(summary.lines, input)
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
