import { Icon } from '@papa/icons'
import { formatRupees, moneyLabel } from '@papa/core'
import { SectionHead } from '../components/Shell.tsx'
import { shortfall, type SessionSummary } from '../session-summary.ts'
import { STR } from '../strings.ts'

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
          <strong>{summary.expected}</strong> {STR.sessionItems} ·{' '}
          <strong>{summary.scanned}</strong> {coming ? STR.sessionBack : STR.sessionScanned}
          {summary.assumed > 0 ? (
            <>
              {' '}· <strong>{summary.assumed}</strong> {STR.sessionByCase}
            </>
          ) : null}
          {outstanding > 0 ? (
            <>
              {' '}· <strong className="tally-short">{outstanding}</strong>{' '}
              {/* The tally must use the same words as the section heading
                  below it. "Not accounted for" above a list headed "Did not
                  come back" reads as two different facts. */}
              {coming ? STR.sessionStillOut : STR.sessionNotAccountedFor}
            </>
          ) : null}
        </p>
        <p className="tally-sub">
          {outstanding === 0
            ? coming
              ? STR.sessionEverythingCameBack
              : STR.sessionEverythingAccountedFor
            : coming
              // A gap on the way back is not the same fact as a gap on the way
              // out. Out, the rest follows at 2pm. Back, something is at a
              // client's site or gone, and that costs money — so it is said
              // plainly rather than softened into "not accounted for".
              ? STR.sessionWorthACall
              : STR.sessionRestCanFollow}
        </p>
      </div>

      {summary.assumed > 0 ? (
        <div className="notice notice-warn">
          <Icon name="warning" size={18} />
          <div>
            <strong>{STR.sessionConfirmedByCase(summary.assumed)}</strong>
            <p>{STR.sessionABeliefNotAnObservation}</p>
          </div>
        </div>
      ) : null}

      {summary.exceptions.length > 0 ? (
        <section className="section">
          <SectionHead icon="warning" title={STR.sessionNeedsAWord} sub={STR.sessionRecordedEitherWay} />
          <ul className="line-list">
            {summary.exceptions.map((l) => (
              <li key={l.key} className={`line line-${l.outcome}`}>
                <span className="line-name">{l.name ?? STR.commonUnknownItem}</span>
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
            title={coming ? STR.sessionDidNotComeBack : STR.sessionStillOnTheShelf}
            // Money in the heading is what turns this list from a chore into
            // a decision (PLAN.md's return-flow rule). The label carries its
            // own honesty — 'Rs 43,000 +2 unpriced' — and when NOTHING here
            // has a rate there is no number at all, never a made-up zero.
            sub={
              missingMoney
                ? coming
                  ? STR.sessionMoneyNotBack(missingMoney)
                  : STR.sessionMoneyNotInVan(missingMoney)
                : coming
                  ? STR.sessionWentOutNotScannedIn
                  : STR.sessionOnTheListNotInVan
            }
          />
          <ul className="line-list">
            {summary.missing.map((l) => (
              <li key={l.key} className="line line-missing">
                <span className="line-name">{l.name ?? STR.commonUnknownItem}</span>
                {/* Replacement value coming back, day rate going out — same
                    rule the total is built from. 'no rate' is said plainly:
                    the item still counts, it just cannot be priced. */}
                <span className="line-note">
                  {l.valueMinor !== null ? formatRupees(l.valueMinor) : STR.sessionNoRate}
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
          {coming ? STR.sessionSendWhatIsStillOut : STR.sessionSendTheListOnWhatsApp}
        </button>
        {/* The gate pass. The guard's phone reads it with any camera app —
            plain text in, challan out — so it works with no app and no
            network on either side. */}
        <button className="btn btn-outline btn-block" onClick={onShowParchi}>
          <Icon name="qr" size={18} /> {STR.sessionParchiShowAtTheGate}
        </button>
        <button className="btn btn-ghost btn-block" onClick={onBackToScanning}>
          <Icon name="camera" size={18} /> {STR.sessionKeepScanning}
        </button>
        <button className="btn btn-ghost btn-block" onClick={onDone}>
          {STR.sessionDoneForNow}
        </button>
        <p className="session-foot muted">
          {coming
            ? STR.sessionNothingHereClosesTheJob
            : STR.sessionNothingHereConfirms}
        </p>
      </div>
    </>
  )
}

