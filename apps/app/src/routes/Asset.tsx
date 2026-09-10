import { Icon } from '@papa/icons'
import { formatRupees } from '@papa/core'
import { go } from '../nav.ts'
import { SectionHead } from '../components/Shell.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { statusSentence, type Health, type Presence } from '../status.ts'
import { PhotoCompare } from '../components/PhotoCompare.tsx'
import type { PhotoPair } from '@papa/core'
import { STR } from '../strings.ts'

/**
 * One item.
 *
 * THE STATUS IS A SENTENCE HERE, not a badge. A person on this page has time
 * to read, and "On the Wedding job since Tuesday, due back Sunday" answers the
 * question a coloured dot only gestures at. The badge stays as well, because
 * this page is also reached by scanning something in your hand and glancing.
 *
 * The history is the point of the whole product. It is the append-only scan
 * log rendered plainly, and it is what settles an argument with a client — so
 * it names WHO and HOW, and never hides that an entry was assumed rather than
 * seen.
 */

export interface AssetHistoryRow {
  id: string
  event: string
  at: string
  entryMethod: string
  jobLabel: string | null
  actor: string
  /** Consecutive same-event/same-job rows collapsed into this one — a
   *  rescan-after-restart echo renders as one row with a ×N marker.
   *  POLICY (owner may overrule): the queue keeps every op; only the
   *  story is tidied. See collapseHistory in demo/read-model.ts. */
  times: number
}

export interface AssetView {
  id: string
  code: string
  name: string
  category: string
  presence: Presence
  health: Health
  locationName: string | null
  jobLabel: string | null
  serial: string | null
  productId: string | null
  tagCode: string | null
  history: AssetHistoryRow[]
}

/** The money facts of one unit — computed in khata.ts, rendered here. */
export interface AssetMoney {
  earnedMinor: number
  jobs: number
  replacementMinor: number | null
  /** Null when the replacement value is unknown — no bar against a
   *  made-up denominator. NOT clamped: 130% is the celebration itself. */
  paybackPct: number | null
  /** How many enquiries this unit's product was turned away from this
   *  month — the buy signal. */
  turnedAwayTimes: number
}

/**
 * What this unit has EARNED — the sum of the ledger lines that name it —
 * and how far that has gone toward its replacement value.
 *
 * The money.ts honesty rule holds throughout: no replacement value on
 * record means NO bar, because a payback bar against a made-up denominator
 * is a confident lie; and past 100% the bar fills and the page says so out
 * loud — that line is the digest's celebration, earned literally.
 */
function AssetMoneySection({ money }: { money: AssetMoney }) {
  const paidOff = money.paybackPct !== null && money.paybackPct >= 100
  return (
    <section className="section">
      <SectionHead
        icon="scroll"
        title={STR.gearMoneyHeading}
        sub={
          money.earnedMinor > 0
            ? STR.gearEarnedAcross(formatRupees(money.earnedMinor), money.jobs)
            : STR.gearNothingEarnedYet
        }
      />
      {money.paybackPct !== null ? (
        <div className="payback">
          <div
            className="payback-bar"
            role="img"
            aria-label={STR.gearPaybackLabel(money.paybackPct)}
          >
            <span
              className="payback-fill"
              style={{ width: `${Math.min(100, Math.max(0, money.paybackPct))}%` }}
            />
          </div>
          <p className="payback-label">
            {STR.gearPaybackLabel(money.paybackPct)}
          </p>
          {paidOff ? (
            <p className="payback-paid">
              <Icon name="check" size={14} /> {STR.gearPaidForItself}
            </p>
          ) : null}
        </div>
      ) : (
        <p className="section-sub">{STR.gearNoReplacementValue}</p>
      )}
      {money.turnedAwayTimes > 0 ? (
        <p className="payback-demand">
          {STR.gearTurnedAway(money.turnedAwayTimes)}
        </p>
      ) : null}
    </section>
  )
}

/** How an entry got into the log, said plainly. */
const METHOD_LABEL: Record<string, string> = {
  scanned: STR.gearMethodScanned,
  manual: STR.gearMethodManual,
  assumed: STR.gearMethodAssumed,
  implied: STR.gearMethodImplied,
  counted: STR.gearMethodCounted,
}

