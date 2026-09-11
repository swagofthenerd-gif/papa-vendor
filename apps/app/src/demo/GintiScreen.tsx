import { useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import { cycleCountDiff } from '@papa/core'
import { SectionHead } from '../components/Shell.tsx'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import { STR } from '../strings.ts'
import type { DemoStore } from './store.ts'

/**
 * Ginti — the cycle count.
 *
 * A stocktake is a DIFF: what the book says is on this shelf, against what
 * the tech actually finds standing in front of it. Pick a shelf, mark the
 * items you can see (a real scanner decodes tags; the demo taps), and the
 * three live counts — matched, missing, not-on-this-shelf — update as you
 * go. Finishing writes an inventory_count for every SEEN item (non-
 * destructive: last_scanned_at moves, nothing returns home) and hands back a
 * copyable discrepancy report. Missing items are the owner's to decide —
 * found elsewhere, or lost — never auto-marked (0020 D6).
 */
export function GintiScreen({ store }: { store: DemoStore }) {
  const shelves = useMemo(() => store.shelves(), [store])
  const [shelfId, setShelfId] = useState<string | null>(null)
  const [seen, setSeen] = useState<Set<string>>(new Set())
  const [report, setReport] = useState<string | null>(null)

  const shelf = shelves.find((s) => s.id === shelfId) ?? null
  // The expected set is read once when a shelf is chosen — a snapshot, like a
  // return session's, so the "missing" count does not melt as items are
  // marked seen.
  const expected = useMemo(
    () => (shelfId ? store.gearOnShelf(shelfId) : []),
    [store, shelfId],
  )

  const diff = useMemo(
    () => cycleCountDiff(expected.map((e) => e.id), [...seen]),
    [expected, seen],
  )

  if (!shelfId) {
    return (
      <>
        <SectionHead icon="shelf" title={STR.fleetGintiPickShelf} sub={STR.fleetGintiScanShelf} />
        <ul className="gear-units">
          {shelves.map((s) => (
            <li key={s.id}>
              <button
                className="gear-unit pressable"
                onClick={() => { setShelfId(s.id); setSeen(new Set()); setReport(null) }}
              >
                <Icon name="shelf" size={18} />
                <span className="gear-where">{s.name}</span>
                <Icon name="chevron-right" size={16} />
              </button>
            </li>
          ))}
        </ul>
      </>
    )
  }

  if (report !== null) {
    return (
      <>
        <SectionHead icon="clipboard-check" title={STR.fleetGinti} sub={shelf?.name} />
        <div className="chip-row">
          <span className="filter-chip">{STR.fleetGintiOk(diff.ok.length)}</span>
          <span className={`filter-chip${diff.missing.length ? ' active' : ''}`}>
            {STR.fleetGintiMissing(diff.missing.length)}
          </span>
          <span className={`filter-chip${diff.unexpected.length ? ' active' : ''}`}>
            {STR.fleetGintiUnexpected(diff.unexpected.length)}
          </span>
        </div>
        <pre className="report-block">{report}</pre>
        <button
          className="btn btn-primary btn-block"
          onClick={() => { void navigator.clipboard?.writeText(report).catch(() => {}) }}
        >
          <Icon name="clipboard" size={18} /> {STR.fleetGintiReportButton}
        </button>
        <button className="btn btn-ghost btn-block" onClick={() => { setShelfId(null); setReport(null) }}>
          {STR.commonClose}
        </button>
      </>
    )
  }

  const toggle = (id: string) => {
    setSeen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <>
      <SectionHead icon="scan" title={STR.fleetGintiCounting(shelf?.name ?? '')} sub={STR.fleetGintiScanItems} />
      <div className="chip-row">
        <span className="filter-chip">{STR.fleetGintiSeen(seen.size)}</span>
        <span className="filter-chip">{STR.fleetGintiOk(diff.ok.length)}</span>
        <span className={`filter-chip${diff.missing.length ? ' active' : ''}`}>
          {STR.fleetGintiMissing(diff.missing.length)}
        </span>
      </div>

      <ul className="gear-units">
        {expected.map((e) => (
          <li key={e.id}>
            <button
              className={`gear-unit pressable${seen.has(e.id) ? ' is-seen' : ''}`}
              onClick={() => toggle(e.id)}
              aria-pressed={seen.has(e.id)}
            >
              <span className="gear-code code">{e.code}</span>
              <span className="gear-where">{e.name}</span>
              <Icon name={seen.has(e.id) ? 'check-circle' : 'scan'} size={18} />
            </button>
          </li>
        ))}
      </ul>

      <div className="session-actions">
        <HoldToFinish
          label={STR.fleetGintiFinish}
          onFinish={() => {
            const result = store.runGinti(shelfId, [...seen])
            setReport(result.report)
          }}
        />
      </div>
    </>
  )
}
