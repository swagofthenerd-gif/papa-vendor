import { Icon } from '@papa/icons'
import { go } from '../nav.ts'

/**
 * The scanner's home screen.
 *
 * THIS SCREEN IS TODAY'S JOBS, AND ONE TAP OPENS THE CAMERA BOUND TO ONE.
 *
 * Cold app to scanning = 1 tap. That number is in the performance budget
 * beside the 100ms decode, because it decides whether the app is usable:
 *
 *   - Open on a bare camera and every scan is orphaned, needing a desk chore
 *     later that nobody does.
 *   - Open on a nav shell and the budget is spent before the camera is up.
 *
 * At 6am the tech's mental unit is THE JOB, not the item. Sorted by truck
 * departure, because that is the order the day actually happens in.
 */

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

export function Jobs({
  jobs,
  userName,
  onNewJob,
}: {
  jobs: JobRow[]
  userName: string
  onNewJob: () => void
}) {
  return (
    <div className="screen jobs-screen">
      <header className="screen-head">
        <div>
          <h1>Today</h1>
          {/* The current user is shown large and persistently. On a shared
              warehouse phone, attribution is the entire value of the audit
              trail, and a wrong name is worse than no name. */}
          <p className="who">
            <Icon name="user" size={14} /> {userName}
          </p>
        </div>
        <button className="icon-btn" onClick={() => go({ name: 'search' })} aria-label="Search">
          <Icon name="search" size={22} />
        </button>
      </header>

      {jobs.length === 0 ? (
        <div className="empty">
          <Icon name="clipboard-check" size={40} />
          <p>Nothing scheduled today.</p>
          <p className="muted">
            Start a job to scan gear out, or scan anything to see where it is.
          </p>
        </div>
      ) : (
        <ul className="job-list">
          {jobs.map((job) => {
            const progress = job.expected > 0 ? job.scanned / job.expected : 0
            const ready = job.expected > 0 && job.scanned >= job.expected
            return (
              <li key={job.id}>
                {/* The whole row is the target — not a chevron, not a button
                    inside a row. A gloved thumb gets a 64px band the width of
                    the screen. */}
                <button
                  className="job-card"
                  onClick={() => go({ name: 'scan', jobId: job.id, mode: 'out' })}
                >
                  <span className="job-main">
                    <span className="job-label">{job.label}</span>
                    {job.contact ? <span className="job-contact">{job.contact}</span> : null}
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

      <div className="screen-foot">
        <button className="btn btn-ghost" onClick={onNewJob}>
          <Icon name="clipboard-check" size={18} /> New job
        </button>
        {/* Scanning with no job attached is legitimate and common: someone
            wants to know where a thing is, or is putting stock away. It must
            not require inventing a job first. */}
        <button
          className="btn btn-outline"
          onClick={() => go({ name: 'scan', jobId: 'lookup', mode: 'in' })}
        >
          <Icon name="camera" size={18} /> Just scan
        </button>
      </div>
    </div>
  )
}
