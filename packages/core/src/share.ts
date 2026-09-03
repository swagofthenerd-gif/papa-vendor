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
