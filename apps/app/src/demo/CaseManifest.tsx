import { Icon } from '@papa/icons'
import type { CaseManifest as Manifest, ContainedChild } from '@papa/core'

/**
 * What a case says it contains.
 *
 * THE UNCONFIRMED LIST IS THE POINT. Everything here is a claim until somebody
 * acts on it, and the two ways of acting are deliberately not equal:
 *
 *   - Scan each one. That is an observation.
 *   - "Take the case as packed". That is a BELIEF, recorded as `assumed`,
 *     counted separately, and excluded from dispute evidence.
 *
 * The second button says what it is doing in the words a person would use
 * against themselves later — "nobody looked inside" — because the whole reason
 * it exists is that everyone will press it on a busy morning, and the record
 * has to survive that honestly.
 *
 * There is no third button that marks them as scanned.
 */
export function CaseManifestSheet({
  manifest,
  alreadyRecorded,
  onConfirmAll,
  onScanIndividually,
  onClose,
}: {
  manifest: Manifest
  /** Ids already recorded this session, so a scanned child reads as settled. */
  alreadyRecorded: Set<string>
  onConfirmAll: (assetIds: string[]) => void
  onScanIndividually: () => void
  onClose: () => void
}) {
  const outstanding = manifest.packed.filter((c) => !alreadyRecorded.has(c.assetId))

  return (
    <div className="sheet-backdrop" role="dialog" aria-label="What is in this case">
      <div className="sheet">
        <header className="sheet-head">
          <div>
            <span className="sheet-title">{manifest.parentName ?? 'Case'}</span>
            <p className="photo-side">
              {manifest.packed.length} item{manifest.packed.length === 1 ? '' : 's'} believed inside
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={22} />
          </button>
        </header>

        {manifest.permanent.length > 0 ? (
          <div className="manifest-fixed">
            <span className="compare-label">Part of the case</span>
            <ul className="manifest-list">
              {manifest.permanent.map((c) => (
                <Row key={c.assetId} child={c} state="fixed" />
              ))}
            </ul>
            <p className="sheet-hint">
              These cannot leave without it, so they are recorded with the case.
            </p>
          </div>
        ) : null}

        <span className="compare-label">Packed inside — not looked at</span>
        <ul className="manifest-list">
          {manifest.packed.map((c) => (
            <Row
              key={c.assetId}
              child={c}
              state={alreadyRecorded.has(c.assetId) ? 'scanned' : 'unconfirmed'}
            />
          ))}
        </ul>

        <div className="session-actions">
          <button className="btn btn-primary btn-block" onClick={onScanIndividually}>
            <Icon name="camera" size={18} /> Scan them one by one
          </button>
          <button
            className="btn btn-ghost btn-block"
            disabled={outstanding.length === 0}
            onClick={() => onConfirmAll(outstanding.map((c) => c.assetId))}
          >
            Take the case as packed · {outstanding.length} unchecked
          </button>
          <p className="session-foot muted">
            Taking it as packed records those items as <strong>assumed</strong>. They
            are counted separately and are not used as evidence if this job turns
            into a damage claim.
          </p>
        </div>
      </div>
    </div>
  )
}

function Row({ child, state }: { child: ContainedChild; state: 'fixed' | 'scanned' | 'unconfirmed' }) {
  return (
    <li className={`manifest-row is-${state}`}>
      <Icon
        name={state === 'unconfirmed' ? 'question' : 'check'}
        size={16}
      />
      <span className="manifest-name">{child.displayName ?? 'Unnamed'}</span>
      <span className="manifest-code code">{child.assetCode ?? '—'}</span>
    </li>
  )
}
