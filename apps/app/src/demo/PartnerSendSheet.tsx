import { useRef, useState, type ReactNode } from 'react'
import { Icon } from '@papa/icons'
import { parsePhoneNumber, whatsAppNudgeUrl, whatsAppShareUrl } from '@papa/core'
import type { PartnerRow } from './network.ts'
import { STR } from '../strings.ts'

/**
 * One message, many partner houses — the sheet both broadcasts share
 * (ask the market; the stolen line). The partner list with checkboxes
 * (default all), the message previewed in the typewritten voice, then ONE
 * BUTTON PER TICKED PARTNER: each opens that house's wa.me thread with the
 * text pre-filled and marks the row sent — locally, for this sheet's life,
 * because WhatsApp never tells us whether the send happened. A partner
 * with no parseable number gets the share-to-anyone link instead; the
 * clipboard fallback sits at the foot for a phone with no WhatsApp.
 *
 * The send stays the vendor's. Nothing here writes to the database.
 */
export function PartnerSendSheet({
  title,
  hint,
  partners,
  text,
  above,
  foot,
  onClose,
}: {
  title: string
  hint: string
  partners: PartnerRow[]
  text: string
  /** Rendered above the partner list — the shortage lines, say. */
  above?: ReactNode
  /** Rendered under the copy button — the "They said yes" door, say. */
  foot?: ReactNode
  onClose: () => void
}) {
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(partners.map((p) => p.id)))
  const [sent, setSent] = useState<Set<string>>(() => new Set())
  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toggle = (id: string) =>
    setTicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const send = (p: PartnerRow) => {
    const phone = parsePhoneNumber(p.phone)
    const url = phone ? whatsAppNudgeUrl(phone, text) : whatsAppShareUrl(text)
    const win = window.open(url, '_blank', 'noopener')
    if (!win) void navigator.clipboard?.writeText(text).catch(() => {})
    setSent((prev) => new Set(prev).add(p.id))
  }

  const copy = () => {
    void navigator.clipboard?.writeText(text).catch(() => {})
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={title}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>
        <p className="sheet-hint">{hint}</p>

        {above}

        {partners.length === 0 ? (
          <div className="notice notice-warn">
            <Icon name="warning" size={18} />
            <div><strong>{STR.networkAskMarketNoPartners}</strong></div>
          </div>
        ) : (
          <ul className="send-list">
            {partners.map((p) => {
              const on = ticked.has(p.id)
              const done = sent.has(p.id)
              const phone = parsePhoneNumber(p.phone)
              return (
                <li key={p.id} className={`send-row${done ? ' is-sent' : ''}`}>
                  <label className="send-tick">
                    <input type="checkbox" checked={on} onChange={() => toggle(p.id)} />
                    <span>
                      <strong>{p.name}</strong>
                      <span className="line-note">{phone ?? STR.networkAskMarketNoNumber}</span>
                    </span>
                  </label>
                  {on ? (
                    done ? (
                      <span className="badge badge-green">
                        <Icon name="check" size={12} /> {STR.networkAskMarketSent}
                      </span>
                    ) : (
                      <button className="btn btn-sm btn-outline" onClick={() => send(p)}>
                        <Icon name="send" size={16} /> {STR.networkAskMarketSendTo(p.name)}
                      </button>
                    )
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}

        <p className="field-label">{STR.networkAskMarketPreview}</p>
        <pre className="report-block">{text}</pre>

        <button className="btn btn-ghost btn-block" onClick={copy}>
          <Icon name="clipboard" size={18} /> {copied ? STR.networkAskMarketCopied : STR.networkAskMarketCopy}
        </button>

        {foot}
      </div>
    </div>
  )
}
