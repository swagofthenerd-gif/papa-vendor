import { useCallback, useState } from 'react'
import { Icon } from '@papa/icons'
import { dueStatus } from '@papa/core'
import { Shell } from '../components/Shell.tsx'
import { SyncStrip } from '../components/SyncStrip.tsx'
import { Today } from '../routes/Today.tsx'
import { go } from '../nav.ts'
import { NewJobSheet } from './NewJobSheet.tsx'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * The Today board, wired to the demo store.
 *
 * Owns the two bits of desk state the pure Today component must not: the
 * walk-in "new job" sheet and the due-date editor. Both mutate the store and
 * then bump `tick`, because the store is a database, not a React state tree —
 * re-reading it is the render model everywhere else in the demo.
 */
export function TodayScreen({ store }: { store: DemoStore }) {
  const [, setTick] = useState(0)
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  const [newJobOpen, setNewJobOpen] = useState(false)
  const [dateFor, setDateFor] = useState<string | null>(null)

  const counts = store.outboxCounts()
  const now = Date.now()

  return (
    <Shell
      view={{ name: 'jobs' }}
      title={STR.commonTabToday}
      subtitle={
        <>
          <Icon name="user" size={13} /> {store.seed.userName}
        </>
      }
      action={
        <button
          className="icon-btn"
          onClick={() => go({ name: 'gear' })}
          aria-label={STR.todaySearchGearAria}
        >
          <Icon name="search" size={22} />
        </button>
      }
    >
      <SyncStrip
        // Always "offline": there is no server in the demo, so pretending
        // to be connected would hide the one thing the strip exists for.
        online={false}
        pending={counts.pending}
        oldestAgeMs={counts.oldestAgeMs}
        failures={counts.failures}
        onOpenFailures={() => {}}
      />
      <Today
        jobs={store.jobs().map((j) => ({
          id: j.id,
          label: j.label,
          contact: j.contact,
          expectedBack: j.expectedBack,
          due: dueStatus(j.expectedBack, now),
          expected: j.expected.length,
          scanned: store.scannedCount(j.id),
          departsAt: j.departsAt,
          hasSummary: store.hasSummary(j.id),
        }))}
        outJobs={store.outJobsDue(now)}
        stats={store.stats()}
        onOpenGear={(f) => go({ name: 'gear', query: f === 'all' ? undefined : f })}
        onNewJob={() => setNewJobOpen(true)}
        onEditDate={(jobId) => setDateFor(jobId)}
      />

      {newJobOpen ? (
        <NewJobSheet
          onCreate={(input) => {
            // A walk-in has no kit-list lines; its gear is scanned onto it
            // at the dock, which is how a walk-in actually arrives.
            store.createJobFromLines([], input)
            setNewJobOpen(false)
            refresh()
          }}
          onClose={() => setNewJobOpen(false)}
        />
      ) : null}

      {dateFor ? (
        <DueDateSheet
          current={store.job(dateFor)?.expectedBack ?? null}
          onSave={(value) => {
            store.setDueDate(dateFor, value)
            setDateFor(null)
            refresh()
          }}
          onClose={() => setDateFor(null)}
        />
      ) : null}
    </Shell>
  )
}

/**
 * Set or clear one job's due date.
 *
 * A date field and two verbs. "Clear" removes information, so it sits on the
 * far side of the sheet from Save behind the danger gap (semantic.css:
 * adjacency, not size, is what prevents glove mis-taps) — and clearing is
 * honest, not destructive of evidence: the board then says 'no date', which
 * is the truth the field now holds.
 */
function DueDateSheet({
  current,
  onSave,
  onClose,
}: {
  current: string | null
  onSave: (value: string | null) => void
  onClose: () => void
}) {
  // Free text ("after eid") does not survive into the date input — it shows
  // empty rather than pretending to be a date. Saving then overwrites the
  // note with a real date, which is the desk's decision to make.
  const [value, setValue] = useState(/^\d{4}-\d{2}-\d{2}$/.test(current ?? '') ? current! : '')

  return (
    <div className="sheet-backdrop" role="dialog" aria-label={STR.todayExpectedBack}>
      <div className="sheet">
        <header className="sheet-head">
          <span className="sheet-title">{STR.todayExpectedBack}</span>
          <button className="icon-btn" onClick={onClose} aria-label={STR.commonClose}>
            <Icon name="x" size={22} />
          </button>
        </header>

        {current && !/^\d{4}-\d{2}-\d{2}/.test(current) ? (
          <p className="sheet-hint">{STR.todayCurrentlyANote(current)}</p>
        ) : null}

        <input
          className="sheet-search"
          type="date"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={STR.todayExpectedBackDateAria}
        />

        <div className="sheet-foot-split">
          <button
            className="btn btn-ghost"
            onClick={() => onSave(null)}
            disabled={current === null}
          >
            {STR.todayClearDate}
          </button>
          <button
            className="btn btn-primary"
            onClick={() => onSave(value || null)}
            disabled={value.length === 0}
          >
            {STR.todaySave}
          </button>
        </div>
      </div>
    </div>
  )
}
