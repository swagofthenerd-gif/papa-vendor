import { useState } from 'react'
import { Icon } from '@papa/icons'
import { bookingDateLabel, formatRupees, type Disposition as MarkDisposition, type PromisedSoon } from '@papa/core'
import { go } from '../nav.ts'
import { SectionHead } from '../components/Shell.tsx'
import { StatusBadge } from '../components/StatusBadge.tsx'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import { statusSentence, type Health, type Presence, type Disposition } from '../status.ts'
import { PhotoCompare } from '../components/PhotoCompare.tsx'
import { AwaazNote, type AwaazRecording, type AwaazSaveResult } from '../components/AwaazNote.tsx'
import type { PhotoPair, VoiceNoteRow } from '@papa/core'
import type { ServiceFacts } from '../demo/read-model.ts'
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
  disposition: Disposition
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
  /** Live repair expenses naming this unit (kharcha.ts) — the cost line
   *  and the payback bar's honest denominator both read these. */
  repairMinor: number
  repairCount: number
  /** Replacement value + repairs, or null when the replacement value is
   *  unknown — repairs alone are not "the cost of this camera". */
  costMinor: number | null
  /** Null when the cost is unknowable — no bar against a made-up
   *  denominator. NOT clamped: 130% is the celebration itself. */
  paybackPct: number | null
  /** How many enquiries this unit's product was turned away from this
   *  month — the buy signal. */
  turnedAwayTimes: number
}

/**
 * What this unit has EARNED — the sum of the ledger lines that name it —
 * and what it has COST: its replacement value plus the kharcha book's
 * repairs (0019). The payback bar divides the first by the second.
 *
 * The money.ts honesty rule holds throughout: no replacement value on
 * record means NO bar, because a payback bar against a made-up denominator
 * is a confident lie — repairs alone never stand in for a price; and past
 * 100% the bar fills and the page says so out loud — that line is the
 * digest's celebration, earned literally (now against the honest
 * denominator: a repaired camera has genuinely cost more to keep earning).
 */
function AssetMoneySection({
  money,
  onRepairCost,
}: {
  money: AssetMoney
  /** Open the kharcha sheet wired to this unit — the repair door. */
  onRepairCost: () => void
}) {
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
      {/* The cost line — the payback bar's denominator, said in words so
          the figure is checkable. Rendered only once a repair exists:
          before that, cost IS the purchase value the bar already names. */}
      {money.repairCount > 0 ? (
        <p className="section-sub">
          {money.costMinor !== null
            ? STR.kharchaAssetCost(formatRupees(money.costMinor), money.repairCount)
            : STR.kharchaAssetRepairsOnly(
                formatRupees(money.repairMinor),
                money.repairCount,
              )}
        </p>
      ) : null}
      {money.turnedAwayTimes > 0 ? (
        <p className="payback-demand">
          {STR.gearTurnedAway(money.turnedAwayTimes)}
        </p>
      ) : null}
      {/* The repair door, wired to THIS unit — a write, so it lives here
          in the money section, away from the read-only share button
          above (adjacency, not size, prevents mis-taps). */}
      <button className="btn btn-outline btn-block" onClick={onRepairCost}>
        <Icon name="wrench" size={18} /> {STR.kharchaRepairCost}
      </button>
    </section>
  )
}

/**
 * The Sehat section of one unit's page (0021): the service line — the
 * usage meter said in words, with a NEEDS-A-LOOK notice once it passes the
 * product's threshold — the cycle line for flagged products, the Serviced
 * door, and the awaaz notes: hold-to-record spoken evidence, played back
 * inline. Not rendered for terminal gear — a sold camera has no health.
 */
