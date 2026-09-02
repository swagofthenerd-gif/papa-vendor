import { Icon } from '@papa/icons'
import {
  parsePhoneNumber,
  telUrl,
  whatsAppChatUrl,
  type DueStatus,
} from '@papa/core'
import { go } from '../nav.ts'
import { SectionHead } from '../components/Shell.tsx'

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
  /** A scan session was recorded on this job, so a handover is reviewable. */
  hasSummary: boolean
}

/** The anchor the overdue counter jumps to. */
const COMING_BACK_ID = 'coming-back'

export function Today({
  jobs,
  outJobs,
  stats,
  onOpenGear,
  onNewJob,
  onEditDate,
}: {
  jobs: JobRow[]
  outJobs: OutRow[]
  stats: TodayStats
  onOpenGear: (filter: 'here' | 'out' | 'attention' | 'all') => void
  onNewJob: () => void
  onEditDate: (jobId: string) => void
}) {
  const totalExpected = jobs.reduce((n, j) => n + j.expected, 0)
  const totalScanned = jobs.reduce((n, j) => n + j.scanned, 0)

  return (
    <>
      <div className="stat-strip">
        <button className="stat pressable" onClick={() => onOpenGear('out')}>
          <span className="stat-n code">{stats.outNow}</span>
          <span className="stat-label">out now</span>
        </button>
        <button className="stat pressable" onClick={() => onOpenGear('here')}>
          <span className="stat-n code">{stats.onShelf}</span>
          <span className="stat-label">on the shelf</span>
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
          <span className="stat-label">overdue</span>
        </button>
        <button
          className={`stat pressable${stats.needsAttention > 0 ? ' is-warn' : ''}`}
          onClick={() => onOpenGear('attention')}
        >
          <span className="stat-n code">{stats.needsAttention}</span>
          <span className="stat-label">need a look</span>
        </button>
      </div>

      <section className="section">
        <SectionHead
          icon="truck"
          title="Going out today"
          sub={
            jobs.length === 0
              ? 'Nothing scheduled'
              : `${jobs.length} job${jobs.length === 1 ? '' : 's'} · ${totalScanned} of ${totalExpected} items packed`
          }
          action={
            <button className="btn btn-sm btn-outline" onClick={onNewJob}>
              <Icon name="clapperboard" size={16} /> New job
            </button>
          }
        />

        {jobs.length === 0 ? (
          <div className="empty">
            <Icon name="clipboard-check" size={40} />
            <p>Nothing scheduled today.</p>
            <p className="muted">
              Start a job to scan gear out, or scan anything to see where it is.
            </p>
            <button className="btn btn-outline" onClick={() => go({ name: 'scan', jobId: 'lookup', mode: 'lookup' })}>
              <Icon name="camera" size={18} /> Just scan
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
                              <Icon name="check" size={12} /> Packed
                            </span>
                          ) : started ? (
                            <span className="badge badge-orange">In progress</span>
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
                      <ContactLinks contact={job.contact} />
                      <EditDateButton job={job} onEditDate={onEditDate} />
                      {job.hasSummary ? (
                        <button
                          className="btn btn-sm btn-ghost"
                          onClick={() => go({ name: 'session', sessionId: job.id })}
                        >
                          <Icon name="clipboard-check" size={16} /> Last handover
                        </button>
                      ) : null}
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {outJobs.length > 0 ? (
        <section className="section" id={COMING_BACK_ID}>
          <SectionHead
            icon="undo"
            title="Coming back"
            sub="Tap one to book its gear back in"
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
                        {j.out} item{j.out === 1 ? '' : 's'} still out
                      </span>
                      <span className="job-tags">
                        <DueBadge due={j.due} />
                      </span>
                    </span>
                    <span className="job-meta">
                      <Icon name="undo" size={22} />
                    </span>
                  </button>

                  <div className="job-actions">
                    <ContactLinks contact={j.contact} />
                    <EditDateButton job={j} onEditDate={onEditDate} />
                    {j.nudgeUrl ? (
                      /* Opens the client's thread with the polite Roman-Urdu
                         nudge pre-filled — pre-filled, not pre-sent: the send
                         stays the vendor's. */
                      <a
                        className="btn btn-sm btn-outline"
                        href={j.nudgeUrl}
                        target="_blank"
                        rel="noopener"
                      >
                        <Icon name="send" size={16} /> Nudge on WhatsApp
                      </a>
                    ) : null}
                    {j.hasSummary ? (
                      <button
                        className="btn btn-sm btn-ghost"
                        onClick={() => go({ name: 'session', sessionId: j.id })}
                      >
                        <Icon name="clipboard-check" size={16} /> Last handover
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
        <SectionHead icon="bolt" title="Quick" />
        <div className="quick-grid">
          <button className="quick pressable" onClick={() => go({ name: 'scan', jobId: 'lookup', mode: 'lookup' })}>
            <Icon name="camera" size={20} />
            <span className="quick-t">Just scan</span>
            <span className="quick-s">Where is this thing?</span>
          </button>
          <button className="quick pressable" onClick={() => go({ name: 'hisaab' })}>
            <Icon name="clipboard" size={20} />
            <span className="quick-t">Din ka hisaab</span>
            <span className="quick-s">What moved today</span>
          </button>
          <button className="quick pressable" onClick={() => go({ name: 'import' })}>
            <Icon name="scroll" size={20} />
            <span className="quick-t">Load your gear</span>
            <span className="quick-s">Paste a list from Excel</span>
          </button>
          <button className="quick pressable" onClick={() => go({ name: 'enquiry' })}>
            <Icon name="chat" size={20} />
            <span className="quick-t">Answer a kit list</span>
            <span className="quick-s">Paste from WhatsApp</span>
          </button>
          <button className="quick pressable" onClick={() => onOpenGear('all')}>
            <Icon name="box" size={20} />
            <span className="quick-t">All the gear</span>
            <span className="quick-s">Search by name or code</span>
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
function DueBadge({ due }: { due: DueStatus }) {
  const cls =
    due.state === 'overdue'
      ? ' badge-red'
      : due.state === 'due_today'
        ? ' badge-orange'
        : ''
  return <span className={`badge${cls}`}>{due.label}</span>
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
      <a className="btn btn-sm btn-ghost" href={telUrl(phone)} aria-label={`Call ${contact}`}>
        <Icon name="phone" size={16} /> Call
      </a>
      <a
        className="btn btn-sm btn-ghost"
        href={whatsAppChatUrl(phone)}
        target="_blank"
        rel="noopener"
        aria-label={`WhatsApp ${contact}`}
      >
        <Icon name="chat" size={16} /> WhatsApp
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
      {job.expectedBack ? 'Change date' : 'Set a date'}
    </button>
  )
}
