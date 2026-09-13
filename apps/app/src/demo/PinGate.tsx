import { useState } from 'react'
import { Icon } from '@papa/icons'
import type { DemoStore, MemberRow } from './store.ts'
import type { PinSwitchResult } from '@papa/core'
import { STR } from '../strings.ts'

/**
 * What the screen says about a PIN switch's answer: null for a clean
 * server-verified unlock, the offline notice for an echo, the reason
 * otherwise. The gate and Settings → This phone say the same words.
 */
export function pinSwitchSaid(r: PinSwitchResult, name: string): string | null {
  if (r.ok) return r.verifiedBy === 'echo' ? STR.pipeGateCheckedOffline : null
  switch (r.reason) {
    case 'wrong_pin': return STR.pipeGateWrongPin
    case 'locked_out': return STR.pipeGateLockedOut
    case 'offline_unknown': return STR.pipeGateOfflineUnknown(name)
    case 'refused': return r.message
  }
}

/**
 * The PIN gate (W9) — the shared-phone model, on open.
 *
 * The device is the unit of custody, the PIN decides the person. It shows
 * when a session exists and whoever last held the phone has a PIN; it asks
 * for a name and a PIN and calls switch_session_user — the server's 5/min
 * lockout is the real gate. Offline, the phone checks the echo it kept
 * from the last server-verified PIN (docs/assumptions.md#pin-echo) and says
 * so out loud; a person whose PIN was never verified on this phone cannot
 * pick it up offline. A member with no PIN opens the phone with a tap:
 * there is nothing to check.
 *
 * Glove targets: every name is a full-width row; the PIN field is the
 * numeric keypad.
 */
/** How long the "checked offline" notice stays on the gate before it opens. */
export const OFFLINE_NOTICE_MS = 1_200

export function PinGate({ store, onUnlocked }: { store: DemoStore; onUnlocked: () => void }) {
  const members = store.members().filter((m) => m.role !== 'driver')
  const [picked, setPicked] = useState<MemberRow | null>(
    members.find((m) => m.current) ?? members[0] ?? null,
  )
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const unlock = async () => {
    if (!picked || busy) return
    if (!picked.hasPin) { onUnlocked(); return }
    setBusy(true)
    setSaid(null)
    const r = await store.pinSwitch(picked.id, pin)
    setBusy(false)
    setSaid(pinSwitchSaid(r, picked.name))
    if (r.ok) {
      // An echo-verified unlock holds the gate long enough to READ that the
      // PIN was checked offline — unmounting at once hid the notice the
      // moment it was set. A server-verified unlock opens at once.
      if (r.verifiedBy === 'echo') setTimeout(onUnlocked, OFFLINE_NOTICE_MS)
      else onUnlocked()
      return
    }
    setPin('')
  }

  return (
    <div className="pin-gate" role="dialog" aria-modal="true" aria-label={STR.pipeGateTitle}>
      <div className="pin-gate-card">
        <h1 className="pin-gate-title">{STR.pipeGateTitle}</h1>
        <p className="tags-hint">{STR.pipeGateHint}</p>

        <ul className="line-list pin-gate-people">
          {members.map((m) => (
            <li key={m.id}>
              <button
                className={`line line-tap pressable${picked?.id === m.id ? ' is-picked' : ''}`}
                aria-pressed={picked?.id === m.id}
                onClick={() => { setPicked(m); setSaid(null) }}
              >
                <span className="line-name">{m.name}</span>
                <span className="line-note">{m.role}{m.hasPin ? '' : ` · ${STR.pipeGateNoPin}`}</span>
                <span className="line-code"><Icon name="user" size={16} /></span>
              </button>
            </li>
          ))}
        </ul>

        <form onSubmit={(e) => { e.preventDefault(); void unlock() }}>
          {picked?.hasPin ? (
            <input
              className="sheet-search code pin-gate-input"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
              placeholder={STR.pipePinPlaceholder}
              inputMode="numeric" type="password" maxLength={6} autoComplete="off"
              aria-label={STR.pipePinPlaceholder}
            />
          ) : null}
          {said ? (
            <div className="notice notice-warn" role="alert">
              <Icon name="warning" size={18} />
              <div><strong>{said}</strong></div>
            </div>
          ) : null}
          <button
            className="btn btn-primary btn-block btn-lg sheet-submit"
            type="submit"
            disabled={!picked || busy || (picked.hasPin && pin.length < 4)}
          >
            {busy ? STR.pipeGateChecking : STR.pipeGateUnlock}
          </button>
        </form>
      </div>
    </div>
  )
}