function AssetSehatSection({
  asset,
  service,
  voiceNotes,
  onServiced,
  onVoiceSave,
}: {
  asset: AssetView
  service: ServiceFacts | null
  voiceNotes: VoiceNoteRow[]
  onServiced: () => void
  onVoiceSave: (rec: AwaazRecording) => AwaazSaveResult
}) {
  return (
    <section className="section">
      <SectionHead
        icon="wrench"
        title={STR.sehatHeading}
        sub={
          service && (service.dueAfter !== null || service.daysSinceService > 0)
            ? STR.sehatSinceLine(service.daysSinceService, service.dueAfter)
            : undefined
        }
      />
      {service?.due ? (
        <div className="notice notice-warn">
          <Icon name="warning" size={18} />
          <div>
            <strong>{STR.sehatNeedsALookStamp}</strong>
          </div>
        </div>
      ) : null}

      {service?.countCycles ? (
        <p className="section-sub">
          {STR.sehatCycleLine(service.cycleCount, service.retireAfterCycles)}
        </p>
      ) : null}
      {service?.cyclesOver ? (
        <div className="notice notice-warn">
          <Icon name="warning" size={18} />
          <div>
            <strong>{STR.sehatCycleOverStamp}</strong>
          </div>
        </div>
      ) : null}

      {/* The Serviced door — a write, kept with the other writes and away
          from the share buttons (adjacency, not size, prevents mis-taps).
          Always offered: recording a service is legal on any live unit,
          threshold or not. */}
      <button className="btn btn-outline btn-block" onClick={onServiced}>
        <Icon name="wrench" size={18} /> {STR.sehatServicedButton}
      </button>

      {/* Awaaz notes: spoken evidence, kept like photos, played inline.
          The device's clock is labelled as the device's, always. */}
      {voiceNotes.length > 0 ? (
        <ul className="awaaz-list">
          {voiceNotes.map((n) => (
            <li key={n.id}>
              <audio className="awaaz-audio" controls src={n.localUri} />
              <p className="awaaz-meta">
                {STR.awaazRecordedAt(new Date(n.capturedAt).toLocaleString())}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="section-sub">{STR.awaazNothingYet}</p>
      )}
      <AwaazNote targetLabel={asset.code} onSave={onVoiceSave} />
    </section>
  )
}

/** The rubber-stamp word for a terminal item — the CSS uppercases it. */
const STAMP_WORD: Record<string, string> = {
  lost: STR.fleetStampLost,
  stolen: STR.fleetStampStolen,
  sold: STR.fleetStampSold,
  retired: STR.fleetStampRetired,
}

/**
 * The fleet-lifecycle section.
 *
 * A live item shows the destructive door — 'Mark lost, stolen or sold' —
 * behind a HOLD, never a tap: an accidental brush must not begin ending a
 * camera's life. It sits at the very bottom of the page, well away from the
 * read-only share and repair buttons above (adjacency, not size, prevents
 * mis-taps). An out item also gets the swap door here.
 *
 * A terminal item shows its STAMP and the two doors that still make sense:
 * the theft report (stolen only) and 'found', the recovery path.
 */
function FleetSection({
  asset,
  onMarkTerminal,
  onFound,
  onTheftReport,
  onSwap,
}: {
  asset: AssetView
  onMarkTerminal: (d: MarkDisposition, note: string | null, saleMinor: number | null) => void
  onFound: () => void
  onTheftReport: () => void
  onSwap: () => void
}) {
  const [open, setOpen] = useState(false)

  if (asset.presence === 'gone') {
    return (
      <section className="section">
        <div className="fleet-stamp-row">
          <span className="stamp">{STAMP_WORD[asset.disposition ?? 'lost'] ?? asset.disposition}</span>
        </div>
        {asset.disposition === 'stolen' ? (
          <button className="btn btn-outline btn-block" onClick={onTheftReport}>
            <Icon name="send" size={18} /> {STR.fleetTheftReport}
          </button>
        ) : null}
        <button className="btn btn-ghost btn-block" onClick={onFound}>
          <Icon name="check" size={18} /> {STR.fleetFound}
        </button>
      </section>
    )
  }

  const isOut = asset.presence === 'out' || asset.presence === 'in_transit'

  return (
    <section className="section fleet-danger">
      {isOut ? (
        <button className="btn btn-outline btn-block" onClick={onSwap}>
          <Icon name="repeat" size={18} /> {STR.fleetSwapOntoJob}
        </button>
      ) : null}

      {open ? (
        <MarkTerminalPanel onMark={onMarkTerminal} onCancel={() => setOpen(false)} />
      ) : (
        <div className="fleet-disclosure">
          <p className="section-sub">{STR.fleetMarkGoneHint}</p>
          <HoldToFinish label={STR.fleetMarkGone} onFinish={() => setOpen(true)} />
        </div>
      )}
    </section>
  )
}

/**
 * The reveal-once panel: pick lost / stolen / sold, add a note, and (for a
 * sale) an optional amount, then a per-outcome confirm. Nothing writes until
 * the confirm — the note-and-confirm rule the destructive doors all follow.
 */
function MarkTerminalPanel({
  onMark,
  onCancel,
}: {
  onMark: (d: MarkDisposition, note: string | null, saleMinor: number | null) => void
  onCancel: () => void
}) {
  const [kind, setKind] = useState<MarkDisposition>('lost')
  const [note, setNote] = useState('')
  const [amount, setAmount] = useState('')

  const confirmLabel =
    kind === 'lost' ? STR.fleetConfirmLost
      : kind === 'stolen' ? STR.fleetConfirmStolen
        : STR.fleetConfirmSold

  const chips: { key: MarkDisposition; label: string }[] = [
    { key: 'lost', label: STR.fleetLost },
    { key: 'stolen', label: STR.fleetStolen },
    { key: 'sold', label: STR.fleetSold },
  ]

  return (
    <div className="fleet-mark">
      <div className="chip-row" role="group" aria-label={STR.fleetMarkGone}>
        {chips.map((c) => (
          <button
            key={c.key}
            className={`filter-chip${kind === c.key ? ' active' : ''}`}
            aria-pressed={kind === c.key}
            onClick={() => setKind(c.key)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <label className="field-label" htmlFor="mark-note">{STR.fleetMarkNoteLabel}</label>
      <input
        id="mark-note"
        className="sheet-search"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        autoCorrect="off"
        spellCheck={false}
      />

      {kind === 'sold' ? (
        <>
          <label className="field-label" htmlFor="mark-amount">{STR.fleetSaleAmountLabel}</label>
          <input
            id="mark-amount"
            className="sheet-search code"
            type="number"
            inputMode="decimal"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          <p className="sheet-hint">{STR.fleetSaleAmountHint}</p>
        </>
      ) : null}

      <button
        className="btn btn-danger btn-block"
        onClick={() => {
          const rupees = Number(amount)
          const saleMinor =
            kind === 'sold' && Number.isFinite(rupees) && rupees > 0
              ? Math.round(rupees * 100)
              : null
          onMark(kind, note.trim() || null, saleMinor)
        }}
      >
        {confirmLabel}
      </button>
      <button className="btn btn-ghost btn-block" onClick={onCancel}>
        {STR.commonClose}
      </button>
    </div>
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
  promised,
  service,
  voiceNotes,
  photoPairs,
  onProveIt,
  onRepairCost,
  onServiced,
  onVoiceSave,
  onMarkTerminal,
  onFound,
  onTheftReport,
  onSwap,
}: {
  asset: AssetView | null
  money: AssetMoney | null
  /** The calendar's claim on this unit inside the scanner's horizon —
   *  the 'Right now' section's PROMISED stamp (0022 promisedSoon). */
  promised: PromisedSoon | null
  /** The unit's wear facts (0021) — the service and cycle lines. */
  service: ServiceFacts | null
  /** Spoken evidence over this unit, newest first — played inline. */
  voiceNotes: VoiceNoteRow[]
  photoPairs: PhotoPair[]
  /** Share the alibi card built from this item's local history. */
  onProveIt: () => void
  /** Open the kharcha sheet with the kind locked to repair and this unit
   *  pre-wired — the asset page's quick action (0019). */
  onRepairCost: () => void
  /** Open the Serviced sheet — note + optional cost in one flow (0021). */
  onServiced: () => void
  /** Keep a hold-to-record awaaz note about this unit. */
  onVoiceSave: (rec: AwaazRecording) => AwaazSaveResult
  /** Declare the item lost/stolen/sold — behind the hold-gated disclosure. */
  onMarkTerminal: (d: MarkDisposition, note: string | null, saleMinor: number | null) => void
  /** Bring a terminal item back into the fleet. */
  onFound: () => void
  /** Build and share the theft report (stolen items). */
  onTheftReport: () => void
  /** Open the swap sheet for an item out on a live job. */
  onSwap: () => void
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
        {promised ? (
          <p className="asset-promised">
            <span className="stamp stamp-small">
              {STR.bookingPromisedStamp(promised.bookingNo, bookingDateLabel(promised.blockedStartMs).split(',')[0])}
            </span>{' '}
            <span className="section-sub">
              {STR.bookingPromisedRightNow(promised.bookingNo, promised.customerName, bookingDateLabel(promised.blockedStartMs))}
            </span>
          </p>
        ) : null}
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

      {money ? <AssetMoneySection money={money} onRepairCost={onRepairCost} /> : null}

      {/* The Sehat section (0021) — wear, service and the spoken record.
          Terminal gear gets none: a sold camera has no health. */}
      {asset.presence !== 'gone' ? (
        <AssetSehatSection
          asset={asset}
          service={service}
          voiceNotes={voiceNotes}
          onServiced={onServiced}
          onVoiceSave={onVoiceSave}
        />
      ) : null}

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

      {/* The fleet-lifecycle door — last on the page, behind a hold, well
          clear of the read-only actions above (0020). */}
      <FleetSection
        asset={asset}
        onMarkTerminal={onMarkTerminal}
        onFound={onFound}
        onTheftReport={onTheftReport}
        onSwap={onSwap}
      />
    </>
  )
}
