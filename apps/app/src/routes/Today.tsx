import { Icon } from '@papa/icons'
import {
  bookingDateLabel,
  formatRupees,
  parsePhoneNumber,
  telUrl,
  whatsAppChatUrl,
  whatsAppShareUrl,
  type DueStatus,
  type EscalationStep,
} from '@papa/core'
import type { BookingRow } from '../demo/bookings.ts'
import { BookingStamp } from '../demo/BookingRows.tsx'
import { go } from '../nav.ts'
import { SectionHead } from '../components/Shell.tsx'
import { STR } from '../strings.ts'

/** One row on the board. A job is three free-text fields and a tally. */
export interface JobRow {
  id: string
  label: string
  contact: string | null
  expectedBack: string | null
  /** Computed locally at render time — 'due today', '2 days late', 'no date'. */
  due: DueStatus
  /** Items expected on this job, when a pull list exists. */
  expected: number
  scanned: number
  /** Departure time, if known — the sort key that matters. */
  departsAt: string | null
  /** A session was ever recorded here, so a handover is reviewable — even
   *  after every item came back and the job left the coming-back list. */
  hasSummary: boolean
  /** The khata this job's money lands in — the chip that opens it. */
  customer: { id: string; name: string } | null
  /** The close rule's number: items still projecting onto this job. Zero
   *  means the Close button is live; anything else is its honest reason. */
  stillOut: number
}

/**
 * The scanner's home screen.
 *
 * THE DAY, IN THE ORDER IT HAPPENS. The store sorts by departure
 * (compareJobsByDeparture), because that is the order the morning actually
 * runs in, and one tap on a job opens the camera already bound to it — cold
 * app to scanning is one tap, which is in the performance budget beside the
 * 100ms decode because it decides whether the app gets used at all.
 *
 * The counters at the top answer the three questions an owner asks before
 * anything else: what is out, what is late, and what needs a person. They are
 * COUNTS OF THINGS THAT NEED DOING, never a score — a dashboard that reports
 * how well you are doing gets read once and then ignored, while a list of four
 * late items gets acted on. Each one is a door: the overdue counter lands on
 * the overdue rows themselves, not on a filter that happens to contain them.
 */

export interface TodayStats {
  outNow: number
  dueBack: number
  overdue: number
  needsAttention: number
  onShelf: number
}

/**
 * The board's money glance — projected entirely from the local ledger
 * (see demo/khata.ts moneyStrip). Minor units in, formatting here, so the
 * strip and the khata pages it opens can never round differently.
 */
export interface MoneyFigures {
  owedMinor: number
  dueTodayMinor: number
  earnedMonthMinor: number
  owingCount: number
}

/** A job with gear physically out, whatever its list said. */
export interface OutRow {
  id: string
  label: string
  out: number
  contact: string | null
  expectedBack: string | null
  due: DueStatus
  /** Prebuilt wa.me nudge link — present only when the job is overdue AND a
   *  confident number was parsed. Null renders nothing, never a dead button. */
  nudgeUrl: string | null
  /** The nudge's text on its own, for the share-to-anyone fallback when no
   *  number parsed — the app's one sharing rule. */
  nudgeText: string
  /** The confident phone number, for the ladder's call rung. */
  phone: string | null
  /** The overdue ladder's rung (ASSUMPTION #escalation-ladder), null when
   *  not overdue — ONE primary action per rung. */
  escalation: EscalationStep | null
  /** When the desk handed this job to the manager, or null. */
  managerFlaggedAt: string | null
  /** A scan session was recorded on this job, so a handover is reviewable. */
  hasSummary: boolean
  /** The khata the return's money will land in, when one is wired. */
  customer: { id: string; name: string } | null
}

/** The anchor the overdue counter jumps to. */
const COMING_BACK_ID = 'coming-back'

