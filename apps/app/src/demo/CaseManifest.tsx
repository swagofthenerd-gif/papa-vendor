import { useState } from 'react'
import { Icon } from '@papa/icons'
import type { CaseManifest as Manifest, ContainedChild } from '@papa/core'
import { confirmRest, toggleNotInHere } from '../case-confirm.ts'

/**
 * What a case says it contains.
 *
 * THE UNCONFIRMED LIST IS THE POINT. Everything here is a claim until somebody
 * acts on it, and the ways of acting are deliberately not equal:
 *
 *   - Scan each one. That is an observation.
 *   - "Take the case as packed". That is a BELIEF, recorded as `assumed`,
 *     counted separately, and excluded from dispute evidence.
 *   - Toggle a row "not in here" first. That is a DISBELIEF: the row is left
 *     out of the bulk confirm entirely — nothing is written for it — so it
 *     stays unrecorded and shows up on the session shortfall as missing.
 *
 * The second button says what it is doing in the words a person would use
 * against themselves later — "nobody looked inside" — because the whole reason
 * it exists is that everyone will press it on a busy morning, and the record
 * has to survive that honestly.
 *
 * There is no button anywhere that marks them as scanned.
 *
 * The "not in here" toggle is a plain tap beside a frequent action, which the
 * adjacency rule (PLAN.md) allows only because it is NOT destructive: it
 * writes nothing, it is undone by the same tap, and the row it marks changes
 * shape loudly. The acting gesture is still the confirm button below, whose
 * count updates as rows are toggled.
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
  const [notInHere, setNotInHere] = useState<Set<string>>(new Set())

  const outstanding = confirmRest(manifest.packed, alreadyRecorded, notInHere)
  const excluded = manifest.packed.filter(
    (c) => notInHere.has(c.assetId) && !alreadyRecorded.has(c.assetId),
  ).length

  const rowState = (c: ContainedChild): RowState => {
    if (alreadyRecorded.has(c.assetId)) return 'scanned'
    return notInHere.has(c.assetId) ? 'excluded' : 'unconfirmed'
  }

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
          {manifest.packed.map((c) => {
            const state = rowState(c)
            return (
              <Row
                key={c.assetId}
                child={c}
                state={state}
                onToggle={
                  state === 'scanned'
                    ? undefined
                    : () => setNotInHere((prev) => toggleNotInHere(prev, c.assetId))
                }
              />
            )
          })}
        </ul>

        <div className="session-actions">
          <button className="btn btn-primary btn-block" onClick={onScanIndividually}>
            <Icon name="camera" size={18} /> Scan them one by one
          </button>
          <button
            className="btn btn-ghost btn-block"
            disabled={outstanding.length === 0}
            onClick={() => onConfirmAll(outstanding)}
          >
            {excluded > 0
              ? `Take the rest as packed · ${outstanding.length} unchecked`
              : `Take the case as packed · ${outstanding.length} unchecked`}
          </button>
          <p className="session-foot muted">
            Taking it as packed records those items as <strong>assumed</strong>. They
            are counted separately and are not used as evidence if this job turns
            into a damage claim.
            {excluded > 0 ? (
              <>
                {' '}
                {excluded === 1 ? 'One item' : `${excluded} items`} marked not in
                here will be recorded as nothing at all, and will show as missing
                on the handover.
              </>
            ) : null}
          </p>
        </div>
      </div>
    </div>
  )
}

type RowState = 'fixed' | 'scanned' | 'unconfirmed' | 'excluded'

function Row({
  child,
  state,
  onToggle,
}: {
  child: ContainedChild
  state: RowState
  /** Present only on rows a person may still mark "not in here". */
  onToggle?: () => void
}) {
  return (
    <li className={`manifest-row is-${state}`}>
      <Icon
        name={state === 'excluded' ? 'x' : state === 'unconfirmed' ? 'question' : 'check'}
        size={16}
      />
      <span className="manifest-name">{child.displayName ?? 'Unnamed'}</span>
      <span className="manifest-code code">{child.assetCode ?? '—'}</span>
      {onToggle ? (
        <button className="btn btn-sm btn-ghost" onClick={onToggle}>
          {state === 'excluded' ? 'It is here' : 'Not in here'}
        </button>
      ) : null}
    </li>
  )
}