const EVENT_LABEL: Record<string, string> = {
  check_out: STR.gearEventWentOut,
  check_in: STR.gearEventCameBack,
  intake: STR.gearEventIntake,
  move: STR.gearEventMove,
}

export function Asset({
  asset,
  money,
  photoPairs,
  onProveIt,
}: {
  asset: AssetView | null
  money: AssetMoney | null
  photoPairs: PhotoPair[]
  /** Share the alibi card built from this item's local history. */
  onProveIt: () => void
}) {
  if (!asset) {
    return (
      <div className="empty">
        <Icon name="question" size={36} />
        <p>{STR.gearNoSuchItem}</p>
        <button className="btn btn-ghost" onClick={() => go({ name: 'gear' })}>
          {STR.gearBackToTheGear}
        </button>
      </div>
    )
  }

  const sentence = statusSentence(
    { presence: asset.presence, health: asset.health },
    { jobLabel: asset.jobLabel, locationName: asset.locationName },
  )

  return (
    <>
      <div className="asset-head">
        <div className="asset-id">
          <span className="asset-code code">{asset.code}</span>
          <StatusBadge status={{ presence: asset.presence, health: asset.health }} showLabel />
        </div>
        <h2 className="asset-name">{asset.name}</h2>
        <p className="asset-status">{sentence}</p>
      </div>

      <dl className="fact-grid">
        <div className="fact">
          <dt>{STR.gearFactCategory}</dt>
          <dd>{asset.category}</dd>
        </div>
        <div className="fact">
          <dt>{STR.gearFactShelf}</dt>
          <dd>{asset.locationName ?? '—'}</dd>
        </div>
        <div className="fact">
          <dt>{STR.gearFactSerial}</dt>
          <dd className="code">{asset.serial ?? STR.gearSerialNotRecorded}</dd>
        </div>
        <div className="fact">
          <dt>{STR.gearFactTag}</dt>
          {/* Truncated, because the code is opaque by design and nobody reads
              it — but shown, because "is this thing even tagged" is a real
              question at the bench. */}
          <dd className="code">{asset.tagCode ? `${asset.tagCode.slice(0, 8)}…` : STR.gearNoTag}</dd>
        </div>
      </dl>

      {/* The tech's alibi (PLAN.md's "Prove it"): this item's story — state,
          last scan, photo count — as one WhatsApp card built from local data.
          A full-width tap, glove-sized, with nothing destructive anywhere on
          this page to mis-tap into; it reads, it never writes. */}
      <button className="btn btn-outline btn-block" onClick={onProveIt}>
        <Icon name="send" size={18} /> {STR.gearProveIt}
      </button>

      {money ? <AssetMoneySection money={money} /> : null}

      <section className="section">
        <SectionHead
          icon="camera"
          title={STR.gearCondition}
          sub={
            photoPairs.length === 0
              ? STR.gearNothingPhotographed
              : STR.gearOutBesideBack
          }
        />
        <PhotoCompare pairs={photoPairs} />
      </section>

      <section className="section">
        <SectionHead
          icon="scroll"
          title={STR.gearHistory}
          sub={
            asset.history.length === 0
              ? STR.gearNothingRecordedYet
              : STR.gearEntriesNewestFirst(asset.history.length)
          }
        />

        {asset.history.length === 0 ? (
          <div className="empty">
            <Icon name="scroll" size={32} />
            <p>{STR.gearItemHasNotMovedYet}</p>
            <p className="muted">{STR.gearScanItOutAndItShowsUp}</p>
          </div>
        ) : (
          <ol className="history">
            {asset.history.map((h) => (
              <li key={h.id} className={h.entryMethod === 'assumed' ? 'is-assumed' : ''}>
                <span className="hist-dot" aria-hidden="true" />
                <div className="hist-body">
                  <span className="hist-event">
                    {EVENT_LABEL[h.event] ?? h.event}
                    {h.times > 1 ? <span className="code"> ×{h.times}</span> : null}
                  </span>
                  {h.jobLabel ? <span className="hist-job">{h.jobLabel}</span> : null}
                  <span className="hist-meta">
                    {h.at} · {h.actor} · {METHOD_LABEL[h.entryMethod] ?? h.entryMethod}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  )
}
