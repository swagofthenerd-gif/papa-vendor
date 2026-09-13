import { useState } from 'react'
import { Icon } from '@papa/icons'
import { useHold } from '../components/HoldToFinish.tsx'
import type { CrewMember, StaffRow } from './network.ts'
import { STR } from '../strings.ts'

/**
 * The crew line on a job card (0025 D7): who is going out with the gear,
 * as a chip row, plus the "Add crew" door. Taking someone OFF is a HOLD on
 * their chip, never a tap — a chip sits beside the card's frequent doors
 * and a glove brushing it must not un-crew the driver. The ring is
 * HoldToFinish's own (useHold); lifting early cancels.
 */
export function CrewChips({
  crew,
  onAdd,
  onRemove,
}: {
  crew: CrewMember[]
  onAdd: () => void
  onRemove: (userId: string) => void
}) {
  return (
    <div className="crew-row">
      <span className="crew-label">
        <Icon name="users" size={14} /> {STR.networkCrewWith}
      </span>
      {crew.map((c) => (
        <CrewChip key={c.userId} member={c} onRemove={() => onRemove(c.userId)} />
      ))}
      <button className="btn btn-sm btn-ghost" onClick={onAdd}>
        <Icon name="user" size={16} /> {STR.networkCrewAdd}
      </button>
    </div>
  )
}

function CrewChip({ member, onRemove }: { member: CrewMember; onRemove: () => void }) {
  const { progress, begin, cancel } = useHold(onRemove)

  return (
    <button
      type="button"
      className={`crew-chip${member.role === 'driver' ? ' is-driver' : ''}`}
      onPointerDown={begin}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') begin() }}
      onKeyUp={cancel}
      style={{ ['--hold-progress' as string]: progress }}
      aria-label={STR.networkCrewRemoveAria(member.name)}
    >
      <span className="crew-chip-fill" aria-hidden="true" />
      <Icon name={member.role === 'driver' ? 'truck' : 'user'} size={12} />
      <span className="crew-chip-name">{member.name}</span>
    </button>
  )
}

/**
 * The picker: the roster minus who is already on, one tap per person. The
 * role chips at the top decide what the next tap records — attendant by
 * default, driver when the desk says so.
 */
export function CrewPickerSheet({
  staff,
  crew,
  onPick,
  onClose,
}: {
  staff: StaffRow[]
  crew: CrewMember[]
  onPick: (userId: string, role: 'attendant' | 'driver') => void
  onClose: () => void
}) {
  const [role, setRole] = useState<'attendant' | 'driver'>('attendant')
  const on = new Set(crew.map((c) => c.userId))
  const left = staff.filter((s) => !on.has(s.id))
  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.networkCrewPickTitle}>
      <div className="sheet sheet-tall">
        <header className="sheet-head">
          <span className="sheet-title">{STR.networkCrewPickTitle}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>
        <p className="sheet-hint">{STR.networkCrewPickHint}</p>

        <div className="chip-row" role="group" aria-label={STR.networkCrewPickTitle}>
          {(['attendant', 'driver'] as const).map((r) => (
            <button
              key={r}
              className={`filter-chip${role === r ? ' active' : ''}`}
              aria-pressed={role === r}
              onClick={() => setRole(r)}
            >
              {r === 'driver' ? STR.networkCrewRoleDriver : STR.networkCrewRoleAttendant}
            </button>
          ))}
        </div>

        {left.length === 0 ? (
          <p className="sheet-hint">{STR.networkCrewNobodyLeft}</p>
        ) : (
          <ul className="sheet-list">
            {left.map((s) => (
              <li key={s.id}>
                <button className="sheet-row" onClick={() => onPick(s.id, role)}>
                  <span>{s.name}</span>
                  <span className="sheet-row-code">{s.role}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
