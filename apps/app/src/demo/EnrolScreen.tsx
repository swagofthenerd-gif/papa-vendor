import { useState } from 'react'
import { Icon } from '@papa/icons'
import { Shell } from '../components/Shell.tsx'
import { go } from '../nav.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * Enrol this phone (W9) — the one SMS, at the desk, on WiFi.
 *
 * The code cannot be requested from here: request_otp is the transport
 * role's alone (0016), and an OTP a client can ask for over the API is a
 * suggestion, not a secret. So the screen says it plainly: ask the owner,
 * type what arrives. Everything else is the complete_enrolment call —
 * phone, code, what to call this phone, an optional first PIN — and the
 * one refusal worth a second field: a number that works at two houses
 * (22023) reveals the house field and asks which.
 *
 * Enrolling from the demo clears the pretend house; the hint says so
 * before the button does it.
 */
export function EnrolScreen({ store, onDone }: { store: DemoStore; onDone: () => void }) {
  const [server, setServer] = useState(store.session()?.serverUrl ?? defaultServer())
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [org, setOrg] = useState('')
  const [askOrg, setAskOrg] = useState(false)
  const [label, setLabel] = useState(store.deviceLabel())
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = async () => {
    if (busy) return
    setBusy(true)
    setSaid(null)
    const r = await store.enrol({
      serverUrl: server.trim(),
      phone: phone.trim(),
      code: code.trim(),
      deviceLabel: label.trim(),
      pin: pin.trim() || null,
      orgSlug: org.trim() || null,
    })
    setBusy(false)
    if (r.ok) {
      setDone(STR.pipeEnrolled(r.session.displayName))
      store.kickSync()
      setTimeout(() => { onDone(); go({ name: 'jobs' }) }, 900)
      return
    }
    switch (r.reason) {
      case 'bad_code': setSaid(STR.pipeEnrolBadCode); break
      case 'ambiguous_org': setAskOrg(true); setSaid(STR.pipeEnrolAmbiguousOrg); break
      case 'bad_pin': setSaid(STR.pipeEnrolBadPin); break
      case 'offline': setSaid(STR.pipeEnrolOffline); break
      case 'refused': setSaid(STR.pipeEnrolRefused(r.message)); break
    }
  }

  const ready = server.trim().length > 0 && phone.trim().length > 6 && code.trim().length >= 4

  return (
    <Shell
      view={{ name: 'enrol' }}
      title={STR.pipeEnrolTitle}
      subtitle={STR.pipeEnrolSubtitle}
      action={
        <button className="icon-btn" onClick={() => history.back()} aria-label={STR.commonClose}>
          <Icon name="x" size={22} />
        </button>
      }
    >
      <div className="tags-bar">
        <p className="tags-hint">{STR.pipeEnrolHint}</p>
      </div>

      <form
        className="enrol-form"
        onSubmit={(e) => { e.preventDefault(); void submit() }}
      >
        <label className="field-label" htmlFor="enrol-server">{STR.pipeServerLabel}</label>
        <input
          id="enrol-server" className="sheet-search code" value={server}
          onChange={(e) => setServer(e.target.value)} placeholder={STR.pipeServerPlaceholder}
          inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false}
        />

        <label className="field-label" htmlFor="enrol-phone">{STR.pipePhoneLabel}</label>
        <input
          id="enrol-phone" className="sheet-search code" value={phone}
          onChange={(e) => setPhone(e.target.value)} placeholder={STR.pipePhonePlaceholder}
          inputMode="tel" autoComplete="tel"
        />

        <label className="field-label" htmlFor="enrol-code">{STR.pipeCodeLabel}</label>
        <input
          id="enrol-code" className="sheet-search code" value={code}
          onChange={(e) => setCode(e.target.value)} placeholder={STR.pipeCodePlaceholder}
          inputMode="numeric" autoComplete="one-time-code" maxLength={6}
        />

        {askOrg ? (
          <>
            <label className="field-label" htmlFor="enrol-org">{STR.pipeOrgLabel}</label>
            <input
              id="enrol-org" className="sheet-search" value={org}
              onChange={(e) => setOrg(e.target.value)} placeholder={STR.pipeOrgPlaceholder}
              autoCapitalize="off" autoCorrect="off" spellCheck={false}
            />
          </>
        ) : null}

        <label className="field-label" htmlFor="enrol-label">{STR.pipeDeviceLabelLabel}</label>
        <input
          id="enrol-label" className="sheet-search" value={label}
          onChange={(e) => setLabel(e.target.value)} placeholder={STR.pipeDeviceLabelPlaceholder}
        />

        <label className="field-label" htmlFor="enrol-pin">{STR.pipePinLabel}</label>
        <input
          id="enrol-pin" className="sheet-search code" value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder={STR.pipePinPlaceholder}
          inputMode="numeric" maxLength={6} type="password" autoComplete="off"
        />

        {store.mode === 'demo' ? <p className="tags-hint">{STR.pipeEnrolClearsDemo}</p> : null}

        {said ? (
          <div className="notice notice-warn" role="alert">
            <Icon name="warning" size={18} />
            <div><strong>{said}</strong></div>
          </div>
        ) : null}
        {done ? (
          <div className="notice" role="status">
            <Icon name="clipboard-check" size={18} />
            <div><strong>{done}</strong></div>
          </div>
        ) : null}

        <button className="btn btn-primary btn-block btn-lg sheet-submit" type="submit" disabled={!ready || busy}>
          <Icon name="signal-off" size={18} /> {busy ? STR.pipeEnrolling : STR.pipeEnrolButton}
        </button>
      </form>
    </Shell>
  )
}

/**
 * The server field's starting value: the page's own origin when the app is
 * served from a web host (the gateway usually sits beside it), and empty
 * when it runs from a file or a packaged build — a real install types its
 * own, and the session remembers it from then on (`server_url`).
 */
export function defaultServer(origin: string = pageOrigin()): string {
  if (!origin || origin === 'null' || /^(file|capacitor|ionic):/.test(origin)) return ''
  return origin
}

function pageOrigin(): string {
  try {
    return typeof location === 'undefined' ? '' : `${location.protocol}//${location.host}`
  } catch {
    return ''
  }
}
