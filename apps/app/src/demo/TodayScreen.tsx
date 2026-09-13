import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@papa/icons'
import { dueStatus } from '@papa/core'
import { Shell, SettingsButton } from '../components/Shell.tsx'
import { SyncStrip } from '../components/SyncStrip.tsx'
import { Today } from '../routes/Today.tsx'
import { go } from '../nav.ts'
import { NewJobSheet } from './NewJobSheet.tsx'
import { KhataChargeSheet } from './SessionScreen.tsx'
// --- network --- (0025 D7): the crew picker.
import { CrewPickerSheet } from './CrewChips.tsx'
import { shareText } from '../share.ts'
import { useSyncTick } from '../sync-tick.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'
import { Sheet, SheetClose } from '../components/Sheet.tsx'

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
  const [lateFeeFor, setLateFeeFor] = useState<string | null>(null)
  const [crewFor, setCrewFor] = useState<string | null>(null) // --- network ---

  // A sync cycle that landed rows re-reads the board (W9).
  useSyncTick()
  const counts = store.outboxCounts()
  const now = Date.now()
  const sync = store.syncView()

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
        <>
          <button
            className="icon-btn"
            onClick={() => go({ name: 'gear' })}
            aria-label={STR.todaySearchGearAria}
          >
            <Icon name="search" size={22} />
          </button>
          <SettingsButton />
        </>
      }
    >
      <SyncStrip
        // "Offline" in the demo: there is no server, so pretending to be
        // connected would hide the one thing the strip exists for. On an
        // enrolled phone (W9) the loop's own view answers.
        online={sync?.online ?? false}
        pending={counts.pending}
        oldestAgeMs={counts.oldestAgeMs}
        failures={counts.failures}
        onOpenFailures={() => go({ name: 'phone' })}
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
          customer: j.customer,
          stillOut: store.stillOut(j.id),
          // --- network --- (0025)
          crew: store.crewFor(j.id),
          subHire: store.subHireForJob(j.id) !== null,
        }))}
        outJobs={store.outJobsDue(now)}
        stats={store.stats()}
        money={store.moneyStrip(now)}
        promised={store.promisedStrip(now)}
        onOpenGear={(f) => go({ name: 'gear', query: f === 'all' ? undefined : f })}
        onNewJob={() => setNewJobOpen(true)}
        onEditDate={(jobId) => setDateFor(jobId)}
        onCloseJob={(jobId) => {
          // The store refuses while gear is out (the same rule that
          // disabled the button); a refused close changes nothing to render.
          store.closeJob(jobId)
          refresh()
        }}
        onConvertBooking={(bookingId) => {
          // The bridge (0022 D8): the promise becomes the job on this board.
          store.convertBookingToJob(bookingId, now)
          refresh()
        }}
        onLateFee={(jobId) => setLateFeeFor(jobId)}
        onEscalate={(jobId) => {
          // The ladder's last rung: the flag is written once, and the text
          // goes to the owner the way every share in the app does —
          // WhatsApp where it exists, clipboard where it does not.
          const text = store.escalateToManager(jobId, now)
          refresh()
          if (!text) return
          shareText(text)
        }}
        // --- network --- (0025 D7): crew on and off the card.
        onAddCrew={(jobId) => setCrewFor(jobId)}
        onRemoveCrew={(jobId, userId) => { store.unassignAttendant(jobId, userId); refresh() }}
      />

      {crewFor ? (
        <CrewPickerSheet
          staff={store.staff()}
          crew={store.crewFor(crewFor)}
          onPick={(userId, role) => {
            store.assignAttendant(crewFor, userId, role)
            setCrewFor(null)
            refresh()
          }}
          onClose={() => setCrewFor(null)}
        />
      ) : null}

      {lateFeeFor ? (
        <LateFeeFromBoard
          store={store}
          jobId={lateFeeFor}
          onDone={() => { setLateFeeFor(null); refresh() }}
        />
      ) : null}

      {newJobOpen ? (
        <NewJobSheet
          customers={store.customers()}
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
    <Sheet label={STR.todayExpectedBack} onClose={onClose}>
      <header className="sheet-head">
        <span className="sheet-title">{STR.todayExpectedBack}</span>
        <SheetClose />
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
    </Sheet>
  )
}

/**
 * The ladder's day-7 rung, from the board: the same late-fee sheet the
 * handover uses, prefilled from the same draft. A job with no customer
 * has no khata to charge, so the door lands on the handover instead,
 * where the reason is written out.
 */
function LateFeeFromBoard({
  store,
  jobId,
  onDone,
}: {
  store: DemoStore
  jobId: string
  onDone: () => void
}) {
  const customer = store.customerForJob(jobId)
  const lateFee = store.lateFeeDraftFor(jobId)
  const canDraft = customer !== null && lateFee !== null
  useEffect(() => {
    if (!canDraft) go({ name: 'session', sessionId: jobId })
  }, [canDraft, jobId])
  if (!customer || !lateFee) return null
  return (
    <KhataChargeSheet
      title={STR.sessionLateFee}
      hint={STR.sessionChargeGoesTo(customer.name)}
      sub={STR.sessionLateFeeNeverAuto}
      initialAmount={
        lateFee.draft.priced > 0 ? String(Math.round(lateFee.draft.totalMinor / 100)) : ''
      }
      initialNote={lateFee.dueLabel}
      onSave={(amountMinor, note) => {
        if (store.recordLateFee(jobId, amountMinor, note)) onDone()
      }}
      onClose={onDone}
    />
  )
}
