/**
 * The theft report — the police / insurance / partner-house card.
 *
 * When a client absconds with gear (the year's FEB, finding
 * `no-blacklist-or-theft-export`), the owner needs one forwardable block of
 * text that names the stolen item completely: serials and codes to identify
 * it, how many photos exist as proof, where and when it was last seen, and
 * who to contact. This is the export the year simulation had nothing for —
 * the money side became a legible write-off, but the Rs 2.6M of gear
 * appeared on no report at all.
 *
 * A BUILDER LIKE parchi.ts AND prove-it.ts. Pure — facts in, text out, no
 * clock read (the caller passes the last-seen instant) — so it renders the
 * same on an offline phone and in a golden test, and so it can be asserted
 * in BOTH languages: the words come from a labels bag (theftLabels(STR)),
 * the way balanceCardText takes khataLabels.
 *
 * PLAIN TEXT, because the reader is a police desk, an insurer or a rival
 * house's WhatsApp — never our app. What they see after a forward is the
 * report itself.
 */
import { stamp } from './stamp.ts'
import type { StrTable } from './strings.ts'

/** Every word this builder prints, resolved from the active string table by
 *  theftLabels(STR). A bag rather than a StrTable reference so the builder
 *  stays a pure @papa/core-style function with no import cycle into strings. */
export interface TheftLabels {
  heading: string
  stolenBanner: string
  codeLabel: string
  serialLabel: string
  noSerial: string
  photosLine: (n: number) => string
  lastSeenLabel: string
  lastSeenLine: (whenText: string, jobLabel: string | null) => string
  lastSeenUnknown: string
  contactLabel: string
  footer: (houseName: string) => string
}

export interface TheftReportItem {
  code: string | null
  name: string | null
  serial: string | null
}

export interface TheftReportInput {
  houseName: string
  /** The stolen item — code, product name, serial. */
  item: TheftReportItem
  /** How many condition photos exist on this phone — the proof count. */
  photoCount: number
  /** The last scan on record: when, and on which job. null when the item
   *  never scanned on this device. */
  lastSeen: { whenMs: number; jobLabel: string | null; place: string | null } | null
  /** The org's public contact line, or null when none is configured. */
  contactLine: string | null
}

/** The theft-report words from the active string table — the khataLabels
 *  pattern, a function of the table so tests render both languages. */
export function theftLabels(str: StrTable): TheftLabels {
  return {
    heading: str.fleetTheftHeading,
    stolenBanner: str.fleetTheftBanner,
    codeLabel: str.fleetTheftCodeLabel,
    serialLabel: str.fleetTheftSerialLabel,
    noSerial: str.fleetTheftNoSerial,
    photosLine: (n) => str.fleetTheftPhotos(n),
    lastSeenLabel: str.fleetTheftLastSeen,
    lastSeenLine: (when, jobLabel) => str.fleetTheftLastSeenLine(when, jobLabel),
    lastSeenUnknown: str.fleetTheftLastSeenUnknown,
    contactLabel: str.fleetTheftContact,
    footer: (houseName) => str.fleetTheftFooter(houseName),
  }
}

export function buildTheftReport(input: TheftReportInput, L: TheftLabels): string {
  const lines: string[] = []

  lines.push(`${L.heading} — ${input.houseName}`)
  lines.push(L.stolenBanner)
  lines.push('')

  const name = input.item.name ?? '—'
  const code = input.item.code ?? '—'
  lines.push(`${code}  ${name}`)
  lines.push(`${L.serialLabel}: ${input.item.serial ?? L.noSerial}`)
  lines.push(L.photosLine(input.photoCount))
  lines.push('')

  lines.push(`${L.lastSeenLabel}:`)
  if (input.lastSeen === null) {
    lines.push(L.lastSeenUnknown)
  } else {
    const when = stamp(input.lastSeen.whenMs)
    lines.push(L.lastSeenLine(when, input.lastSeen.jobLabel))
    if (input.lastSeen.place) lines.push(input.lastSeen.place)
  }

  if (input.contactLine) {
    lines.push('')
    lines.push(`${L.contactLabel}: ${input.contactLine}`)
  }

  lines.push('')
  lines.push(L.footer(input.houseName))

  return lines.join('\n')
}
