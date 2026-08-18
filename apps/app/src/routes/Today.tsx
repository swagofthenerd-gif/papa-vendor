import { Icon } from '@papa/icons'
import { go } from '../nav.ts'
import { SectionHead } from '../components/Shell.tsx'

/** One row on the board. A job is three free-text fields and a tally. */
export interface JobRow {
  id: string
  label: string
  contact: string | null
  expectedBack: string | null
  /** Items expected on this job, when a pull list exists. */
  expected: number
  scanned: number
  /** Departure time, if known — the sort key that matters. */
  departsAt: string | null
}

/**
 * The scanner's home screen.
 *
 * THE DAY, IN THE ORDER IT HAPPENS. Sorted by departure, because that is the
 * order the morning actually runs in, and one tap on a job opens the camera
 * already bound to it — cold app to scanning is one tap, which is in the
 * performance budget beside the 100ms decode because it decides whether the
 * app gets used at all.
 *
 * The counters at the top answer the three questions an owner asks before
 * anything else: what is out, what is late, and what needs a person. They are
 * COUNTS OF THINGS THAT NEED DOING, never a score — a dashboard that reports
 * how well you are doing gets read once and then ignored, while a list of four
 * late items gets acted on.
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
}

export function Today({
  jobs,
  outJobs,
  stats,
  onOpenGear,
}: {
  jobs: JobRow[]
  outJobs: OutRow[]
  stats: TodayStats
  onOpenGear: (filter: 'out' | 'attention' | 'all') => void
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
        <button className="stat pressable" onClick={() => onOpenGear('all')}>
          <span className="stat-n code">{stats.onShelf}</span>
          <span className="stat-label">on the shelf</span>
        </button>
        <button
          className={`stat pressable${stats.overdue > 0 ? ' is-bad' : ''}`}
          onClick={() => onOpenGear('out')}
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
        />

        {jobs.length === 0 ? (
          <div className="empty">
            <Icon name="clipboard-check" size={40} />
            <p>Nothing scheduled today.</p>
            <p className="muted">
              Start a job to scan gear out, or scan anything to see where it is.
            </p>
            <button className="btn btn-outline" onClick={() => go({ name: 'scan', jobId: 'lookup', mode: 'in' })}>
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
                  {/* The whole row is the target — not a chevron, not a button
                      inside a row. A gloved thumb gets a full-width band. */}
                  <button
                    className="job-card pressable"
                    onClick={() => go({ name: 'scan', jobId: job.id, mode: 'out' })}
                  >
                    <span className="job-main">
                      <span className="job-label">{job.label}</span>
                      {job.contact ? <span className="job-contact">{job.contact}</span> : null}
                      <span className="job-tags">
                        {ready ? (
                          <span className="badge badge-green">
                            <Icon name="check" size={12} /> Packed
                          </span>
                        ) : started ? (
                          <span className="badge badge-orange">In progress</span>
                        ) : null}
                        {job.expectedBack ? (
                          <span className="badge">Back {job.expectedBack}</span>
                        ) : null}
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
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {outJobs.length > 0 ? (
        <section className="section">
          <SectionHead
            icon="undo"
            title="Out there now"
            sub="Tap one to book its gear back in"
          />
          <ul className="job-list">
            {outJobs.map((j, i) => (
              <li key={j.id} className="stagger" style={{ ['--i' as string]: i }}>
                <button
                  className="job-card pressable"
                  onClick={() => go({ name: 'scan', jobId: j.id, mode: 'in' })}
                >
                  <span className="job-main">
                    <span className="job-label">{j.label}</span>
                    <span className="job-contact">
                      {j.out} item{j.out === 1 ? '' : 's'} still out
                    </span>
                  </span>
                  <span className="job-meta">
                    <Icon name="undo" size={22} />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="section">
        <SectionHead icon="bolt" title="Quick" />
        <div className="quick-grid">
          <button className="quick pressable" onClick={() => go({ name: 'scan', jobId: 'lookup', mode: 'in' })}>
            <Icon name="camera" size={20} />
            <span className="quick-t">Just scan</span>
            <span className="quick-s">Where is this thing?</span>
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
