import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import { Icon } from '@papa/icons'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

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
        <p className="tags-hint">
          {STR.labelsPrintTheseHint} <strong>{STR.labelsAttachThisLabel}</strong>{' '}
          {STR.labelsToSayWhatItIsOn}
        </p>
        <button className="btn btn-primary" disabled={waiting} onClick={onPrint}>
          <Icon name="scroll" size={18} /> {waiting ? STR.labelsDrawingLabels : STR.labelsPrintTheLabels}
        </button>
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
