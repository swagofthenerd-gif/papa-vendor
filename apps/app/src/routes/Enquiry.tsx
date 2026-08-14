import { useState } from 'react'
import { Icon, type AnyIconName } from '@papa/icons'
import type { AvailabilitySummary, AvailabilityLine, CatalogueItem } from '@papa/core'

/**
 * Answering a kit list pasted from WhatsApp.
 *
 * THE ONLY SCREEN IN THE PRODUCT AIMED AT THE OWNER AT HIS DESK RATHER THAN A
 * TECH ON A DOCK — and the only inbound WhatsApp path. Everything else sends
 * information out.
 *
 * The job it replaces: read a list, walk the shelves, check what is booked,
 * type a reply. Twenty minutes, at the moment the owner is already holding the
 * phone and a competitor is one call away.
 *
 * Layout, top to bottom:
 *   paste box       big, empty, focused — the whole screen until something lands
 *   summary line    "9 of 12 available" before any detail
 *   the lines       one row each, worst first
 *   reply           full-width, copies plain text back to WhatsApp
 *
 * ---------------------------------------------------------------------------
 * THE RULE THIS SCREEN ENFORCES VISUALLY
 *
 * Unresolved lines are NOT quietly dropped and NOT quietly guessed. They sit at
 * the top in amber with the client's own words showing, waiting for a tap. A
 * screen that hid them would send a confident reply about gear nobody checked,
 * and the client finds out when the truck arrives.
 */

/**
 * Names taken from the real icon set, not invented.
 *
 * `Icon` falls back to a generic box for an unknown name RATHER THAN FAILING,
 * so a typo here ships as a wrong-but-plausible glyph that nobody notices.
 * Asserted in icon-names.test.mjs for exactly that reason.
 */
const TONE: Record<AvailabilityLine['state'], { icon: AnyIconName; cls: string }> = {
  available: { icon: 'check', cls: 'ok' },
  short: { icon: 'warning', cls: 'warn' },
  none: { icon: 'x-circle', cls: 'bad' },
  unknown: { icon: 'question', cls: 'warn' },
}

/** Worst first: the owner's work is the exceptions, not the wins. */
const ORDER: Record<AvailabilityLine['state'], number> = {
  unknown: 0, none: 1, short: 2, available: 3,
}

export function Enquiry({
  summary,
  reply,
  onPaste,
  onResolve,
  onCopyReply,
  onCreateJob,
}: {
  summary: AvailabilitySummary | null
  reply: string
  onPaste: (text: string) => void
  onResolve: (lineIndex: number, item: CatalogueItem) => void
  onCopyReply: () => void
  onCreateJob: () => void
}) {
  const [text, setText] = useState('')

  if (!summary) {
    return (
      <div className="screen enquiry-screen">
        <header className="screen-head">
          <span className="screen-title">Check a kit list</span>
        </header>

        <div className="paste-zone">
          <textarea
            className="paste-box"
            value={text}
            onChange={(e) => setText(e.target.value)}
            // Roman Urdu and English mix freely here, and autocorrect
            // "fixing" a product name is the one thing that would make the
            // matcher's job harder rather than easier.
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            placeholder={'Paste the client’s message here…\n\nGreetings and “please confirm” are ignored automatically.'}
            rows={10}
          />
          <button
            className="btn btn-primary btn-lg"
            disabled={text.trim().length === 0}
            onClick={() => onPaste(text)}
          >
            Check availability
          </button>
        </div>
      </div>
    )
  }

  const rows = summary.lines
    .map((line, index) => ({ line, index }))
    .sort((a, b) => ORDER[a.line.state] - ORDER[b.line.state])

  const available = summary.lines.length - summary.needsAttention

  return (
    <div className="screen enquiry-screen">
      <header className="screen-head">
        <span className="screen-title">Kit list</span>
        <button className="btn btn-ghost btn-sm" onClick={() => onPaste('')}>
          New list
        </button>
      </header>

      {/* The answer before the detail. The owner is deciding whether to say
          yes, not auditing rows. */}
      <div className={`enquiry-verdict ${summary.canFulfilEverything ? 'is-ok' : 'is-partial'}`}>
        <span className="code enquiry-count">
          {available}/{summary.lines.length}
        </span>
        <span className="enquiry-verdict-text">
          {summary.canFulfilEverything
            ? 'Everything is available'
            : `${summary.needsAttention} need${summary.needsAttention === 1 ? 's' : ''} a look`}
        </span>
      </div>

      <ul className="enquiry-list">
        {rows.map(({ line, index }) => (
          <li key={index} className={`enquiry-row is-${TONE[line.state].cls}`}>
            <Icon name={TONE[line.state].icon} size={18} />

            <span className="row-main">
              <span className="row-name">
                {line.productName ?? line.raw}
                {line.quantity > 1 ? <span className="code"> ×{line.quantity}</span> : null}
              </span>

              {/* What the client actually typed, always visible when it
                  differs. The owner is the one who can tell a typo from a
                  different product, and cannot do that without seeing it. */}
              {line.productName && line.raw.toLowerCase() !== line.productName.toLowerCase() ? (
                <span className="row-note">they wrote: “{line.raw}”</span>
              ) : null}

              {line.state === 'short' ? (
                <span className="row-note">only {line.onHand} of {line.wanted} here</span>
              ) : null}
              {line.state === 'none' ? <span className="row-note">none on the shelf</span> : null}
            </span>

            {/* Unresolved lines are the only ones with an action. Nothing here
                is auto-applied — the candidates are suggestions and the tap is
                the decision. */}
            {line.state === 'unknown' ? (
              <span className="row-actions">
                {line.candidates.slice(0, 2).map((c) => (
                  <button key={c.id} className="btn btn-sm" onClick={() => onResolve(index, c)}>
                    {c.name}
                  </button>
                ))}
              </span>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="enquiry-foot">
        {/* Copy, not send. The conversation is already open in WhatsApp and the
            owner will want to add a line of his own before sending — a
            send-for-me button would be taking the pen out of his hand. */}
        <button className="btn btn-ghost" onClick={onCopyReply} disabled={reply.length === 0}>
          <Icon name="clipboard-check" size={18} /> Copy reply
        </button>
        <button className="btn btn-primary" onClick={onCreateJob}>
          Make a job from this
        </button>
      </div>
    </div>
  )
}
