import { useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * The manual path — search by code or name, tap to add.
 *
 * A PEER of the camera, not a buried fallback. Its absence is the single
 * biggest abandonment trigger in the research: a tag under gaffer tape at
 * 06:05 with no way forward teaches a tech on day one that the app has no
 * answer for the real world, and by week three they are back to the notebook.
 *
 * It records as `entry_method='manual'` (ScanSession.addManually), so it stays
 * countable rather than pretending to be a scan.
 */
export function ManualAdd({
  store,
  title = STR.scanCantScanIt,
  onPick,
  onClose,
}: {
  store: DemoStore
  title?: string
  onPick: (assetId: string) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const results = useMemo(
    () => (query.trim().length === 0 ? [] : store.searchAssets(query)),
    [store, query],
  )

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={title}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>

        <input
          className="sheet-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={STR.scanManualPlaceholder}
          autoFocus
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
        />

        {query.trim().length === 0 ? (
          <p className="sheet-hint">{STR.scanTypeAFewLetters}</p>
        ) : results.length === 0 ? (
          <p className="sheet-hint">{STR.scanNothingMatchesQuery(query)}</p>
        ) : (
          <ul className="sheet-list">
            {results.map((r) => (
              <li key={r.id}>
                <button className="sheet-row" onClick={() => onPick(r.id)}>
                  <span className="sheet-row-name">{r.name}</span>
                  <span className="sheet-row-code code">{r.code}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
