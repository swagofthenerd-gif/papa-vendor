import { moneyLabel, type SqlDriver } from '@papa/core'
import {
  assetFacts,
  decodeScanOps,
  dueBoard,
  type DecodedScanOp,
  type OutDueRow,
} from './read-model.ts'

/**
 * Din ka hisaab — the day's account.
 *
 * What went out today, what came back, what is still out and to whom, what
 * was taken on trust, what was photographed — computed ENTIRELY locally, from
 * the outbox (via the one decode helper), the mirror, and the photo table.
 * Nothing here waits on a network, because the question is asked at 7pm on
 * whatever phone is in the owner's hand, connected or not.
 *
 * In a .ts module, like read-model.ts and session-summary.ts, so every rule
 * about what counts as "went out today" is assertable under plain Node. The
 * screen renders this; it derives nothing of its own.
 *
 * TRUST IS COUNTED, NEVER PROMOTED. An entry_method='assumed' record is a
 * belief; it appears in the account marked as such, and a later scan of the
 * same item on the same job upgrades it to an observation — in either order
 * of arrival, because op order in the queue is not evidence order.
 */

export interface DayItem {
  assetId: string
  code: string | null
  name: string | null
  /** Taken on trust (entry_method='assumed') and never actually seen today. */
  assumed: boolean
}

export interface DayJobGroup {
  jobId: string
  jobLabel: string
  out: DayItem[]
  back: DayItem[]
  /** Condition photos taken on this job today. */
  photos: number
}

