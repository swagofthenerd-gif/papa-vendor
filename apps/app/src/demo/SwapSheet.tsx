import { Icon } from '@papa/icons'
import { STR } from '../strings.ts'
import type { SubstituteRow } from './read-model.ts'
import { Sheet, SheetClose } from '../components/Sheet.tsx'

/**
 * The crisis-day swap sheet.
 *
 * A camera drops on set; the client needs a replacement now. This picks the
 * substitute — same product first, because that is what the client usually
 * wants, though the desk may send anything on the shelf — and one tap records
 * BOTH movements: the broken item comes off the job and gets flagged, the
 * substitute goes out on the same job. One confirm, no six-state machine
 * (0020 D5).
 *
 * The confirm is the substitute row itself: tapping a unit IS the swap. No
 * separate button to mis-tap, and the broken-item line above states the
 * consequence plainly before any choice is made.
 */
export function SwapSheet({
  title = STR.fleetSwapTitle,
  hint,
  emptyText = STR.fleetSwapNoSubstitutes,
  brokenCode,
  jobLabel,
  substitutes,
  onPick,
  onClose,
}: {
  /** The booking world reuses this picker for the substitute door, with
   *  its own words; the fleet's crisis-day words are the defaults. */
  title?: string
  hint?: string
  emptyText?: string
  brokenCode: string
  jobLabel: string
  substitutes: SubstituteRow[]
  onPick: (substituteId: string) => void
  onClose: () => void
}) {
  const same = substitutes.filter((s) => s.sameProduct)
  const other = substitutes.filter((s) => !s.sameProduct)

  return (
    <Sheet label={title} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{title}</span>
        <SheetClose />
      </header>

      <p className="sheet-hint">{hint ?? STR.fleetSwapBrokenLine(brokenCode, jobLabel)}</p>

      {substitutes.length === 0 ? (
        <div className="empty">
          <Icon name="search" size={32} />
          <p>{emptyText}</p>
        </div>
      ) : (
        <>
          {same.length > 0 ? (
            <>
              <p className="field-label">{STR.fleetSwapSamePreferred}</p>
              <ul className="gear-units">
                {same.map((s) => (
                  <SubRow key={s.id} sub={s} onPick={onPick} />
                ))}
              </ul>
            </>
          ) : null}
          {other.length > 0 ? (
            <>
              <p className="field-label">{STR.fleetSwapOther}</p>
              <ul className="gear-units">
                {other.map((s) => (
                  <SubRow key={s.id} sub={s} onPick={onPick} />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </Sheet>
  )
}

function SubRow({ sub, onPick }: { sub: SubstituteRow; onPick: (id: string) => void }) {
  return (
    <li>
      <button className="gear-unit pressable" onClick={() => onPick(sub.id)}>
        <span className="gear-code code">{sub.code}</span>
        <span className="gear-where">{sub.name}</span>
        <Icon name="repeat" size={16} />
      </button>
    </li>
  )
}
