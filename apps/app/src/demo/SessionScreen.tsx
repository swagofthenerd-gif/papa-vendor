import { useCallback, useEffect, useState } from 'react'
import QRCode from 'qrcode'
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
  const [parchi, setParchi] = useState<string | null>(null)

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
        onShowParchi={() => {
          // The challan is stamped when the button is pressed — the moment
          // the truck is actually at the gate, not the moment scanning began.
          const text = store.parchiText(jobId)
          if (text) setParchi(text)
        }}
        onBackToScanning={() => go({ name: 'scan', jobId, mode: 'out' })}
        onDone={() => {
          store.endSession()
          go({ name: 'jobs' })
        }}
      />
      {parchi ? (
        <ParchiOverlay
          jobLabel={summary.jobLabel}
          text={parchi}
          onClose={() => setParchi(null)}
        />
      ) : null}
    </Shell>
  )
}

/**
 * The parchi, full screen — this phone IS the gate pass.
 *
 * Hard black-on-white regardless of theme: the gate is the one place this app
 * is guaranteed to be read in direct sun, and a QR code is the one element
 * that must not inherit a softened palette — maximum luminance and contrast
 * is exactly what the sun theme itself does, so white is right in every
 * theme. The job label is big above the code so the guard knows which truck
 * this pass belongs to before anything is scanned.
 *
 * Closing is a plain tap anywhere — nothing here writes, so there is nothing
 * a mis-tap can destroy.
 */
function ParchiOverlay({
  jobLabel,
  text,
  onClose,
}: {
  jobLabel: string
  text: string
  onClose: () => void
}) {
  const [image, setImage] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Level M to match the label encoder the round-trip test pins down, and
    // a wide margin: the quiet zone is what lets another phone's camera lock
    // on at arm's length through two layers of glass.
    QRCode.toDataURL(text, {
      errorCorrectionLevel: 'M',
      margin: 3,
      width: 640,
      color: { dark: '#000000', light: '#ffffff' },
    })
      .then((url) => { if (!cancelled) setImage(url) })
      .catch(() => { if (!cancelled) setImage(null) })
    return () => { cancelled = true }
  }, [text])

  return (
    <div
      className="parchi-overlay"
      role="dialog"
      aria-label="Parchi — gate pass"
      onClick={onClose}
    >
      <p className="parchi-job">{jobLabel}</p>
      {image ? (
        <img className="parchi-qr" src={image} alt="The challan as a QR code" />
      ) : (
        <div className="parchi-qr parchi-qr-empty" />
      )}
      <p className="parchi-hint">
        Any phone camera reads this — the challan text opens directly, no app
        needed. Tap anywhere to close.
      </p>
    </div>
  )
}
