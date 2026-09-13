import { whatsAppNudgeUrl, whatsAppShareUrl } from '@papa/core'

/**
 * The app's one sharing rule: WhatsApp where it exists, clipboard where it
 * does not — and the app only DRAFTS; the send stays the owner's, because
 * the message's authority lives in who sent it.
 *
 * Every share in the app (the handover manifest, the balance reminder, the
 * escalation text, the quote, the partner asks) goes through here, so the
 * fallback pair has exactly one home. The url itself is core's (share.ts);
 * this is the browser half. With a `to` number (the digits-only form
 * parsePhoneNumber produces) the draft opens that thread; without one it
 * is the share-to-anyone link. The caller learns which way the text went, because a
 * clipboard fallback deserves a word on screen ("copied — paste it in")
 * where a WhatsApp window would have been its own confirmation.
 */
export function shareText(text: string, to?: string | null): 'whatsapp' | 'clipboard' {
  const url = to ? whatsAppNudgeUrl(to, text) : whatsAppShareUrl(text)
  const win = window.open(url, '_blank', 'noopener')
  if (win) return 'whatsapp'
  void navigator.clipboard?.writeText(text).catch(() => {})
  return 'clipboard'
}
