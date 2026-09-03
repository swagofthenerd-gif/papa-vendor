/**
 * "Prove it" — the tech's alibi card.
 *
 * PLAN.md's adoption feature: when a client claims a scratch, the tech's own
 * scan history is their defence, not the owner's audit. One tap on the asset
 * page builds this card as plain text for WhatsApp — asset, current state,
 * the last scan with its method said honestly, and how much photographic
 * evidence exists. The first tech who wins an argument with it makes every
 * tech in the warehouse scan voluntarily.
 *
 * PLAIN TEXT, LIKE THE PARCHI. The reader is a client or a production
 * coordinator on WhatsApp; formatting tricks do not survive a forward.
 *
 * HONEST TO A FAULT, because this card only works as an alibi if it never
 * overstates: an 'assumed' entry is named as taken on trust, zero photos says
 * 'no photos', and no scan history says so instead of implying a clean one.
 * The one time this card is caught claiming more than the phone knows, every
 * card after it is worthless.
 *
 * In a `.ts` module, like parchi.ts and session-summary.ts, so it runs under
 * plain Node in the tests. Pure: facts in, text out, no clock reads — the
 * caller passes timestamps, which is what makes the output deterministic.
 */
import { stamp } from './stamp.ts'

export interface ProveItScan {
  /** 'check_out' | 'check_in' | anything else the log holds. */
  eventType: string
  /** Device-clock epoch ms of the scan — labelled as this phone's record. */
  whenMs: number
  jobLabel: string | null
  /** 'scanned' | 'manual' | 'assumed' | ... — said plainly on the card. */
  entryMethod: string
}

export interface ProveItInput {
  /** The rental house's name — whose record this is. */
  houseName: string
  code: string
  name: string
  /** The asset page's status sentence — 'On the Wedding job · since …'. */
  statusLine: string
  /** The most recent scan of this asset in the local log, or null. */
  lastScan: ProveItScan | null
  /** Condition photos of this asset on this phone. */
  photoCount: number
}

const EVENT_PHRASE: Record<string, string> = {
  check_out: 'went out',
  check_in: 'came back',
}

const METHOD_PHRASE: Record<string, string> = {
  scanned: 'scanned on this phone',
  manual: 'typed in on this phone',
  // A belief must not read as an observation, even on the tech's own card —
  // ESPECIALLY there, because this card only works if it never overstates.
  assumed: 'taken on trust, not seen',
  implied: 'moved with its case',
}

export function buildProveIt(input: ProveItInput): string {
  const lines: string[] = []

  lines.push(`${input.code} — ${input.name}`)
  lines.push(input.statusLine)
  lines.push('')

  if (input.lastScan === null) {
    lines.push('No scan of this item recorded on this phone.')
  } else {
    const s = input.lastScan
    const what = EVENT_PHRASE[s.eventType] ?? s.eventType
    const how = METHOD_PHRASE[s.entryMethod] ?? s.entryMethod
    lines.push(
      `Last record: ${what} ${stamp(s.whenMs)}` +
        (s.jobLabel !== null ? ` on ${s.jobLabel}` : '') +
        ` — ${how}`,
    )
  }

  lines.push(
    input.photoCount === 0
      ? 'No condition photos on this phone.'
      : `${input.photoCount} condition photo${input.photoCount === 1 ? '' : 's'} on this phone.`,
  )

  lines.push('')
  lines.push(`From the ${input.houseName} scan log.`)

  return lines.join('\n')
}