export function Today({
  jobs,
  outJobs,
  stats,
  money,
  promised,
  onOpenGear,
  onNewJob,
  onEditDate,
  onCloseJob,
  onConvertBooking,
  onLateFee,
  onEscalate,
}: {
  jobs: JobRow[]
  outJobs: OutRow[]
  stats: TodayStats
  money: MoneyFigures
  /** The Promised section: confirmed bookings starting inside the horizon
   *  and pencils dying today. Empty lists render no section. */
  promised: { startingSoon: BookingRow[]; pencilsToday: BookingRow[] }
  onOpenGear: (filter: 'here' | 'out' | 'attention' | 'all') => void
  onNewJob: () => void
  onEditDate: (jobId: string) => void
  onCloseJob: (jobId: string) => void
  onConvertBooking: (bookingId: string) => void
  /** The ladder's day-7 rung: open the late-fee draft for this job. */
  onLateFee: (jobId: string) => void
  /** The ladder's day-14 rung: flag the job and share the manager text. */
  onEscalate: (jobId: string) => void
}) {
  const totalExpected = jobs.reduce((n, j) => n + j.expected, 0)
  const totalScanned = jobs.reduce((n, j) => n + j.scanned, 0)

  return (
    <>
      <div className="stat-strip">
        <button className="stat pressable" onClick={() => onOpenGear('out')}>
          <span className="stat-n code">{stats.outNow}</span>
          <span className="stat-label">{STR.todayStatOutNow}</span>
        </button>
        <button className="stat pressable" onClick={() => onOpenGear('here')}>
          <span className="stat-n code">{stats.onShelf}</span>
          <span className="stat-label">{STR.todayStatOnTheShelf}</span>
        </button>
        <button
          className={`stat pressable${stats.overdue > 0 ? ' is-bad' : ''}`}
          onClick={() => {
            // The counter opens the rows it counts. With nothing overdue
            // there is nothing to land on, so it falls back to the out list
            // rather than scrolling to a section that may not exist.
            if (stats.overdue > 0) {
              document
                .getElementById(COMING_BACK_ID)
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
            } else {
              onOpenGear('out')
            }
          }}
        >
          <span className="stat-n code">{stats.overdue}</span>
          <span className="stat-label">{STR.todayStatOverdue}</span>
        </button>
        <button
          className={`stat pressable${stats.needsAttention > 0 ? ' is-warn' : ''}`}
          onClick={() => onOpenGear('attention')}
        >
          <span className="stat-n code">{stats.needsAttention}</span>
          <span className="stat-label">{STR.todayStatNeedALook}</span>
        </button>
      </div>

      {/* The money strip — the morning glance's third line, from the local
          ledger only. 'Owed to me' is the one figure that is a DOOR (it
          opens the owed list, which opens the khatas); the other two are
          facts of the day and the month, not filters, so they stay ink. */}
      <div className="stat-strip money-strip" role="group" aria-label={STR.todayMoneyHeading}>
        <button
          className="stat pressable"
          onClick={() => go({ name: 'owed' })}
          aria-label={STR.todayMoneyOwedAria}
        >
          <span className="stat-n code">{formatRupees(money.owedMinor)}</span>
          <span className="stat-label">{STR.todayMoneyOwedToMe}</span>
        </button>
        <div className="stat">
          <span className="stat-n code">{formatRupees(money.dueTodayMinor)}</span>
          <span className="stat-label">{STR.todayMoneyDueInToday}</span>
        </div>
        <div className="stat">
          <span className="stat-n code">{formatRupees(money.earnedMonthMinor)}</span>
          <span className="stat-label">{STR.todayMoneyEarnedThisMonth}</span>
        </div>
      </div>

      <section className="section">
        <SectionHead
          icon="truck"
          title={STR.todayGoingOutToday}
          sub={
            jobs.length === 0
              ? STR.todayNothingScheduled
              : STR.todayJobsPacked(jobs.length, totalScanned, totalExpected)
          }
          action={
            <button className="btn btn-sm btn-outline" onClick={onNewJob}>
              <Icon name="clapperboard" size={16} /> {STR.todayNewJob}
            </button>
          }
        />

        {jobs.length === 0 ? (
          <div className="empty">
            <Icon name="clipboard-check" size={40} />
            <p>{STR.todayNothingScheduledToday}</p>
            <p className="muted">{STR.todayStartAJob}</p>
            <button className="btn btn-outline" onClick={() => go({ name: 'scan', jobId: 'lookup', mode: 'lookup' })}>
              <Icon name="camera" size={18} /> {STR.todayJustScan}
            </button>
          </div>
        ) : (
          <ul className="job-list">
            {jobs.map((job, i) => {
              const progress = job.expected > 0 ? job.scanned / job.expected : 0
              const ready = job.expected > 0 && job.scanned >= job.expected
              const started = job.scanned > 0
              return (
                <li key={job.id} className="stagger" style={{ ['--i' as string]: i }}>
                  <div className={`job-block${job.due.state === 'overdue' ? ' is-overdue' : ''}`}>
                    {/* The whole upper band is the target — not a chevron, not
                        a button inside a row. A gloved thumb gets a full-width
                        band; the secondary actions live BELOW it, outside the
                        button, because links cannot nest inside one. */}
                    <button
                      className="job-card pressable"
                      onClick={() => go({ name: 'scan', jobId: job.id, mode: 'out' })}
                    >
                      <span className="job-main">
                        <span className="job-label">{job.label}</span>
                        <span className="job-tags">
                          {ready ? (
                            <span className="badge badge-green">
                              <Icon name="check" size={12} /> {STR.todayPacked}
                            </span>
                          ) : started ? (
                            <span className="badge badge-orange">{STR.todayInProgress}</span>
                          ) : null}
                          <DueBadge due={job.due} />
                        </span>
                      </span>

                      <span className="job-meta">
                        {job.departsAt ? (
                          <span className="job-time code">{job.departsAt}</span>
                        ) : null}
                        {job.expected > 0 ? (
                          <span className={`job-progress${ready ? ' is-ready' : ''}`}>
                            <span className="code">
                              {job.scanned}/{job.expected}
                            </span>
                            <span
                              className="ring"
                              style={{ ['--p' as string]: progress }}
                              aria-hidden="true"
                            />
                          </span>
                        ) : (
                          <Icon name="camera" size={22} />
                        )}
                      </span>
                    </button>

                    <div className="job-actions">
                      <CustomerChip customer={job.customer} />
                      <ContactLinks contact={job.contact} />
                      <EditDateButton job={job} onEditDate={onEditDate} />
                      {job.hasSummary ? (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => go({ name: 'session', sessionId: job.id })}
                        >
                          <Icon name="clipboard-check" size={16} /> {STR.todayLastHandover}
                        </button>
                      ) : null}
                      <CloseJobButton
                        stillOut={job.stillOut}
                        onClose={() => onCloseJob(job.id)}
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {promised.startingSoon.length + promised.pencilsToday.length > 0 ? (
        <section className="section">
          <SectionHead icon="calendar" title={STR.todayPromisedHeading} sub={STR.todayPromisedSub} />
          <ul className="line-list">
            {promised.startingSoon.map((b) => (
              <li key={b.id} className="line promised-line">
                <button
                  className="line-tap pressable promised-main"
                  onClick={() => go({ name: 'booking', bookingId: b.id })}
                >
                  <span className="line-name">
                    <span className="code booking-no">{STR.bookingRowNo(b.bookingNo)}</span> {b.customerName}
                  </span>
                  <span className="line-note">
                    {STR.todayStartsAt(bookingDateLabel(b.customerStartMs))} · {STR.bookingItems(b.itemCount)}
                  </span>
                </button>
                <span className="promised-side">
                  <BookingStamp row={b} />
                  <button className="btn btn-sm btn-outline" onClick={() => onConvertBooking(b.id)}>
                    <Icon name="truck" size={16} /> {STR.bookingDoorConvert}
                  </button>
                </span>
              </li>
            ))}
            {promised.pencilsToday.map((b) => (
              <li key={b.id} className="line promised-line">
                <button
                  className="line-tap pressable promised-main"
                  onClick={() => go({ name: 'booking', bookingId: b.id })}
                >
                  <span className="line-name">
                    <span className="code booking-no">{STR.bookingRowNo(b.bookingNo)}</span> {b.customerName}
                  </span>
                  <span className="line-note">
                    {STR.todayPencilDies(b.pencil.hours, b.pencil.minutes)} · {STR.bookingItems(b.itemCount)}
                  </span>
                </button>
                <span className="promised-side">
                  <BookingStamp row={b} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {outJobs.length > 0 ? (
        <section className="section" id={COMING_BACK_ID}>
          <SectionHead
            icon="undo"
            title={STR.todayComingBack}
            sub={STR.todayTapOneToBookBack}
          />
          <ul className="job-list">
            {outJobs.map((j, i) => (
              <li key={j.id} className="stagger" style={{ ['--i' as string]: i }}>
                <div className={`job-block${j.due.state === 'overdue' ? ' is-overdue' : ''}`}>
                  <button
                    className="job-card pressable"
                    onClick={() => go({ name: 'scan', jobId: j.id, mode: 'in' })}
                  >
                    <span className="job-main">
                      <span className="job-label">{j.label}</span>
                      <span className="job-contact">
                        {STR.commonItemsStillOut(j.out)}
                      </span>
                      <span className="job-tags">
                        <DueBadge due={j.due} />
                      </span>
                    </span>
                    <span className="job-meta">
                      <Icon name="undo" size={22} />
                    </span>
                  </button>

                  {j.escalation ? (
                    <EscalationRow row={j} onLateFee={onLateFee} onEscalate={onEscalate} />
                  ) : null}
                  <div className="job-actions">
                    <CustomerChip customer={j.customer} />
                    <ContactLinks contact={j.contact} />
                    <EditDateButton job={j} onEditDate={onEditDate} />
                    {j.nudgeUrl && !j.escalation ? (
                      /* Opens the client's thread with the polite Roman-Urdu
                         nudge pre-filled — pre-filled, not pre-sent: the send
                         stays the vendor's. On an overdue job the ladder row
                         above carries the nudge as its day-1 action instead. */
                      <a
                        className="btn btn-sm btn-outline"
                        href={j.nudgeUrl}
                        target="_blank"
                        rel="noopener"
                      >
                        <Icon name="send" size={16} /> {STR.todayNudgeOnWhatsApp}
                      </a>
                    ) : null}
                    {j.hasSummary ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => go({ name: 'session', sessionId: j.id })}
                      >
                        <Icon name="clipboard-check" size={16} /> {STR.todayLastHandover}
                      </button>
                    ) : null}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section">
        <SectionHead icon="bolt" title={STR.todayQuick} />
        <div className="quick-grid">
          <button className="quick pressable" onClick={() => go({ name: 'scan', jobId: 'lookup', mode: 'lookup' })}>
            <Icon name="camera" size={20} />
            <span className="quick-t">{STR.todayJustScan}</span>
            <span className="quick-s">{STR.todayWhereIsThisThing}</span>
          </button>
          <button className="quick pressable" onClick={() => go({ name: 'hisaab' })}>
            <Icon name="clipboard" size={20} />
            <span className="quick-t">{STR.todayDinKaHisaab}</span>
            <span className="quick-s">{STR.todayWhatMovedToday}</span>
          </button>
          <button className="quick pressable" onClick={() => go({ name: 'calendar' })}>
            <Icon name="calendar" size={20} />
            <span className="quick-t">{STR.bookingCalendarTitle}</span>
            <span className="quick-s">{STR.bookingCalendarSubtitle}</span>
          </button>
          <button className="quick pressable" onClick={() => go({ name: 'desk' })}>
            <Icon name="chat" size={20} />
            <span className="quick-t">{STR.todayAnswerAKitList}</span>
            <span className="quick-s">{STR.todayPasteFromWhatsApp}</span>
          </button>
          <button className="quick pressable" onClick={() => onOpenGear('all')}>
            <Icon name="box" size={20} />
            <span className="quick-t">{STR.todayAllTheGear}</span>
            <span className="quick-s">{STR.todaySearchByNameOrCode}</span>
          </button>
        </div>
      </section>
    </>
  )
}

/**
 * The due state as a badge. Overdue is the only red on the card — everything
 * else is information; late is work.
 */
export function DueBadge({ due }: { due: DueStatus }) {
  const cls =
    due.state === 'overdue'
      ? ' badge-red'
      : due.state === 'due_today'
        ? ' badge-orange'
        : ''
  return <span className={`badge${cls}`}>{due.label}</span>
}

/**
 * The customer as a door: one tap from the job card to the khata the job's
 * money lands in. Null renders nothing — the nephew case has no khata, and
 * a chip that opens nowhere is a dead button.
 */
export function CustomerChip({
  customer,
}: {
  customer: { id: string; name: string } | null
}) {
  if (!customer) return null
  return (
    <button
      className="btn btn-sm btn-ghost"
      onClick={() => go({ name: 'customer', customerId: customer.id })}
      aria-label={STR.todayOpenKhataAria(customer.name)}
    >
      <Icon name="user" size={16} /> {customer.name}
    </button>
  )
}

/**
 * End the job — live only when nothing still projects onto it, mirroring
 * the server's close rule (0018 D3). The disabled state carries its honest
 * reason inline ('3 items still out'), because a greyed button with no
 * explanation reads as broken, and 'why won't it close' should never need
 * the desk to phone anyone.
 */
export function CloseJobButton({
  stillOut,
  onClose,
}: {
  stillOut: number
  onClose: () => void
}) {
  const blocked = stillOut > 0
  return (
    <button
      className="btn btn-sm btn-ghost"
      disabled={blocked}
      onClick={onClose}
      title={blocked ? STR.todayStillOutCannotClose(stillOut) : undefined}
    >
      <Icon name="check" size={16} />{' '}
      {blocked
        ? `${STR.todayCloseJob} — ${STR.todayStillOutCannotClose(stillOut)}`
        : STR.todayCloseJob}
    </button>
  )
}

/**
 * The contact as something a thumb can act on. A confident number becomes a
 * dialer link and a WhatsApp link beside the raw text; anything
 * parsePhoneNumber refused stays plain text — a link to a misparsed number
 * dials a stranger in the vendor's name.
 */
function ContactLinks({ contact }: { contact: string | null }) {
  if (!contact) return null
  const phone = parsePhoneNumber(contact)
  if (!phone) return <span className="job-contact">{contact}</span>
  return (
    <>
      <span className="job-contact">{contact}</span>
      <a className="btn btn-sm btn-ghost" href={telUrl(phone)} aria-label={STR.todayCallAria(contact)}>
        <Icon name="phone" size={16} /> {STR.todayCall}
      </a>
      <a
        className="btn btn-sm btn-ghost"
        href={whatsAppChatUrl(phone)}
        target="_blank"
        rel="noopener"
        aria-label={STR.todayWhatsAppAria(contact)}
      >
        <Icon name="chat" size={16} /> {STR.todayWhatsApp}
      </a>
    </>
  )
}

/**
 * Set or change the due date. The DueBadge above already says the state, so
 * this only names the action — repeating the label here is how the two
 * drift into disagreement.
 */
function EditDateButton({
  job,
  onEditDate,
}: {
  job: { id: string; expectedBack: string | null }
  onEditDate: (jobId: string) => void
}) {
  return (
    <button className="btn btn-sm btn-ghost" onClick={() => onEditDate(job.id)}>
      <Icon name="calendar" size={16} />{' '}
      {job.expectedBack ? STR.todayChangeDate : STR.todaySetADate}
    </button>
  )
}

/**
 * The overdue ladder on the card (ASSUMPTION #escalation-ladder): the
 * rung's label and ONE primary action for it — nudge, call, late fee,
 * escalate. Kept to a single line plus a button so the card stays compact;
 * the day-14 rung also says out loud that a blacklist is a decision for the
 * manager's review, never something this button does.
 */
function EscalationRow({
  row,
  onLateFee,
  onEscalate,
}: {
  row: OutRow
  onLateFee: (jobId: string) => void
  onEscalate: (jobId: string) => void
}) {
  const step = row.escalation
  if (!step) return null
  const days = row.due.daysLate ?? 0
  let action: React.ReactNode
  switch (step.action) {
    case 'whatsapp_nudge':
      action = (
        <a
          className="btn btn-sm btn-outline"
          href={row.nudgeUrl ?? whatsAppShareUrl(row.nudgeText)}
          target="_blank"
          rel="noopener"
        >
          <Icon name="send" size={16} /> {STR.bookingActionNudge}
        </a>
      )
      break
    case 'call':
      action = row.phone ? (
        <a className="btn btn-sm btn-outline" href={telUrl(row.phone)}>
          <Icon name="phone" size={16} /> {STR.bookingActionCall}
        </a>
      ) : (
        <a
          className="btn btn-sm btn-outline"
          href={whatsAppShareUrl(row.nudgeText)}
          target="_blank"
          rel="noopener"
        >
          <Icon name="send" size={16} /> {STR.bookingActionNudge}
        </a>
      )
      break
    case 'late_fee_draft':
      action = (
        <button className="btn btn-sm btn-outline" onClick={() => onLateFee(row.id)}>
          <Icon name="receipt" size={16} /> {STR.bookingActionLateFee}
        </button>
      )
      break
    case 'manager_escalation':
      action = row.managerFlaggedAt ? (
        <span className="badge badge-orange">
          <Icon name="flag" size={12} /> {STR.todayEscalated(bookingDateLabel(Date.parse(row.managerFlaggedAt)))}
        </span>
      ) : (
        <button className="btn btn-sm btn-outline" onClick={() => onEscalate(row.id)}>
          <Icon name="flag" size={16} /> {STR.bookingActionManager}
        </button>
      )
      break
  }
  return (
    <div className="escalation-row">
      <span className="escalation-step">
        {STR.todayEscalationStep(step.step, days)}
        {step.considerBlacklist ? (
          <span className="line-note"> · {STR.todayEscalateConsiderBlacklist}</span>
        ) : null}
      </span>
      {action}
    </div>
  )
}
