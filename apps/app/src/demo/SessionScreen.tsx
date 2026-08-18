import { useCallback } from 'react'
import { Icon } from '@papa/icons'
import { Session } from '../routes/Session.tsx'
import { manifestText } from '../session-summary.ts'
import { Shell } from '../components/Shell.tsx'
import { go, type View } from '../nav.ts'
import type { DemoStore } from './store.ts'

/**
 * The handover summary for the session just finished.
 *
 * If the session is gone — a refresh, or arriving on this URL cold — this says
 * so rather than rendering an empty tally. A summary that reports zeros looks
 * exactly like a session where nothing was scanned, and that is the one thing
 * a tech must never be shown after a morning's work.
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
          <p>That scan session has finished.</p>
          <p className="muted">
            Summaries live only while the session is open — nothing is uploaded yet.
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
