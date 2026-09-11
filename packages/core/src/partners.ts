/**
 * The partner network's two broadcasts — text that LEAVES the app on
 * WhatsApp, in the share.ts / ledger.ts tradition: pure builders, facts
 * in, one forwardable block out, no clock reads, both languages inline
 * (this is content the vendor sends, not chrome the app shows, so it lives
 * beside OVERDUE_NUDGE_TEMPLATE rather than in the string tables).
 *
 * ASK THE MARKET (0025 / vendor-dream-plan E1). A kit list is short — the
 * shelf cannot fill it, or the calendar already spoke for it — and the
 * desk's next move in Lahore is a WhatsApp to the other houses: "koi FX9
 * hai, Sat se Mon?". This builds that message from the shortage lines so
 * the desk sends one honest, complete ask instead of five half-typed ones.
 *
 * THE STOLEN BROADCAST (0025 D9). The client-facing theft report
 * (apps/app/src/theft-report.ts) is the police / insurance card; this is
 * the PARTNER-facing line for the houses' group — short, Roman Urdu
 * first, with the public tag page when the org has one. The server's
 * stolen_broadcast_text composes the same sentence; keeping the shape
 * here lets the phone build it offline from the mirror and the settings.
 */

export type BroadcastLang = 'en' | 'ur'

export interface ShortageLine {
  productName: string
  qty: number
  /** The asked-for window, epoch ms, '[)'. */
  fromMs: number
  untilMs: number
}

export interface BroadcastOrg {
  name: string
  /** The org's public number, or null — the text then says 'reply here'. */
  phone: string | null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** 'Sat 21 Nov' — the calendar's short date voice, local time. */
function dayLabel(ms: number): string {
  const d = new Date(ms)
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`
}

/** 'Sat 21 Nov – Mon 23 Nov', or one day when the window is inside it. */
export function windowLabel(fromMs: number, untilMs: number): string {
  const a = dayLabel(fromMs)
  // '[)': a window ending at midnight names the day before as its last.
  const b = dayLabel(Math.max(fromMs, untilMs - 1))
  return a === b ? a : `${a} – ${b}`
}

/**
 * The ask. One line per shortage, then how to answer. The house name is
 * the letterhead, because in a partner group of twelve houses the
 * sender's name is what gets the message read.
 */
export function askTheMarketText(
  shortage: ShortageLine[],
  org: BroadcastOrg,
  lang: BroadcastLang,
): string {
  const lines: string[] = []
  const reply = org.phone ?? null
  if (lang === 'ur') {
    lines.push(`${org.name} — kuch gear chahiye`)
    lines.push('')
    for (const s of shortage) {
      lines.push(`${s.qty} x ${s.productName} · ${windowLabel(s.fromMs, s.untilMs)}`)
    }
    lines.push('')
    lines.push(
      reply
        ? `Agar kisi ke paas ho to ${reply} par bata dein. Shukriya.`
        : 'Agar kisi ke paas ho to yahin reply kar dein. Shukriya.',
    )
  } else {
    lines.push(`${org.name} — looking for gear`)
    lines.push('')
    for (const s of shortage) {
      lines.push(`${s.qty} x ${s.productName} · ${windowLabel(s.fromMs, s.untilMs)}`)
    }
    lines.push('')
    lines.push(
      reply
        ? `If you have it, please let us know on ${reply}. Thank you.`
        : 'If you have it, please reply here. Thank you.',
    )
  }
  return lines.join('\n')
}

/** The facts stolen_broadcast_text (0025 D9) returns, as the phone holds
 *  them: the mirror's unit facts plus the two org settings. */
export interface StolenBroadcastFacts {
  assetCode: string | null
  serialNumber: string | null
  productName: string | null
  tagCode: string | null
  /** settings.public_tag_url_base + tag code, or null when either is
   *  missing (ASSUMPTION #public-tag-url). */
  publicUrl: string | null
  orgName: string
  orgPhone: string | null
}

/**
 * The partner-group line for a stolen unit. Short on purpose — the
 * group's language first, the other second, the link last when there is
 * one. The same sentence the server composes, so a desk that pastes from
 * either source sends one message, not two spellings of it.
 */
export function stolenBroadcastText(facts: StolenBroadcastFacts, lang: BroadcastLang): string {
  const item = facts.productName ?? 'item'
  const serial = facts.serialNumber ? `, serial ${facts.serialNumber}` : ''
  const tag = facts.tagCode ? `, tag ${facts.tagCode}` : ''
  const code = facts.assetCode ? ` (${facts.assetCode})` : ''
  const ur =
    `Yeh ${facts.orgName} ka saman hai aur chori ho gaya hai.` +
    ` Agar koi bechne ya rent par dene aaye to please${facts.orgPhone ? ` ${facts.orgPhone}` : ' humein'} par call karein.`
  const en =
    `This item was stolen from ${facts.orgName}.` +
    ` If you are offered it, please call${facts.orgPhone ? ` ${facts.orgPhone}` : ' us'}.`
  const head = `CHORI / STOLEN — ${item}${code}${serial}${tag}.`
  const body = lang === 'ur' ? `${ur} / ${en}` : `${en} / ${ur}`
  return `${head} ${body}${facts.publicUrl ? ` ${facts.publicUrl}` : ''}`
}
