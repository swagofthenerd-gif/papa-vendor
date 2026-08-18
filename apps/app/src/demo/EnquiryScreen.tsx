import { useCallback, useState } from 'react'
import { replySummary, type AvailabilitySummary, type CatalogueItem } from '@papa/core'
import { Enquiry } from '../routes/Enquiry.tsx'
import type { DemoStore } from './store.ts'

/**
 * The WhatsApp kit-list reader, wired to the demo catalogue.
 *
 * Paste a client's message, get back what is on the shelf and a reply to send.
 * No AI anywhere in it — matching runs on the device against the house's own
 * product names, offline, instantly, free.
 */
export function EnquiryScreen({ store }: { store: DemoStore }) {
  const [summary, setSummary] = useState<AvailabilitySummary | null>(null)

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
    void navigator.clipboard?.writeText(replySummary(summary)).catch(() => {})
  }, [summary])

  return (
    <Enquiry
      summary={summary}
      reply={summary ? replySummary(summary) : ''}
      onPaste={onPaste}
      onResolve={onResolve}
      onCopyReply={onCopyReply}
      onCreateJob={() => {}}
    />
  )
}
