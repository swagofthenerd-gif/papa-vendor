import { useState } from 'react'
import { Icon } from '@papa/icons'
import { formatRupees, parsePhoneNumber, telUrl, whatsAppChatUrl } from '@papa/core'
import { Shell, SectionHead, SettingsButton } from '../components/Shell.tsx'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import { go, type View } from '../nav.ts'
import { PartnerSheet } from './PartnerSheet.tsx'
import { SubHireInSheet } from './SubHireInSheet.tsx'
import { LendOutSheet } from './LendOutSheet.tsx'
import { SubHireLine } from './SubHireRows.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * One partner house (#/partner/:id): identity with the call and WhatsApp
 * doors, the two writes (record a sub-hire in; lend out), what is open
 * with them in either direction with its closing door, the history, and
 * the money line — both books, each a projection: what we owe them rides
 * the kharcha book (sub_hire expenses in their name), what they owe us is
 * their khata (the partner-customer, D3), with a door to it.
 *
 * Removal is destructive and lives at the very bottom behind a hold,
 * away from every frequent door; the store refuses it while anything is
 * still open, and the refusal is a sentence, not a dead button.
 */
export function PartnerScreen({ store, partnerId }: { store: DemoStore; partnerId: string }) {
  const view: View = { name: 'partner', partnerId }
  const [tick, setTick] = useState(0)
  const [sheet, setSheet] = useState<'edit' | 'in' | 'out' | null>(null)
  const [removeOpen, setRemoveOpen] = useState(false)
  const [said, setSaid] = useState<string | null>(null)
  void tick
  const refresh = () => setTick((t) => t + 1)

  const p = store.partner(partnerId)
  if (!p) {
    return (
      <Shell view={view} title={STR.networkPartnerTitle}>
        <div className="empty">
          <Icon name="question" size={36} />
          <p>{STR.networkPartnerNoSuch}</p>
          <button className="btn btn-ghost" onClick={() => go({ name: 'settings' })}>
            {STR.networkBackToPartners}
          </button>
        </div>
      </Shell>
    )
  }

  const open = store.subHires({ partnerId, open: true })
  const history = store.subHires({ partnerId, open: false })
  const money = store.partnerMoney(partnerId)
  const phone = parsePhoneNumber(p.phone)

  const remove = () => {
    const r = store.removePartner(partnerId)
    if (!r.ok) {
      setSaid(r.reason === 'open_sub_hires' ? STR.networkPartnerRemoveRefused(r.open) : STR.networkPartnerNotFound)
      setRemoveOpen(false)
      return
    }
    go({ name: 'settings' })
  }

  return (
    <Shell
      view={view}
      title={p.name}
      subtitle={`${p.city}${p.phone ? ` · ${p.phone}` : ''}`}
      action={
        <>
          <button className="icon-btn" onClick={() => go({ name: 'settings' })} aria-label={STR.networkBackToPartners}>
            <Icon name="chevron-left" size={22} />
          </button>
          <SettingsButton />
        </>
      }
    >
      <div className="asset-head partner-head">
        <div className="asset-id">
          <span className="stamp stamp-small">{STR.networkPartnerTitle}</span>
        </div>
        <h2 className="asset-name">{p.name}</h2>
        {p.notes ? <p className="asset-status">{p.notes}</p> : null}
        <div className="job-actions">
          {phone ? (
            <>
              <a className="btn btn-sm btn-ghost" href={telUrl(phone)}>
                <Icon name="phone" size={16} /> {STR.networkPartnerCall}
              </a>
              <a className="btn btn-sm btn-ghost" href={whatsAppChatUrl(phone)} target="_blank" rel="noopener">
                <Icon name="chat" size={16} /> {STR.networkPartnerWhatsApp}
              </a>
            </>
          ) : null}
          <button className="btn btn-sm btn-ghost" onClick={() => setSheet('edit')}>
            <Icon name="sliders" size={16} /> {STR.networkEditPartner}
          </button>
        </div>
      </div>

      <div className="session-actions">
        <button className="btn btn-primary btn-block" onClick={() => setSheet('in')}>
          <Icon name="handshake" size={18} /> {STR.networkSubHireInTitle}
        </button>
        <button className="btn btn-outline btn-block" onClick={() => setSheet('out')}>
          <Icon name="truck" size={18} /> {STR.networkLendTitle}
        </button>
      </div>

      {said ? (
        <div className="notice notice-warn" role="status">
          <Icon name="warning" size={18} />
          <div><strong>{said}</strong></div>
        </div>
      ) : null}

      <section className="section">
        <SectionHead icon="repeat" title={STR.networkOpenHeading} sub={STR.networkOpenSub(open.length)} />
        {open.length === 0 ? (
          <p className="section-sub">{STR.networkNothingOpen}</p>
        ) : (
          <ul className="line-list">
            {open.map((r) => (
              <SubHireLine key={r.id} row={r} store={store} onChanged={refresh} showPartner={false} />
            ))}
          </ul>
        )}
      </section>

      <section className="section">
        <SectionHead icon="scroll" title={STR.networkMoneyHeading} />
        <p className="section-sub code">
          {money.weOweCount > 0
            ? STR.networkWeOwe(formatRupees(money.weOweMinor), money.weOweCount)
            : STR.networkWeOweNothing}
        </p>
        <p className="section-sub code">
          {money.theyOweMinor === null
            ? STR.networkTheyOweNoKhata
            : money.theyOweMinor > 0
              ? STR.networkTheyOwe(formatRupees(money.theyOweMinor))
              : STR.networkTheyOweNothing}
        </p>
        {money.customerId ? (
          <button
            className="btn btn-ghost btn-block"
            onClick={() => go({ name: 'customer', customerId: money.customerId! })}
          >
            <Icon name="scroll" size={18} /> {STR.networkPartnerOpenKhata}
          </button>
        ) : null}
      </section>

      <section className="section">
        <SectionHead icon="clock" title={STR.networkHistoryHeading} sub={STR.networkHistorySub(history.length)} />
        {history.length === 0 ? (
          <p className="section-sub">{STR.networkNothingYet}</p>
        ) : (
          <ul className="line-list">
            {history.map((r) => (
              <SubHireLine key={r.id} row={r} store={store} onChanged={refresh} showPartner={false} />
            ))}
          </ul>
        )}
      </section>

      <section className="section fleet-danger">
        {removeOpen ? (
          <div className="fleet-mark">
            <button className="btn btn-danger btn-block" onClick={remove}>
              {STR.networkPartnerRemove}
            </button>
            <button className="btn btn-ghost btn-block" onClick={() => setRemoveOpen(false)}>
              {STR.commonClose}
            </button>
          </div>
        ) : (
          <div className="fleet-disclosure">
            <p className="section-sub">{STR.networkPartnerRemoveHint}</p>
            <HoldToFinish label={STR.networkPartnerRemove} onFinish={() => setRemoveOpen(true)} />
          </div>
        )}
      </section>

      {sheet === 'edit' ? (
        <PartnerSheet
          store={store}
          existing={p}
          onSaved={() => { setSheet(null); refresh() }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'in' ? (
        <SubHireInSheet
          store={store}
          prefill={{ partnerId }}
          onDone={() => { setSheet(null); refresh() }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === 'out' ? (
        <LendOutSheet
          store={store}
          asset={null}
          partnerId={partnerId}
          onDone={() => { setSheet(null); go({ name: 'jobs' }) }}
          onClose={() => setSheet(null)}
        />
      ) : null}
    </Shell>
  )
}