export interface DayAccount {
  /** 'Wed 3 Sep' — deterministic, no locale. */
  dayLabel: string
  wentOut: number
  cameBack: number
  onTrust: number
  photos: number
  /** Labels decoded today that this phone could not resolve. */
  unknownTags: number
  /** Every job with gear physically out right now, due labels included —
   *  the same dueBoard read the Today board renders from. */
  stillOut: OutDueRow[]
  jobs: DayJobGroup[]
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** Local midnight before `nowMs` … local midnight after, DST-safe because the
 *  Date constructor rolls the day rather than adding 24h of milliseconds. */
export function dayBounds(nowMs: number): { startMs: number; endMs: number } {
  const d = new Date(nowMs)
  return {
    startMs: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    endMs: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(),
  }
}

export function dayLabel(nowMs: number): string {
  const d = new Date(nowMs)
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

interface JobFacts {
  /** assetId -> still only assumed. False the moment any real scan exists. */
  out: Map<string, boolean>
  back: Map<string, boolean>
  firstAt: number
}

export interface DayScanFacts {
  jobs: Map<string, JobFacts>
  unknownTags: number
}

/**
 * Classify one day's scan ops — the pure heart of the account.
 *
 * Deduped by (job, asset, direction): a rescan in a second session is the
 * same physical fact, not a second departure. The assumed flag survives only
 * while NO op for that key is an observation — `flag && assumed` rather than
 * last-writer-wins, so a trust-confirm arriving after the scan (or before it)
 * never demotes an observation back to a belief.
 */
export function classifyDayScans(
  ops: DecodedScanOp[],
  startMs: number,
  endMs: number,
): DayScanFacts {
  const jobs = new Map<string, JobFacts>()
  let unknownTags = 0

  for (const op of ops) {
    if (op.createdAt < startMs || op.createdAt >= endMs) continue
    if (!op.assetId) {
      unknownTags++
      continue
    }
    if (op.eventType !== 'check_out' && op.eventType !== 'check_in') continue

    // A scan with no job still happened; '' groups it under 'Not on a job'
    // rather than dropping it, because a dropped record is silent data loss.
    const key = op.jobId ?? ''
    let job = jobs.get(key)
    if (!job) {
      job = { out: new Map(), back: new Map(), firstAt: op.createdAt }
      jobs.set(key, job)
    }

    const side = op.eventType === 'check_in' ? job.back : job.out
    const assumed = op.entryMethod === 'assumed'
    side.set(op.assetId, (side.get(op.assetId) ?? true) && assumed)
  }

  return { jobs, unknownTags }
}

/** The account for the day containing `nowMs`, from the local tables only. */
export function dayAccount(db: SqlDriver, nowMs: number): DayAccount {
  const { startMs, endMs } = dayBounds(nowMs)
  const facts = classifyDayScans(decodeScanOps(db), startMs, endMs)

  // Photos taken today, grouped the same way. A job photographed but never
  // scanned still had a day — it gets a group with two empty lists.
  const photosByJob = new Map<string, number>()
  for (const r of db.all<{ job_id: string | null; n: number }>(
    `select job_id, count(*) as n from condition_photos
      where captured_at >= ? and captured_at < ? group by job_id`,
    [startMs, endMs],
  )) {
    photosByJob.set(r.job_id ?? '', Number(r.n))
  }

  const jobIds = new Set<string>([...facts.jobs.keys(), ...photosByJob.keys()])

  const items = (m: Map<string, boolean>): DayItem[] =>
    [...m.entries()]
      .map(([assetId, assumed]) => {
        const f = assetFacts(db, assetId)
        return { assetId, code: f?.code ?? null, name: f?.name ?? null, assumed }
      })
      .sort((a, b) => (a.code ?? '').localeCompare(b.code ?? ''))

  const groups: DayJobGroup[] = [...jobIds]
    .map((jobId) => {
      const j = facts.jobs.get(jobId)
      const label =
        jobId === ''
          ? 'Not on a job'
          : db.get<{ label: string | null }>(`select label from jobs where id = ?`, [jobId])
              ?.label ?? 'Unnamed job'
      const group: DayJobGroup = {
        jobId,
        jobLabel: label,
        out: j ? items(j.out) : [],
        back: j ? items(j.back) : [],
        photos: photosByJob.get(jobId) ?? 0,
      }
      // The day reads in the order it happened; photo-only groups read last.
      return { firstAt: j?.firstAt ?? endMs, group }
    })
    .sort((a, b) => a.firstAt - b.firstAt)
    .map((g) => g.group)

  const trust = (g: DayJobGroup) =>
    g.out.filter((i) => i.assumed).length + g.back.filter((i) => i.assumed).length

  return {
    dayLabel: dayLabel(nowMs),
    wentOut: groups.reduce((n, g) => n + g.out.length, 0),
    cameBack: groups.reduce((n, g) => n + g.back.length, 0),
    onTrust: groups.reduce((n, g) => n + trust(g), 0),
    photos: [...photosByJob.values()].reduce((n, p) => n + p, 0),
    unknownTags: facts.unknownTags,
    stillOut: dueBoard(db, nowMs).outJobs,
    jobs: groups,
  }
}

/**
 * The account as one WhatsApp-forwardable message.
 *
 * Counts per job, not item recitations — the owner forwards this to his staff
 * group himself, and a message that scrolls stops being read. The still-out
 * lines carry the honest due labels from dueStatus ('2 days late', 'no date'),
 * because "still out" without "since when" is the question, not the answer.
 */
export function dayAccountText(account: DayAccount): string {
  const lines: string[] = []
  lines.push(`Din ka hisaab — ${account.dayLabel}`)
  lines.push(
    `Out ${account.wentOut} · Back ${account.cameBack}` +
      (account.onTrust > 0 ? ` · On trust ${account.onTrust}` : '') +
      (account.photos > 0 ? ` · Photos ${account.photos}` : ''),
  )
  if (account.unknownTags > 0) {
    lines.push(`${account.unknownTags} unknown label${account.unknownTags === 1 ? '' : 's'} scanned`)
  }

  if (account.jobs.length === 0) {
    lines.push('')
    lines.push('Nothing scanned or photographed today.')
  } else {
    lines.push('')
    for (const g of account.jobs) {
      const parts: string[] = []
      if (g.out.length > 0) {
        const t = g.out.filter((i) => i.assumed).length
        parts.push(`${g.out.length} out${t > 0 ? ` (${t} on trust)` : ''}`)
      }
      if (g.back.length > 0) {
        const t = g.back.filter((i) => i.assumed).length
        parts.push(`${g.back.length} back${t > 0 ? ` (${t} on trust)` : ''}`)
      }
      if (g.photos > 0) parts.push(`${g.photos} photo${g.photos === 1 ? '' : 's'}`)
      lines.push(`${g.jobLabel}: ${parts.join(', ')}`)
    }
  }

  if (account.stillOut.length > 0) {
    lines.push('')
    lines.push('Still out:')
    for (const j of account.stillOut) {
      // Money makes "still out" a decision rather than a note — but only the
      // honest amount: the label carries its own '+N unpriced', and a job of
      // entirely unpriced gear gets no number at all rather than 'Rs 0'.
      const value = moneyLabel(j.value)
      lines.push(
        `- ${j.label}: ${j.out} item${j.out === 1 ? '' : 's'}, ${j.due.label}` +
          (value !== null ? `, ${value}` : ''),
      )
    }
  }

  return lines.join('\n')
}
