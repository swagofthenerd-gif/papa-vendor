import { Icon } from '@papa/icons'
import { formatRupees, moneyLabel } from '@papa/core'
import { SectionHead } from '../components/Shell.tsx'
import { shortfall, type SessionSummary } from '../session-summary.ts'

/**
 * The handover summary — the screen the plan calls the one to get perfect.
 *
 * IT REPORTS COMPOSITION, NEVER COMPLETION. "40 items · 34 scanned · 4 by case
 * · 2 not accounted for" is a description of what is known, and there is
 * deliberately NO control anywhere on this screen that collapses those numbers
 * into a single tick. The moment one exists, it gets pressed every morning and
 * the log fills with confident fiction.
 *
 * A SHORTFALL IS NOT A FAILURE AND DOES NOT BLOCK. The truck leaves either
 * way; `18 of 40 out · rest to follow` is an ordinary fact, because a second
 * run at 2pm is a second dispatch on the same job. Anything here that could
 * stop a departure would be switched off by the owner the first time it did.
 *
 * The four rows below are ordered worst-first: the exceptions are the work.
 */

export function Session({
  summary,
  onShareWhatsApp,
  onShowParchi,
  onBackToScanning,
  onDone,
}: {
  summary: SessionSummary
  onShareWhatsApp: () => void
  /** Show the challan as a full-screen QR — the phone-to-phone gate pass. */
  onShowParchi: () => void
  onBackToScanning: () => void
  onDone: () => void
}) {
  // Derived in session-summary.ts alongside the list it describes, so the
  // number above and the list below cannot drift apart again.
  const outstanding = shortfall(summary)
  const coming = summary.mode === 'in'
  const missingMoney = moneyLabel(summary.missingValue)

  return (
    <>
      <div className="tally">
        <p className="tally-line code">
          <strong>{summary.expected}</strong> items ·{' '}
          <strong>{summary.scanned}</strong> {coming ? 'back' : 'scanned'}
          {summary.assumed > 0 ? (
            <>
              {' '}· <strong>{summary.assumed}</strong> by case
            </>
          ) : null}
          {outstanding > 0 ? (
            <>
              {' '}· <strong className="tally-short">{outstanding}</strong>{' '}
              {/* The tally must use the same words as the section heading
                  below it. "Not accounted for" above a list headed "Did not
                  come back" reads as two different facts. */}
              {coming ? 'still out' : 'not accounted for'}
            </>
          ) : null}
        </p>
        <p className="tally-sub">
          {outstanding === 0
            ? coming
              ? 'Everything that went out has come back.'
              : 'Everything on the list is accounted for.'
            : coming
              // A gap on the way back is not the same fact as a gap on the way
              // out. Out, the rest follows at 2pm. Back, something is at a
              // client's site or gone, and that costs money — so it is said
              // plainly rather than softened into "not accounted for".
              ? 'Still with the client, or not found. Worth a call today.'
              : 'The rest can follow on a second run. This is a tally, not a verdict.'}
        </p>
      </div>

      {summary.assumed > 0 ? (
        <div className="notice notice-warn">
          <Icon name="warning" size={18} />
          <div>
            <strong>{summary.assumed} confirmed by case, not seen.</strong>
            <p>
              These are a belief, not an observation. They are excluded if this job
              ever turns into a damage claim.
            </p>
          </div>
        </div>
      ) : null}

      {summary.exceptions.length > 0 ? (
        <section className="section">
          <SectionHead icon="warning" title="Needs a word" sub="Recorded either way" />
          <ul className="line-list">
            {summary.exceptions.map((l) => (
              <li key={l.key} className={`line line-${l.outcome}`}>
                <span className="line-name">{l.name ?? 'Unknown item'}</span>
                <span className="line-note">{l.note}</span>
                <span className="line-code code">{l.code ?? '—'}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.missing.length > 0 ? (
        <section className="section">
          <SectionHead
            icon={coming ? 'siren' : 'hourglass'}
            title={coming ? 'Did not come back' : 'Still on the shelf'}
            // Money in the heading is what turns this list from a chore into
            // a decision (PLAN.md's return-flow rule). The label carries its
            // own honesty — 'Rs 43,000 +2 unpriced' — and when NOTHING here
            // has a rate there is no number at all, never a made-up zero.
            sub={
              missingMoney
                ? coming
                  ? `${missingMoney} not back · went out on this job, not scanned in`
                  : `${missingMoney} of day rate on the list, not in the van`
                : coming
                  ? 'Went out on this job, not scanned in'
                  : 'On the list, not in the van'
            }
          />
          <ul className="line-list">
            {summary.missing.map((l) => (
              <li key={l.key} className="line line-missing">
                <span className="line-name">{l.name ?? 'Unknown item'}</span>
                {/* Replacement value coming back, day rate going out — same
                    rule the total is built from. 'no rate' is said plainly:
                    the item still counts, it just cannot be priced. */}
                <span className="line-note">
                  {l.valueMinor !== null ? formatRupees(l.valueMinor) : 'no rate'}
                </span>
                <span className="line-code code">{l.code ?? '—'}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="session-actions">
        {/* WhatsApp first: in Lahore the client-facing interface IS WhatsApp,
            and the manifest is what stops the 9pm "did you send the wide?" */}
        <button className="btn btn-primary btn-block" onClick={onShareWhatsApp}>
          <Icon name="send" size={18} />{' '}
          {coming ? 'Send what is still out' : 'Send the list on WhatsApp'}
        </button>
        {/* The gate pass. The guard's phone reads it with any camera app —
            plain text in, challan out — so it works with no app and no
            network on either side. */}
        <button className="btn btn-outline btn-block" onClick={onShowParchi}>
          <Icon name="qr" size={18} /> Parchi — show at the gate
        </button>
        <button className="btn btn-ghost btn-block" onClick={onBackToScanning}>
          <Icon name="camera" size={18} /> Keep scanning
        </button>
        <button className="btn btn-ghost btn-block" onClick={onDone}>
          Done for now
        </button>
        <p className="session-foot muted">
          {coming
            ? 'Nothing here closes the job or releases a deposit. That happens at the desk, after someone has looked at the gear.'
            : 'Nothing here confirms the dispatch. The desk does that later, with the money attached — it never holds up the truck.'}
        </p>
      </div>
    </>
  )
}

