import { useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import { go } from '../nav.ts'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { toBucket } from '../status.ts'
import type { Presence, Health } from '../status.ts'
import { STR } from '../strings.ts'

/**
 * The inventory, search-first.
 *
 * SEARCH BEFORE BROWSE. A rental house has thousands of items and the person
 * looking already knows what they want — they are holding it, or a client just
 * named it. Making them walk a category tree to reach a known thing is the
 * console equivalent of walking to the shelf, which is the behaviour this
 * whole product exists to replace.
 *
 * The filters are the three questions actually asked of a fleet: where is it,
 * is it healthy, and whose shelf is it on. Not a taxonomy.
 */

export interface GearRow {
  id: string
  code: string
  name: string
  category: string
  presence: Presence
  health: Health
  locationName: string | null
  jobLabel: string | null
}

export type GearFilter = 'all' | 'here' | 'out' | 'attention'

const FILTERS: { key: GearFilter; label: string }[] = [
  { key: 'all', label: STR.gearFilterEverything },
  { key: 'here', label: STR.gearFilterOnTheShelf },
  { key: 'out', label: STR.gearFilterOut },
  { key: 'attention', label: STR.gearFilterNeedsALook },
]

export function Gear({
  rows,
  initialQuery = '',
  initialFilter = 'all',
}: {
  rows: GearRow[]
  initialQuery?: string
  initialFilter?: GearFilter
}) {
  const [query, setQuery] = useState(initialQuery)
  const [filter, setFilter] = useState<GearFilter>(initialFilter)

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) => {
      // The same three-axes-to-one-bucket collapse the badge uses, so a
      // filter and the chip it filters by never disagree on the same row.
      if (filter !== 'all' && toBucket(r) !== filter) return false
      if (q.length === 0) return true
      return (
        r.name.toLowerCase().includes(q) ||
        r.code.toLowerCase().includes(q) ||
        r.category.toLowerCase().includes(q)
      )
    })
  }, [rows, query, filter])

  // Grouped by product so twelve identical batteries read as one line with a
  // count, not twelve rows that bury everything else on the screen.
  const groups = useMemo(() => {
    const map = new Map<string, GearRow[]>()
    for (const r of shown) {
      const list = map.get(r.name) ?? []
      list.push(r)
      map.set(r.name, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [shown])

  return (
    <>
      <div className="search-wrap">
        <Icon name="search" size={18} className="search-ico" />
        <input
          className="searchbox"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={STR.gearSearchPlaceholder}
          autoCorrect="off"
          autoCapitalize="none"
          spellCheck={false}
          aria-label={STR.todaySearchGearAria}
        />
        {query ? (
          <button className="search-clear" onClick={() => setQuery('')} aria-label={STR.gearClearSearchAria}>
            <Icon name="x" size={16} />
          </button>
        ) : null}
      </div>

      <div className="chip-row">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-chip${filter === f.key ? ' active' : ''}`}
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
          >
            {f.label}
          </button>
        ))}
      </div>

      <p className="result-count">
        {STR.gearItemCount(shown.length)}
        {groups.length !== shown.length ? STR.gearKindsSuffix(groups.length) : ''}
      </p>

      {shown.length === 0 ? (
        <div className="empty">
          <Icon name="search" size={36} />
          <p>{STR.gearNothingMatches}</p>
          <p className="muted">
            {query ? STR.gearNoGearCalled(query) : STR.gearNothingInThisFilter}
          </p>
        </div>
      ) : (
        <ul className="gear-list">
          {groups.map(([name, items], i) => (
            <li key={name} className="gear-group stagger" style={{ ['--i' as string]: Math.min(i, 12) }}>
              <div className="gear-group-head">
                <span className="gear-group-name">{name}</span>
                <span className="gear-group-count code">{items.length}</span>
              </div>
              <ul className="gear-units">
                {items.map((r) => (
                  <li key={r.id}>
                    <button
                      className="gear-unit pressable"
                      onClick={() => go({ name: 'asset', assetId: r.id })}
                    >
                      <span className="gear-code code">{r.code}</span>
                      <span className="gear-where">
                        {/* Where it IS, in the words a person would use.
                            "Out — Wedding, DHA" beats a status enum. */}
                        {r.presence === 'here'
                          ? (r.locationName ?? STR.gearSomewhereHere)
                          : (r.jobLabel ?? STR.gearOutFallback)}
                      </span>
                      <StatusBadge status={{ presence: r.presence, health: r.health }} />
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
