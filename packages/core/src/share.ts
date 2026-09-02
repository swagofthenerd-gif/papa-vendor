/**
 * Sharing.
 *
 * WhatsApp is the channel this market actually runs on: kit lists arrive as
 * WhatsApp messages (see kit-list.ts) and handover summaries go back the same
 * way. The url scheme IS the whole integration — no SDK, no API key, nothing
 * to expire — and wa.me without a number opens the sender's own chat picker,
 * which is exactly right: the vendor chooses the client thread, not us.
 *
 * The caller owns the fallback when WhatsApp is not installed (the demo
 * copies the text to the clipboard); this only builds the url, so it stays a
 * pure function the engine tests can pin down.
 */
export function whatsAppShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`
}

/**
 * Pull a Pakistani mobile number out of free text.
 *
 * `jobs.contact` is whatever got typed at the desk: "Bilal (prod) 0300
 * 4412233", "+92 300-4412233", sometimes a name and no number at all. This
 * finds a number the code can act on (a wa.me or tel: link) and normalises it
 * to digits-only international form: '923004412233'.
 *
 * CONFIDENT MATCHES ONLY. The accepted shapes are exactly the ways people
 * write a Pakistani mobile — 03XX XXXXXXX, +92 3XX XXXXXXX, 0092..., bare
 * 923XXXXXXXXX — with spaces and dashes tolerated inside. Anything else
 * (landlines, short codes, a digit soup of two numbers run together) returns
 * null, and the caller falls back to showing the raw contact text. A nudge
 * sent to a misparsed number goes to a stranger, politely, in the vendor's
 * name; null is cheaper.
 */
export function parsePhoneNumber(text: string | null | undefined): string | null {
  if (!text) return null

  // Candidate digit runs: digits possibly separated by spaces/dashes, with
  // an optional + or 00 prefix. Words, commas and brackets break a run, so
  // "Bilal (prod) 0300 4412233" yields one candidate: "0300 4412233".
  const runs = text.match(/(?:\+|00)?\d[\d\s-]*\d|\d/g)
  if (!runs) return null

  for (const run of runs) {
    const hadPlus = run.trimStart().startsWith('+')
    const digits = run.replace(/\D/g, '')

    // Reduce every accepted prefix down to the 10-digit local part (3XXXXXXXXX).
    let local: string | null = null
    if (digits.startsWith('0092')) local = digits.slice(4)
    else if (hadPlus && digits.startsWith('92')) local = digits.slice(2)
    else if (digits.startsWith('92') && digits.length === 12) local = digits.slice(2)
    else if (digits.startsWith('0') && digits.length === 11) local = digits.slice(1)

    // Pakistani mobiles are exactly 3 + nine digits. Wrong length or wrong
    // leading digit is not "close enough" — it is a different number.
    if (local !== null && /^3\d{9}$/.test(local)) return `92${local}`
  }

  return null
}

/**
 * Chat link straight to a specific number, message pre-filled. The number is
 * the digits-only form parsePhoneNumber produces; wa.me wants exactly that
 * (no +, no separators).
 */
export function whatsAppNudgeUrl(number: string, message: string): string {
  return `https://wa.me/${number}?text=${encodeURIComponent(message)}`
}

/** Dialer link for the same number. tel: wants the + back. */
export function telUrl(number: string): string {
  return `tel:+${number}`
}

/**
 * The overdue-nudge template, AS DATA.
 *
 * Roman Urdu with English gear terms is how this market actually texts (see
 * the review's lens-4 notes and docs/assumptions.md on language). The exact
 * wording is a guess a pilot vendor will want to edit, so it lives in one
 * exported constant with visible placeholders — changing the tone is a
 * one-line diff, not a code change.
 *
 * Deliberately polite and blame-free: the recipient is a repeat client and
 * the relationship outlives any single late tripod.
 */
export const OVERDUE_NUDGE_TEMPLATE =
  'Salam — {jobLabel} ka saman ({itemsSummary}) {dueLabel}. ' +
  'Jab convenient ho to please wapsi ka bata dijiye. Shukriya!'

/**
 * Fill the nudge template. `dueLabel` is the honest, locally computed label
 * from dueStatus() — 'due today', '3 days late', or 'no date' — so the
 * message never asserts a date the data cannot support.
 */
export function overdueNudgeMessage(input: {
  jobLabel: string
  itemsSummary: string
  dueLabel: string
}): string {
  return OVERDUE_NUDGE_TEMPLATE
    .replace('{jobLabel}', input.jobLabel)
    .replace('{itemsSummary}', input.itemsSummary)
    .replace('{dueLabel}', input.dueLabel)
}
