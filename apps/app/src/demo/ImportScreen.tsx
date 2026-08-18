import { useCallback, useState } from 'react'
import { Icon } from '@papa/icons'
import type { ImportPlan } from '@papa/core'
import { Import } from '../routes/Import.tsx'
import { go } from '../nav.ts'
import type { DemoStore } from './store.ts'

/**
 * The import, wired to the demo database.
 *
 * The result is reported in the two numbers that mean something to an owner —
 * how many kinds of thing, and how many actual units — and then points at the
 * gear list, because "did it work" is answered by seeing your own gear, not by
 * a tick.
 */
export function ImportScreen({ store }: { store: DemoStore }) {
  const [done, setDone] = useState<{ products: number; units: number } | null>(null)

  const onApply = useCallback(
    (plan: ImportPlan) => setDone(store.applyImport(plan)),
    [store],
  )

  if (done) {
    return (
      <div className="empty">
        <Icon name="check-circle" size={40} />
        <p>
          Added {done.units} item{done.units === 1 ? '' : 's'} across {done.products} new
          product{done.products === 1 ? '' : 's'}.
        </p>
        <p className="muted">
          Your names are now what the kit-list reader matches a client’s message against.
        </p>
        <div className="session-actions">
          <button className="btn btn-primary btn-block" onClick={() => go({ name: 'gear' })}>
            See the gear
          </button>
          <button className="btn btn-ghost btn-block" onClick={() => setDone(null)}>
            Load another list
          </button>
        </div>
      </div>
    )
  }

  return <Import catalogue={store.catalogue} onApply={onApply} />
}
