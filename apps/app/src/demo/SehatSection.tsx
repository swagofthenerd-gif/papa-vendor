import { moneyLabel } from '@papa/core'
import { SectionHead } from '../components/Shell.tsx'
import { go } from '../nav.ts'
import { STR } from '../strings.ts'
import type { Sehat } from './read-model.ts'

/**
 * Sehat — the fleet's health, as the smallest honest door (0021; Phase D
 * 1–2/6). A section on the Gear screen, because fleet health is a gear
 * question and the ginti and closed-jobs doors already live here — not a
 * new tab. Three groups — service due, past the cycle ceiling, dead stock
 * — each row a plain door to its asset page, where the Serviced action and
 * the full story live.
 *
 * Groups render only when non-empty, and the whole section disappears when
 * the fleet is clean: a health surface with no findings is noise, and the
 * day it reappears IS the signal.
 */
export function SehatSection({ sehat }: { sehat: Sehat }) {
  const empty =
    sehat.serviceDue.length === 0 &&
    sehat.cyclesOver.length === 0 &&
    sehat.deadStock.length === 0
  if (empty) return null

  const deadValue = moneyLabel(sehat.deadStockValue)

  return (
    <section className="section">
      <SectionHead icon="wrench" title={STR.sehatHeading} sub={STR.sehatSubtitle} />

      {sehat.serviceDue.length > 0 ? (
        <SehatGroup
          heading={STR.sehatServiceDue}
          rows={sehat.serviceDue.map((r) => ({
            id: r.id,
            code: r.code,
            name: r.name,
            note: STR.sehatServiceRow(r.days, r.dueAfter),
          }))}
        />
      ) : null}

      {sehat.cyclesOver.length > 0 ? (
        <SehatGroup
          heading={STR.sehatCyclesOver}
          rows={sehat.cyclesOver.map((r) => ({
            id: r.id,
            code: r.code,
            name: r.name,
            note: STR.sehatCycleRow(r.cycles, r.ceiling),
          }))}
        />
      ) : null}

      {sehat.deadStock.length > 0 ? (
        <SehatGroup
          heading={
            STR.sehatDeadStock(sehat.deadStockDays) +
            (deadValue !== null ? ` · ${deadValue}` : '')
          }
          rows={sehat.deadStock.map((r) => ({
            id: r.id,
            code: r.code,
            name: r.name,
            note: STR.sehatDeadRow(r.idleDays),
          }))}
        />
      ) : null}
    </section>
  )
}

function SehatGroup({
  heading,
  rows,
}: {
  heading: string
  rows: { id: string; code: string; name: string; note: string }[]
}) {
  return (
    <div className="sehat-group">
      <h3 className="hisaab-sub">{heading}</h3>
      <ul className="line-list">
        {rows.map((r) => (
          <li key={r.id}>
            <button
              className="line line-tap pressable"
              onClick={() => go({ name: 'asset', assetId: r.id })}
            >
              <span className="line-name">{r.name}</span>
              <span className="line-note">{r.note}</span>
              <span className="line-code code">{r.code}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
