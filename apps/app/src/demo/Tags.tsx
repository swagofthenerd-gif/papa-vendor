import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { Icon } from '@papa/icons'
import { go } from '../nav.ts'
import type { DemoStore } from './store.ts'

/**
 * The labels, on screen, so there is something to actually scan.
 *
 * The real product prints these onto adhesive labels and they live on the
 * gear. Until then this page is the substitute: display it on a second screen
 * (or print it) and scan from there. The codes are generated from a fixed seed
 * (seed.ts), so a page printed today still scans tomorrow.
 */
export function Tags({ store }: { store: DemoStore }) {
  const [images, setImages] = useState<Map<string, string>>(new Map())

  useEffect(() => {
    let cancelled = false
    const build = async () => {
      const out = new Map<string, string>()
      for (const tag of store.seed.tags) {
        // Small and high-contrast: these are read off a screen at ~20cm, and
        // a large sparse code is harder for the decoder than a dense one.
        const url = await QRCode.toDataURL(tag.tagCode, {
          margin: 1,
          width: 160,
          color: { dark: '#000000', light: '#ffffff' },
        })
        out.set(tag.tagCode, url)
      }
      if (!cancelled) setImages(out)
    }
    void build()
    return () => { cancelled = true }
  }, [store])

  const byShelf = new Map<string, typeof store.seed.tags>()
  for (const t of store.seed.tags) {
    const list = byShelf.get(t.shelf) ?? []
    list.push(t)
    byShelf.set(t.shelf, list)
  }

  return (
    <div className="screen tags-screen">
      <header className="screen-head">
        <div>
          <h1>Labels</h1>
          <p className="who">{store.seed.tags.length} tags · print or open on another screen</p>
        </div>
        <button className="icon-btn" onClick={() => go({ name: 'jobs' })} aria-label="Back to today">
          <Icon name="x" size={22} />
        </button>
      </header>

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
