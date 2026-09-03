import { useMemo, useRef, useState } from 'react'
import { moneyLabel } from '@papa/core'
import { Icon } from '@papa/icons'
import { Shell, SectionHead } from '../components/Shell.tsx'
import { go, type View } from '../nav.ts'
import { DueBadge } from '../routes/Today.tsx'
import { dayAccountText, type DayItem } from './hisaab.ts'
import type { DemoStore } from './store.ts'

/**
 * Din ka hisaab — the day's account, on screen.
 *
 * Everything rendered here is derived in hisaab.ts from local tables; this
 * component adds nothing but layout. Dense but calm: counts up top, then the
 * day per job in the order it happened, then what is still out and to whom.
 *
 * TRUST IS VISIBLY DISTINCT. Items taken on trust carry their own mark and
 * their own colour — countable in the totals, but never dressed as an
 * observation. The evening reader must be able to see at a glance how much of
 * today's account is belief.
 *
 * The copy button produces the compact WhatsApp version and stops there: the
 * owner forwards it to his staff group himself, because the authority of the
 * message lives in WHO sent it, not in the app that drafted it.
 */
export function HisaabScreen({ store }: { store: DemoStore }) {
  const view: View = { name: 'hisaab' }
  // Computed once per mount; the screen is a report, not a live feed.
  const account = useMemo(() => store.dayAccount(), [store])

  const [copied, setCopied] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCopy = () => {
    void navigator.clipboard?.writeText(dayAccountText(account)).catch(() => {})
    setCopied(true)
    if (copyTimer.current) clearTimeout(copyTimer.current)
    copyTimer.current = setTimeout(() => setCopied(false), 1500)
  }

  const quiet =
    account.wentOut === 0 &&
    account.cameBack === 0 &&
    account.photos === 0 &&
    account.unknownTags === 0

  return (
    <Shell
      view={view}
      title="Din ka hisaab"
      subtitle={account.dayLabel}
      action={
        <button className="icon-btn" onClick={() => go({ name: 'jobs' })} aria-label="Back to today">
          <Icon name="chevron-left" size={22} />
        </button>
      }
    >
      <div className="stat-strip">
        <div className="stat">
          <span className="stat-n code">{account.wentOut}</span>
          <span className="stat-label">went out</span>
        </div>
        <div className="stat">
          <span className="stat-n code">{account.cameBack}</span>
          <span className="stat-label">came back</span>
        </div>
        <div className={`stat${account.onTrust > 0 ? ' is-warn' : ''}`}>
          <span className="stat-n code">{account.onTrust}</span>
          <span className="stat-label">on trust</span>
        </div>
        <div className="stat">
          <span className="stat-n code">{account.photos}</span>
          <span className="stat-label">photos</span>
        </div>
      </div>

      <div className="hisaab-bar">
        <button className="btn btn-primary btn-block" onClick={onCopy}>
          <Icon name="clipboard" size={18} />{' '}
          {copied ? 'Copied — paste it in WhatsApp' : "Copy the day's account"}
        </button>
      </div>

      {account.unknownTags > 0 ? (
        <div className="notice notice-warn">
          <Icon name="tag-off" size={18} />
          <div>
            <strong>
              {account.unknownTags} unknown label{account.unknownTags === 1 ? '' : 's'} scanned today.
            </strong>
            <p>Labels this phone has never seen. Recorded, waiting to be identified.</p>
          </div>
        </div>
      ) : null}

      {quiet ? (
        <div className="empty">
          <Icon name="clipboard" size={36} />
          <p>Nothing scanned or photographed today yet.</p>
          <p className="muted">
            The account fills itself as gear is scanned out and back. What is
            still out from earlier days is listed below.
          </p>
        </div>
      ) : (
        account.jobs.map((g) => (
          <section className="section" key={g.jobId || 'no-job'}>
            <SectionHead
              icon="clipboard-check"
              title={g.jobLabel}
              sub={jobLine(g.out.length, g.back.length, g.photos)}
            />
            {g.out.length > 0 ? <DayList heading="Went out" items={g.out} /> : null}
            {g.back.length > 0 ? <DayList heading="Came back" items={g.back} /> : null}
          </section>
        ))
      )}

      <section className="section">
        <SectionHead
          icon="undo"
          title="Still out"
          sub={
            account.stillOut.length === 0
              ? 'Everything is home'
              : 'With the client — the due label says since when'
          }
        />
        {account.stillOut.length === 0 ? null : (
          <ul className="line-list">
            {account.stillOut.map((j) => {
              // Replacement value of what the job is holding. The label says
              // '+N unpriced' itself; a fully unpriced job shows no figure —
              // the count is still the fact, money is only added when known.
              const value = moneyLabel(j.value)
              return (
                <li key={j.id} className="line">
                  <span className="line-name">{j.label}</span>
                  <span className="line-note">
                    {j.out} item{j.out === 1 ? '' : 's'} still out
                    {value !== null ? ` · ${value}` : ''}
                  </span>
                  <span className="line-code">
                    <DueBadge due={j.due} />
                  </span>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </Shell>
  )
}

/** '8 out · 2 back · 3 photos' — only the parts that happened. */
function jobLine(out: number, back: number, photos: number): string {
  const parts: string[] = []
  if (out > 0) parts.push(`${out} out`)
  if (back > 0) parts.push(`${back} back`)
  if (photos > 0) parts.push(`${photos} photo${photos === 1 ? '' : 's'}`)
  return parts.length > 0 ? parts.join(' · ') : 'Photographed only'
}

function DayList({ heading, items }: { heading: string; items: DayItem[] }) {
  const trust = items.filter((i) => i.assumed).length
  return (
    <div className="hisaab-list">
      <h3 className="hisaab-sub">
        {heading}
        {trust > 0 ? <span className="hisaab-trust-count"> · {trust} on trust</span> : null}
      </h3>
      <ul className="line-list">
        {items.map((i) => (
          <li key={i.assetId} className={`line${i.assumed ? ' line-assumed' : ''}`}>
            <span className="line-name">{i.name ?? 'Unknown item'}</span>
            {i.assumed ? (
              // A belief, not an observation — same vocabulary as the
              // handover screen, so the two never disagree about what
              // 'assumed' means.
              <span className="line-note">Taken on trust — not seen</span>
            ) : null}
            <span className="line-code code">{i.code ?? '—'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
