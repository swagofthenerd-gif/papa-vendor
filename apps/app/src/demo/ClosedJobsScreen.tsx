import { useCallback, useState } from 'react'
import { Icon } from '@papa/icons'
import { ledgerDate } from '@papa/core'
import { Shell, SectionHead } from '../components/Shell.tsx'
import { CustomerChip } from '../routes/Today.tsx'
import { go, type View } from '../nav.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * Closed jobs — the smallest honest door to what ended.
 *
 * The year simulation's December wall: with no way to close a job, the
 * Today board scrolled through every job since September right when twelve
 * live ones needed to be visible. Closing fixes the boards; THIS page is
 * the other half of the promise — off the board is not gone. A finished
 * job's handover stays reviewable, its khata one tap away, and a mis-tap
 * on Close is undone by Reopen rather than by anyone's memory.
 *
 * A row that still counts items out (`neverCameBack`) can only come from a
 * seed or a sync — closeJob refuses while gear projects onto the job — and
 * it is SAID, not hidden: a closed job with a ghost is exactly the row an
 * owner needs to see once the terminal-state feature exists.
 */
export function ClosedJobsScreen({ store }: { store: DemoStore }) {
  const view: View = { name: 'closed' }
  const [, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const rows = store.closedJobs()

  return (
    <Shell
      view={view}
      title={STR.closedJobsTitle}
      subtitle={STR.closedJobsSubtitle(rows.length)}
      action={
        <button
          className="icon-btn"
          onClick={() => go({ name: 'gear' })}
          aria-label={STR.gearTitle}
        >
          <Icon name="chevron-left" size={22} />
        </button>
      }
    >
      {rows.length === 0 ? (
        <div className="empty">
          <Icon name="clipboard-check" size={36} />
          <p>{STR.closedJobsEmpty}</p>
          <p className="muted">{STR.closedJobsEmptyHint}</p>
        </div>
      ) : (
        <section className="section">
          <SectionHead icon="clipboard-check" title={STR.closedJobsTitle} />
          <ul className="job-list">
            {rows.map((j, i) => (
              <li key={j.id} className="stagger" style={{ ['--i' as string]: i }}>
                <div className="job-block">
                  <div className="job-card">
                    <span className="job-main">
                      <span className="job-label">{j.label}</span>
                      <span className="job-tags">
                        {j.closedAt !== null ? (
                          <span className="badge">
                            {STR.closedJobsClosedOn(ledgerDate(j.closedAt))}
                          </span>
                        ) : (
                          <span className="badge">{STR.customerJobClosed}</span>
                        )}
                        {j.neverCameBack > 0 ? (
                          <span className="badge badge-red">
                            {STR.closedJobsNeverCameBack(j.neverCameBack)}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </div>
                  <div className="job-actions">
                    <CustomerChip customer={j.customer} />
                    {store.hasSummary(j.id) ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => go({ name: 'session', sessionId: j.id })}
                      >
                        <Icon name="clipboard-check" size={16} /> {STR.todayLastHandover}
                      </button>
                    ) : null}
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => {
                        store.reopenJob(j.id)
                        refresh()
                      }}
                    >
                      <Icon name="undo" size={16} /> {STR.closedJobsReopen}
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Shell>
  )
}
