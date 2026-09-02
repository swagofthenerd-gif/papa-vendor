import { useCallback } from 'react'
import { Icon } from '@papa/icons'
import { Session } from '../routes/Session.tsx'
import { manifestText } from '../session-summary.ts'
import { Shell } from '../components/Shell.tsx'
import { go, type View } from '../nav.ts'
import type { DemoStore } from './store.ts'

/**
 * The handover summary — live session or long finished.
 *
 * Finished sessions are rebuilt from the outbox plus the scan_sessions row
 * written when they opened, so "done" on this card no longer destroys the
 * only record of the morning. The empty state below is therefore reachable
 * only when NO session was ever recorded on this job — arriving on the URL
 * cold — and it says that, rather than rendering an empty tally: a summary
 * of zeros looks exactly like a session where nothing was scanned, which is
 * the one thing a tech must never be shown after a morning's work.
 */
export function SessionScreen({ store, jobId }: { store: DemoStore; jobId: string }) {
  const summary = store.sessionSummary(jobId)
  const view: View = { name: 'session', sessionId: jobId }

  const onShare = useCallback(() => {
    if (!summary) return
    const text = manifestText(summary)
    // WhatsApp where it exists, clipboard where it does not. Both end with the
    // list in the client's chat, which is the only outcome that matters.
    const url = `https://wa.me/?text=${encodeURIComponent(text)}`
    const win = window.open(url, '_blank', 'noopener')
    if (!win) void navigator.clipboard?.writeText(text).catch(() => {})
  }, [summary])

  if (!summary) {
    return (
      <Shell view={view} title="Handover" subtitle="Nothing open">
        <div className="empty">
          <Icon name="clipboard-check" size={36} />
          <p>Nothing has been scanned on this job yet.</p>
          <p className="muted">
            Scan gear out or back in and the handover summary will be here —
            finished sessions stay reviewable from the job card.
          </p>
          <button className="btn btn-outline" onClick={() => go({ name: 'jobs' })}>
            Back to today
          </button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell view={view} title="Handover" subtitle={summary.jobLabel}>
      <Session
        summary={summary}
        onShareWhatsApp={onShare}
        onBackToScanning={() => go({ name: 'scan', jobId, mode: 'out' })}
        onDone={() => {
          store.endSession()
          go({ name: 'jobs' })
        }}
      />
    </Shell>
  )
}
