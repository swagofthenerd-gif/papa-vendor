/**
 * Deterministic local timestamp — no locale, no timezone name, so the same
 * input always yields the same text (and, for the parchi, the same QR).
 *
 * Shared by the parchi (the gate pass) and the "prove it" alibi card, which
 * must stamp identically: both are plain-text records forwarded on WhatsApp,
 * and a client comparing two of them should never see two clocks.
 */
export function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}
