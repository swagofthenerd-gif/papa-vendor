import { Icon } from '@papa/icons'
import { go } from '../nav.ts'
import { SectionHead } from '../components/Shell.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { statusSentence, type Health, type Presence } from '../status.ts'
import { PhotoCompare } from '../components/PhotoCompare.tsx'
import type { PhotoPair } from '@papa/core'

/**
 * One item.
 *
 * THE STATUS IS A SENTENCE HERE, not a badge. A person on this page has time
 * to read, and "On the Wedding job since Tuesday, due back Sunday" answers the
 * question a coloured dot only gestures at. The badge stays as well, because
 * this page is also reached by scanning something in your hand and glancing.
 *
 * The history is the point of the whole product. It is the append-only scan
 * log rendered plainly, and it is what settles an argument with a client — so
 * it names WHO and HOW, and never hides that an entry was assumed rather than
 * seen.
 */

export interface AssetHistoryRow {
  id: string
  event: string
  at: string
  entryMethod: string
  jobLabel: string | null
  actor: string
}

export interface AssetView {
  id: string
  code: string
  name: string
  category: string
  presence: Presence
  health: Health
  locationName: string | null
  jobLabel: string | null
  serial: string | null
  tagCode: string | null
  history: AssetHistoryRow[]
}

/** How an entry got into the log, said plainly. */
const METHOD_LABEL: Record<string, string> = {
  scanned: 'scanned',
  manual: 'typed in by hand',
  assumed: 'assumed — in a case, not seen',
  implied: 'moved with its parent',
  counted: 'counted',
}

const EVENT_LABEL: Record<string, string> = {
  check_out: 'Went out',
  check_in: 'Came back',
  intake: 'Added to the fleet',
  move: 'Moved',
}

export function Asset({
  asset,
  photoPairs,
  onProveIt,
}: {
  asset: AssetView | null
  photoPairs: PhotoPair[]
  /** Share the alibi card built from this item's local history. */
  onProveIt: () => void
}) {
  if (!asset) {
    return (
      <div className="empty">
        <Icon name="question" size={36} />
        <p>No such item.</p>
        <button className="btn btn-ghost" onClick={() => go({ name: 'gear' })}>
          Back to the gear
        </button>
      </div>
    )
  }

  const sentence = statusSentence(
    { presence: asset.presence, health: asset.health },
    { jobLabel: asset.jobLabel, locationName: asset.locationName },
  )

  return (
    <>
      <div className="asset-head">
        <div className="asset-id">
          <span className="asset-code code">{asset.code}</span>
          <StatusBadge status={{ presence: asset.presence, health: asset.health }} showLabel />
        </div>
        <h2 className="asset-name">{asset.name}</h2>
        <p className="asset-status">{sentence}</p>
      </div>

      <dl className="fact-grid">
        <div className="fact">
          <dt>Category</dt>
          <dd>{asset.category}</dd>
        </div>
        <div className="fact">
          <dt>Shelf</dt>
          <dd>{asset.locationName ?? '—'}</dd>
        </div>
        <div className="fact">
          <dt>Serial</dt>
          <dd className="code">{asset.serial ?? 'not recorded'}</dd>
        </div>
        <div className="fact">
          <dt>Tag</dt>
          {/* Truncated, because the code is opaque by design and nobody reads
              it — but shown, because "is this thing even tagged" is a real
              question at the bench. */}
          <dd className="code">{asset.tagCode ? `${asset.tagCode.slice(0, 8)}…` : 'no tag'}</dd>
        </div>
      </dl>

      {/* The tech's alibi (PLAN.md's "Prove it"): this item's story — state,
          last scan, photo count — as one WhatsApp card built from local data.
          A full-width tap, glove-sized, with nothing destructive anywhere on
          this page to mis-tap into; it reads, it never writes. */}
      <button className="btn btn-outline btn-block" onClick={onProveIt}>
        <Icon name="send" size={18} /> Prove it — share this item’s record
      </button>

      <section className="section">
        <SectionHead
          icon="camera"
          title="Condition"
          sub={
            photoPairs.length === 0
              ? 'Nothing photographed'
              : 'What it looked like going out, beside how it came back'
          }
        />
        <PhotoCompare pairs={photoPairs} />
      </section>

      <section className="section">
        <SectionHead
          icon="scroll"
          title="History"
          sub={
            asset.history.length === 0
              ? 'Nothing recorded yet'
              : `${asset.history.length} entr${asset.history.length === 1 ? 'y' : 'ies'}, newest first`
          }
        />

        {asset.history.length === 0 ? (
          <div className="empty">
            <Icon name="scroll" size={32} />
            <p>This item has not moved yet.</p>
            <p className="muted">Scan it out on a job and it will show up here.</p>
          </div>
        ) : (
          <ol className="history">
            {asset.history.map((h) => (
              <li key={h.id} className={h.entryMethod === 'assumed' ? 'is-assumed' : ''}>
                <span className="hist-dot" aria-hidden="true" />
                <div className="hist-body">
                  <span className="hist-event">{EVENT_LABEL[h.event] ?? h.event}</span>
                  {h.jobLabel ? <span className="hist-job">{h.jobLabel}</span> : null}
                  <span className="hist-meta">
                    {h.at} · {h.actor} · {METHOD_LABEL[h.entryMethod] ?? h.entryMethod}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}
