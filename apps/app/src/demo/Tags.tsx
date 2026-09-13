import { useEffect, useRef, useState, type ChangeEvent } from 'react'
import QRCode from 'qrcode'
import { Icon } from '@papa/icons'
import { SectionHead } from '../components/Shell.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'
import { getLang, setLang, type Lang } from '../lang.ts'

/**
 * The labels, on screen, so there is something to actually scan.
 *
 * The real product prints these onto adhesive labels and they live on the
 * gear. Until then this page is the substitute: display it on a second screen
 * (or print it) and scan from there. The codes are generated from a fixed seed
 * (seed.ts), so a page printed today still scans tomorrow.
 *
 * GENERATION IS PARALLEL AND THE BUTTON NEVER BLOCKS. The first version drew
 * ~80 data-URLs one after another and disabled Print until the last one
 * landed — several seconds of a dead button on a phone. Now every label
 * renders concurrently and appears as it arrives, and Print is pressable
 * immediately: if labels are still drawing when it is pressed, the click
 * WAITS for the batch and then prints, rather than printing a page of empty
 * squares — a label sheet with blank cells is worse than a moment's wait,
 * because the blanks get stuck on gear anyway.
 */
export function Tags({ store }: { store: DemoStore }) {
  const [images, setImages] = useState<Map<string, string>>(new Map())
  const [waiting, setWaiting] = useState(false)
  const buildRef = useRef<Promise<unknown>>(Promise.resolve())
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    buildRef.current = Promise.all(
      store.seed.tags.map(async (tag) => {
        // Small and high-contrast: these are read off a screen at ~20cm, and
        // a large sparse code is harder for the decoder than a dense one.
        const url = await QRCode.toDataURL(tag.tagCode, {
          margin: 1,
          width: 160,
          color: { dark: '#000000', light: '#ffffff' },
        })
        if (!mountedRef.current) return
        // Each label appears the moment it exists instead of the whole page
        // popping in at the end — the perceived speed IS the speed here.
        setImages((prev) => {
          const next = new Map(prev)
          next.set(tag.tagCode, url)
          return next
        })
      }),
    )
    return () => { mountedRef.current = false }
  }, [store])

  const onPrint = () => {
    setWaiting(true)
    void buildRef.current.then(() => {
      if (!mountedRef.current) return
      setWaiting(false)
      window.print()
    })
  }

  const byShelf = new Map<string, typeof store.seed.tags>()
  for (const t of store.seed.tags) {
    const list = byShelf.get(t.shelf) ?? []
    list.push(t)
    byShelf.set(t.shelf, list)
  }

  return (
    <div className="tags-screen">
      <div className="tags-bar">
        <button className="btn btn-primary" disabled={waiting} onClick={onPrint}>
          <Icon name="scroll" size={18} /> {waiting ? STR.labelsDrawingLabels : STR.labelsPrintTheLabels}
        </button>
        <p className="tags-hint">
          {STR.labelsPrintTheseHint} <strong>{STR.labelsAttachThisLabel}</strong>{' '}
          {STR.labelsToSayWhatItIsOn}
        </p>
      </div>
      {[...byShelf.entries()].map(([shelf, items]) => (
        <section key={shelf} className="tag-shelf">
          <h2 className="tag-shelf-name">{shelf}</h2>
          <ul className="tag-grid">
            {items.map((t) => (
              <li key={t.tagCode} className="tag-card">
                {images.has(t.tagCode) ? (
                  <img className="tag-qr" src={images.get(t.tagCode)} alt="" width={160} height={160} />
                ) : (
                  <div className="tag-qr tag-qr-empty" />
                )}
                <span className="tag-name">{t.displayName}</span>
                <span className="tag-code code">{t.assetCode}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/**
 * The backed-up chip — the khata apps sell backup as a headline, and the
 * reassurance is worth a line on the settings surface. But this is the DEMO:
 * nothing actually leaves the device, and the wording says exactly that
 * rather than wearing a green tick it has not earned. On a real install the
 * same line reports the real outbox — the number is already the real queue.
 */
export function BackedUpRow({ store }: { store: DemoStore }) {
  const counts = store.outboxCounts()
  // The same header rhythm as every other group on the page — icon,
  // title, subtitle, rule — with the queue count riding as the action
  // slot; the section has no body because the count IS the fact.
  return (
    <section className="section">
      <SectionHead
        icon="cloud-queue"
        title={STR.labelsBackedUpHeading}
        sub={STR.labelsQueueStatus(counts.pending)}
        action={
          <span className="badge">
            <Icon name="clipboard-check" size={12} /> {counts.pending}
          </span>
        }
      />
    </section>
  )
}

/**
 * Getting paid — the JazzCash/Easypaisa line and the payment QR the money
 * documents carry. The line is appended under every balance card and
 * statement ONCE SET (ledger.ts leaves it off a card that owes nothing);
 * the QR is stored on this device only, as the hint says out loud.
 */
export function PaymentRow({ store }: { store: DemoStore }) {
  const [line, setLine] = useState(store.paymentLine() ?? '')
  const [saved, setSaved] = useState(false)
  const [qr, setQr] = useState(store.paymentQr())
  const fileRef = useRef<HTMLInputElement>(null)
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const onSave = () => {
    store.setPaymentLine(line.trim() || null)
    setSaved(true)
    if (savedTimer.current) clearTimeout(savedTimer.current)
    savedTimer.current = setTimeout(() => setSaved(false), 1500)
  }

  const onAttach = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : null
      if (!url) return
      store.setPaymentQr(url)
      setQr(url)
    }
    reader.readAsDataURL(file)
    // The same file chosen twice must fire change twice.
    e.target.value = ''
  }

  return (
    <section className="section">
      <SectionHead icon="coins" title={STR.labelsPaymentHeading} sub={STR.labelsPaymentSub} />

      <label className="field-label" htmlFor="payment-line">
        {STR.labelsPaymentLineLabel}
      </label>
      <input
        id="payment-line"
        className="sheet-search"
        value={line}
        onChange={(e) => setLine(e.target.value)}
        placeholder={STR.labelsPaymentLinePlaceholder}
        autoCorrect="off"
        spellCheck={false}
      />
      <p className="tags-hint">{STR.labelsPaymentLineHint}</p>
      <button className="btn btn-outline" onClick={onSave}>
        {saved ? STR.labelsSaved : STR.labelsSave}
      </button>

      <label className="field-label">{STR.labelsPaymentQrLabel}</label>
      {qr ? (
        <div className="tags-bar">
          <img
            className="tag-qr"
            src={qr}
            alt={STR.labelsPaymentQrLabel}
            width={160}
            height={160}
          />
          <button
            className="btn btn-ghost"
            onClick={() => {
              store.setPaymentQr(null)
              setQr(null)
            }}
          >
            {STR.labelsRemoveQr}
          </button>
        </div>
      ) : (
        <div className="tags-bar">
          <button className="btn btn-outline" onClick={() => fileRef.current?.click()}>
            <Icon name="camera" size={18} /> {STR.labelsAttachQr}
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onAttach}
          />
        </div>
      )}
      <p className="tags-hint">{STR.labelsQrStored}</p>
    </section>
  )
}

/**
 * The language switch — English / Roman Urdu (docs/PLAN.md's Urdu decision;
 * assumptions #8–#9). Rendered by the Settings screen above the label grid
 * so it is findable without scrolling eighty QR codes.
 *
 * Both option names render in their own language deliberately: whichever
 * table is active, the way back is readable. Choosing persists ('papa-lang')
 * and reloads — see lang.ts for why a reload beats threading state through
 * every screen. The chips are the family's pill toggles (.filter-chip), which
 * already carry the glove-sized hit targets.
 */
export function LanguageRow() {
  const lang = getLang()
  const choose = (next: Lang) => {
    if (next !== lang) setLang(next)
  }
  const options: { value: Lang; label: string }[] = [
    { value: 'en', label: STR.commonLanguageEnglish },
    { value: 'ur', label: STR.commonLanguageRomanUrdu },
  ]
  return (
    <section className="section">
      <SectionHead icon="chat" title={STR.commonLanguage} sub={STR.commonLanguageSub} />
      <div className="chip-row" role="group" aria-label={STR.commonLanguage}>
        {options.map((o) => (
          <button
            key={o.value}
            className={`filter-chip${lang === o.value ? ' active' : ''}`}
            aria-pressed={lang === o.value}
            onClick={() => choose(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </section>
  )
}
