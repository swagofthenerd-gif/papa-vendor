import { useCallback, useMemo, useState } from 'react'
import { Icon } from '@papa/icons'
import {
  guessMapping,
  parseCsv,
  planImport,
  readRows,
  type CatalogueItem,
  type ColumnMapping,
  type FieldName,
  type ImportPlan,
} from '@papa/core'
import { SectionHead } from '../components/Shell.tsx'
import { STR } from '../strings.ts'

/**
 * Loading the house's existing catalogue.
 *
 * THREE STEPS, AND THE MIDDLE ONE IS THE POINT: paste the file, CHECK THE
 * COLUMNS, then look at what would happen before any of it happens. The
 * column-mapping step exists because a serial-number column silently read as
 * the product name is four hundred wrong rows that all look plausible, and
 * nobody re-reads an import afterwards.
 *
 * Nothing is written until the last button. Everything before it is a preview
 * of a decision, not the decision.
 */

const FIELD_LABEL: Record<FieldName, string> = {
  name: STR.labelsFieldProductName,
  code: STR.labelsFieldAssetCode,
  serial: STR.labelsFieldSerialNumber,
  category: STR.labelsFieldCategory,
  quantity: STR.labelsFieldHowMany,
  location: STR.labelsFieldShelf,
}

const FIELD_ORDER: FieldName[] = ['name', 'quantity', 'code', 'serial', 'category', 'location']

const SAMPLE = `Item Description,Qty,Asset Code,Shelf
Sony FX9,2,FX9,Rack A
Canon C500 Mark II,1,C500,Rack A
Zeiss Supreme Prime Set,1,ZSS,Rack B
XLR Cable 5m,20,XLR,Battery Cage`

export function Import({
  catalogue,
  onApply,
}: {
  catalogue: CatalogueItem[]
  onApply: (plan: ImportPlan) => void
}) {
  const [text, setText] = useState('')
  const [mapping, setMapping] = useState<ColumnMapping | null>(null)

  const table = useMemo(() => (text.trim() ? parseCsv(text) : null), [text])

  const effectiveMapping = useMemo(
    () => mapping ?? (table ? guessMapping(table.headers) : {}),
    [mapping, table],
  )

  const plan = useMemo((): ImportPlan | null => {
    if (!table || effectiveMapping.name === undefined) return null
    const { rows, rejected } = readRows(table, effectiveMapping)
    return planImport(rows, catalogue, rejected)
  }, [table, effectiveMapping, catalogue])

  const setField = useCallback(
    (field: FieldName, columnIndex: number | undefined) => {
      setMapping((prev) => {
        const base = { ...(prev ?? effectiveMapping) }
        // One column cannot be two things. Silently allowing it produces a
        // catalogue where the serial and the code are the same string.
        for (const key of Object.keys(base) as FieldName[]) {
          if (base[key] === columnIndex) delete base[key]
        }
        if (columnIndex === undefined) delete base[field]
        else base[field] = columnIndex
        return base
      })
    },
    [effectiveMapping],
  )

  if (!table) {
    return (
      <div className="paste-zone">
        <p className="import-lead">{STR.labelsImportLead}</p>
        <textarea
          className="paste-box"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={STR.labelsImportPlaceholder}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          rows={10}
        />
        <button className="btn btn-ghost" onClick={() => setText(SAMPLE)}>
          {STR.labelsTryASampleList}
        </button>
      </div>
    )
  }

  return (
    <>
      <div className="enquiry-bar">
        <button className="btn btn-ghost btn-sm" onClick={() => { setText(''); setMapping(null) }}>
          {STR.labelsStartAgain}
        </button>
      </div>

      <section className="section">
        <SectionHead
          icon="sliders"
          title={STR.labelsCheckTheColumns}
          sub={STR.labelsRowsTheseAreGuesses(table.rows.length)}
        />
        <div className="map-grid">
          {FIELD_ORDER.map((field) => (
            <label key={field} className="map-row">
              <span className="map-label">
                {FIELD_LABEL[field]}
                {field === 'name' ? <span className="map-req"> {STR.labelsRequired}</span> : null}
              </span>
              <select
                className="map-select"
                value={effectiveMapping[field] ?? ''}
                onChange={(e) =>
                  setField(field, e.target.value === '' ? undefined : Number(e.target.value))
                }
              >
                <option value="">{STR.labelsNotInThisFile}</option>
                {table.headers.map((h, i) => (
                  <option key={i} value={i}>
                    {h || STR.labelsColumnN(i + 1)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        {effectiveMapping.name === undefined ? (
          <div className="notice notice-warn">
            <Icon name="warning" size={18} />
            <div>
              <strong>{STR.labelsWhichColumnIsTheName}</strong>
              <p>{STR.labelsNothingCanBeRead}</p>
            </div>
          </div>
        ) : null}
      </section>

      {plan ? <Preview plan={plan} onApply={() => onApply(plan)} /> : null}
    </>
  )
}

function Preview({ plan, onApply }: { plan: ImportPlan; onApply: () => void }) {
  const problems = plan.rows.filter(
    (r) => r.verdict.kind === 'ambiguous' || r.verdict.kind === 'rejected',
  )

  return (
    <section className="section">
      <SectionHead icon="eye" title={STR.labelsWhatThisWouldDo} sub={STR.labelsNothingIsSavedYet} />

      <div className="stat-strip">
        <div className="stat">
          <span className="stat-n code">{plan.newProducts}</span>
          <span className="stat-label">{STR.labelsStatNewProducts}</span>
        </div>
        <div className="stat">
          <span className="stat-n code">{plan.existingProducts}</span>
          <span className="stat-label">{STR.labelsStatAlreadyKnown}</span>
        </div>
        <div className={`stat${plan.ambiguous > 0 ? ' is-warn' : ''}`}>
          <span className="stat-n code">{plan.ambiguous}</span>
          <span className="stat-label">{STR.labelsStatNeedALook}</span>
        </div>
        <div className={`stat${plan.rejected > 0 ? ' is-bad' : ''}`}>
          <span className="stat-n code">{plan.rejected}</span>
          <span className="stat-label">{STR.labelsStatUnusable}</span>
        </div>
      </div>

      {problems.length > 0 ? (
        <ul className="line-list import-problems">
          {problems.map((r, i) => (
            <li key={i} className="line">
              <span className="line-name">{r.row.name || STR.labelsLineN(r.row.line)}</span>
              <span className="line-note">
                {/* Named, not merged. C300 and C500 are one character apart and
                    the importer will not choose between them. */}
                {r.verdict.kind === 'rejected' ? r.verdict.reason : null}
                {r.verdict.kind === 'ambiguous'
                  ? STR.labelsCloseTo(r.verdict.candidates.map((c) => c.name).join(' or '))
                  : null}
              </span>
              <span className="line-code code">{STR.labelsLineNCode(r.row.line)}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="session-actions">
        <button className="btn btn-primary btn-block btn-lg" onClick={onApply}>
          <Icon name="check" size={20} /> {STR.labelsAddNItems(plan.unitsToCreate)}
        </button>
        <p className="session-foot muted">{STR.labelsRowsMarkedNeedALook}</p>
      </div>
    </section>
  )
}
