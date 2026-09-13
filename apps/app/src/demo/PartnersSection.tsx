import { useRef, useState } from 'react'
import { Icon } from '@papa/icons'
import { SectionHead } from '../components/Shell.tsx'
import { go } from '../nav.ts'
import { PartnerSheet } from './PartnerSheet.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * Settings → Partner houses: the list (each row a door to the partner's
 * page), the add sheet, and under it the two org settings the broadcasts
 * read — the public phone the partner group calls and the public tag
 * page base (ASSUMPTION #public-tag-url: no default, no link until set).
 * Removal is NOT here: it is destructive and lives on the partner's own
 * page behind a hold, away from the list a thumb scrolls.
 */
export function PartnersSection({ store }: { store: DemoStore }) {
  const [tick, setTick] = useState(0)
  const [adding, setAdding] = useState(false)
  void tick
  const list = store.partners()

  return (
    <>
      <section className="section">
        <SectionHead
          icon="handshake"
          title={STR.networkPartnersHeading}
          sub={STR.networkPartnersSub}
          action={
            <button className="btn btn-sm btn-outline" onClick={() => setAdding(true)}>
              <Icon name="handshake" size={16} /> {STR.networkAddPartner}
            </button>
          }
        />
        {list.length === 0 ? (
          <div className="empty">
            <Icon name="handshake" size={32} />
            <p>{STR.networkPartnersNone}</p>
            <button className="btn btn-outline" onClick={() => setAdding(true)}>
              <Icon name="handshake" size={18} /> {STR.networkAddPartner}
            </button>
          </div>
        ) : (
          <ul className="line-list partner-list">
            {list.map((p) => (
              <li key={p.id}>
                <button
                  className="line line-tap pressable"
                  onClick={() => go({ name: 'partner', partnerId: p.id })}
                >
                  <span className="line-name">{p.name}</span>
                  <span className="line-note">
                    {p.city}{p.phone ? ` · ${p.phone}` : ''} · {STR.networkPartnerOpenLine(p.openIn, p.openOut)}
                  </span>
                  <span className="line-code"><Icon name="chevron-right" size={16} /></span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PublicLineRows store={store} />

      {adding ? (
        <PartnerSheet
          store={store}
          existing={null}
          onSaved={() => { setAdding(false); setTick((t) => t + 1) }}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </>
  )
}

/** The two broadcast settings, saved with one button like the payment line. */
function PublicLineRows({ store }: { store: DemoStore }) {
  const [phone, setPhone] = useState(store.publicPhone() ?? '')
  const [base, setBase] = useState(store.publicTagUrlBase() ?? '')
  const [saved, setSaved] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const save = () => {
    store.setPublicPhone(phone.trim() || null)
    store.setPublicTagUrlBase(base.trim() || null)
    setSaved(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSaved(false), 1500)
  }

  return (
    <section className="tag-shelf">
      <h2 className="tag-shelf-name">{STR.networkPublicHeading}</h2>
      <p className="tags-hint">{STR.networkPublicSub}</p>

      <label className="field-label" htmlFor="public-phone">{STR.networkPublicPhoneLabel}</label>
      <input
        id="public-phone"
        className="sheet-search code"
        type="tel"
        inputMode="tel"
        value={phone}
        onChange={(e) => setPhone(e.target.value)}
        placeholder={STR.networkPublicPhonePlaceholder}
      />

      <label className="field-label" htmlFor="public-tag-base">{STR.networkPublicUrlLabel}</label>
      <input
        id="public-tag-base"
        className="sheet-search code"
        type="url"
        inputMode="url"
        value={base}
        onChange={(e) => setBase(e.target.value)}
        placeholder={STR.networkPublicUrlPlaceholder}
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
      />
      {base.trim().length === 0 ? <p className="tags-hint">{STR.networkPublicUrlHint}</p> : null}

      <button className="btn btn-outline" onClick={save}>
        {saved ? STR.labelsSaved : STR.labelsSave}
      </button>
    </section>
  )
}
