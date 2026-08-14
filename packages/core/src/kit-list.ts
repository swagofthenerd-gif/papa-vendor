/**
 * Reading a kit list pasted from WhatsApp.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * Every other WhatsApp path in this product sends information OUT. This is the
 * only one that brings it IN — and inbound is where the enquiry actually
 * arrives. A coordinator sends a kit list, and answering it today means
 * reading it, walking the shelves, checking what is already booked, and typing
 * a reply. Twenty minutes, at the moment the owner is already holding the
 * phone.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO AI HERE, DELIBERATELY
 *
 * A language model is the obvious tool and the wrong one:
 *   - it costs money on every paste, forever, against a ~$25/mo infra budget
 *   - it needs signal, and ~28% of Pakistani mobile users are on 2G
 *   - it is unauditable: when it turns "FX9" into the wrong body, nobody can
 *     say why, and the owner has quoted the wrong kit to a client
 *
 * A rental house's catalogue is a few hundred products and clients type the
 * same names over and over. Plain matching against their OWN catalogue runs on
 * the phone, offline, instantly, for nothing.
 *
 * ---------------------------------------------------------------------------
 * THE RULE THAT MATTERS: IT NEVER SILENTLY GUESSES
 *
 * A parser that quietly resolves "sachdeva" to the wrong tripod is worse than
 * one that asks, because the wrong answer leaves the building on a truck. So
 * every line carries its confidence, and anything short of a confident match
 * is returned as CANDIDATES for a human tap — never auto-applied.
 *
 * The failure mode we are protecting against is not "the parser missed one".
 * It is "the parser was confidently wrong and nobody looked".
 */

/** One line as the client wrote it, before any matching. */
export interface ParsedLine {
  /** The original text, kept verbatim so the UI can always show what was sent. */
  raw: string
  quantity: number
  /** The item text with quantity markers and noise stripped. */
  text: string
}

export interface CatalogueItem {
  id: string
  name: string
}

export type MatchConfidence = 'exact' | 'strong' | 'unsure' | 'none'

export interface MatchedLine extends ParsedLine {
  confidence: MatchConfidence
  /** Best match. Present for exact/strong; for `unsure` it is a suggestion only. */
  productId?: string
  productName?: string
  /** Alternatives worth offering. Populated when confidence is not `exact`. */
  candidates: CatalogueItem[]
}

/**
 * Noise words that carry no identity.
 *
 * `nos` and `pcs` are how quantities are written on a Lahore rental list;
 * `x` is the multiplication marker. Stripped so "2 nos tripod" and "tripod x2"
 * reduce to the same thing.
 */
const NOISE = new Set(['x', 'nos', 'no', 'pcs', 'pc', 'piece', 'pieces', 'qty', 'each', 'and'])

/**
 * Normalise for comparison.
 *
 * Case, punctuation and spacing all vary line to line and none of them carry
 * meaning. Accents are folded because a name may arrive either way and a
 * client should never be punished for typing it correctly.
 */
export function normalise(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !NOISE.has(w))
    .join(' ')
}

/**
 * Levenshtein distance, with an early exit.
 *
 * Hand-written because this package must run untranspiled under `node --test`
 * with no dependencies and no build step. Two rolling rows rather than a full
 * matrix: a few hundred products times a few dozen lines runs on a Rs 25,000
 * phone without a frame drop.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1

  let prev = new Array(b.length + 1)
  let curr = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    let rowBest = curr[0]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
      if (curr[j] < rowBest) rowBest = curr[j]
    }
    // Nothing in this row is within budget, so nothing below it can be either.
    if (rowBest > max) return max + 1
    const t = prev; prev = curr; curr = t
  }
  return prev[b.length]
}

/**
 * The same string with all spacing removed.
 *
 * Product names split unpredictably: a client writes "FX-9", "FX 9" or "FX9"
 * and means one camera. Punctuation is already gone by normalise, but the
 * SPACE it leaves behind still breaks the token, so "fx 9" scores nothing
 * against "fx9". Comparing the compact forms costs one string and removes an
 * entire class of false misses.
 */
export function compact(s: string): string {
  return s.replace(/\s+/g, '')
}

/** 0..1, where 1 is identical. Length-relative so a typo in a short word costs more. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  const longest = Math.max(a.length, b.length)
  if (longest === 0) return 1
  return 1 - editDistance(a, b) / longest
}

/**
 * Quantity, however it was written.
 *
 * Seen in the wild on one list: `2x FX9`, `FX9 x2`, `2 nos tripod`,
 * `(3) C-stands`, `4- batteries`, `Sony FX9 - 2`. All mean the same thing and
 * all must survive, because a wrong quantity is a wrong quote.
 *
 * Defaults to 1 rather than 0: a line that names an item means at least one of
 * it, and defaulting to 0 would silently drop items from a quote.
 */
function extractQuantity(line: string): { quantity: number; rest: string } {
  const patterns: Array<[RegExp, number]> = [
    [/^\s*\(?(\d{1,3})\)?\s*[xX*]\s+/, 1],        // 2x FX9   (2) x FX9
    [/^\s*\(?(\d{1,3})\)?\s*[-.)]\s+/, 1],        // 4- item   (3) item
    [/^\s*\(?(\d{1,3})\)?\s+(?=[a-zA-Z])/, 1],    // 2 tripods
    // The leading whitespace is LOAD-BEARING. Without it these match the
    // "x9" inside "FX9" and the "-9" inside "FX-9", and "Sony FX9" is read as
    // NINE of a product called "Sony F". Product names in this industry are
    // full of letter-digit pairs — FX9, C300, 600D — so this is the common
    // case, not an edge case. It was caught by a test asserting the most
    // ordinary line a client can send.
    [/\s[xX*]\s*(\d{1,3})\s*$/, 1],               // Tripod x2
    [/\s[-–]\s*(\d{1,3})\s*$/, 1],                // Sony FX9 - 2
  ]

  for (const [re] of patterns) {
    const m = line.match(re)
    if (m) {
      const n = parseInt(m[1], 10)
      // A "quantity" of 0 is a misread, not a request for none of it.
      if (n > 0 && n < 1000) {
        return { quantity: n, rest: line.replace(re, ' ') }
      }
    }
  }
  return { quantity: 1, rest: line }
}

/**
 * Lines that are conversation, not kit.
 *
 * A pasted WhatsApp block carries greetings, dates and "please confirm".
 * Dropping them keeps the review screen short enough to actually be read —
 * and a screen nobody reads is where a wrong match slips through.
 */
const CHATTER = new Set([
  'hi', 'hello', 'salam', 'assalam', 'alaikum', 'o', 'aoa', 'walaikum',
  'thanks', 'thank', 'you', 'shukriya', 'please', 'pls', 'kindly', 'confirm',
  'confirmation', 'availability', 'available', 'ok', 'okay', 'good', 'morning',
  'evening', 'regards', 'sir', 'madam', 'bhai', 'need', 'needed', 'require',
  'required', 'requirement', 'requirements', 'following', 'below', 'list',
  'kit', 'equipment', 'gear', 'for', 'on', 'at', 'the', 'is', 'are', 'we',
  'i', 'shoot', 'shooting', 'project', 'urgent', 'asap', 'send', 'quote',
])

/**
 * Whole-line chatter, decided token by token.
 *
 * Phrase matching was tried first and failed on the most common greeting in
 * the market — "Assalam o alaikum" never matches a fixed string list, because
 * people write it six different ways. A line is chatter when EVERY token is
 * chatter, which handles the variants without enumerating them.
 */
function isNoiseLine(text: string): boolean {
  const n = normalise(text)
  if (n.length === 0) return true

  const tokens = n.split(' ').filter(Boolean)
  return tokens.every(
    (t) =>
      CHATTER.has(t) ||
      /^\d+$/.test(t) ||                    // bare numbers
      /^\d+(st|nd|rd|th)$/.test(t) ||       // 14th
      /^\d{1,2}[\/.-]\d{1,2}/.test(t),     // dates
  )
}

/**
 * Split a pasted block into candidate item lines.
 *
 * Newlines first, then commas — a client may write one per line or all on one.
 * Bullets, dashes and numbering are stripped as decoration.
 */
export function parseKitList(text: string): ParsedLine[] {
  const out: ParsedLine[] = []

  for (const rawLine of text.split(/\r?\n/)) {
    // A leading "1." is numbering, not a quantity. Removed before the quantity
    // parser sees it, or every numbered list reads as one of each — which is
    // usually right by luck and silently wrong when it is not.
    const delisted = rawLine.replace(/^\s*\d{1,2}[.)]\s+/, '')

    // Only split on commas when the line looks like a list rather than a
    // sentence, so "Sony FX9, with batteries" is not torn in half.
    const parts = delisted.includes(',') && delisted.split(',').length <= 8
      ? delisted.split(',')
      : [delisted]

    for (const part of parts) {
      const cleaned = part.replace(/^[\s\-–—*•·]+/, '').trim()
      if (cleaned.length === 0 || isNoiseLine(cleaned)) continue

      const { quantity, rest } = extractQuantity(cleaned)
      const normalised = normalise(rest)
      if (normalised.length === 0) continue

      out.push({ raw: cleaned, quantity, text: normalised })
    }
  }

  return out
}

/**
 * Match parsed lines against the vendor's own catalogue.
 *
 * Three tiers, and the third is the important one:
 *   exact   — normalised strings are identical. Safe to apply.
 *   strong  — a typo, at most. Safe to apply, still shown.
 *   unsure  — plausible but not certain. NEVER applied; offered for a tap.
 *
 * The thresholds are deliberately conservative. A false `strong` puts the
 * wrong item on a truck; a false `unsure` costs one tap.
 */
export function matchKitList(
  lines: ParsedLine[],
  catalogue: CatalogueItem[],
  opts: { strong?: number; unsure?: number } = {},
): MatchedLine[] {
  const strongAt = opts.strong ?? 0.82
  const unsureAt = opts.unsure ?? 0.55

  const prepared = catalogue.map((c) => ({ item: c, key: normalise(c.name) }))

  return lines.map((line) => {
    const scored = prepared
      .map(({ item, key }) => {
        const r = scoreAgainst(line.text, key)
        return { item, score: r.score, specificity: r.specificity }
      })
      .sort((a, b) => b.score - a.score)

    const best = scored[0]

    if (!best || best.score < unsureAt) {
      return { ...line, confidence: 'none', candidates: scored.slice(0, 3).map((s) => s.item) }
    }

    // A near-tie is not a match, however high the score. Two products this
    // close means the client's words genuinely do not distinguish them, and
    // picking one would be a guess wearing a confidence value.
    const runnerUp = scored[1]
    const contested = runnerUp !== undefined && best.score - runnerUp.score < 0.06

    if (best.score >= 0.999 && !contested) {
      return {
        ...line,
        confidence: 'exact',
        productId: best.item.id,
        productName: best.item.name,
        candidates: [],
      }
    }

    // THE UNIQUENESS RULE — what makes real misspellings work.
    //
    // "Sachdeva Tripod" is four characters from "Sachtler Tripod", so raw
    // similarity alone leaves it below the bar. But the client named the WHOLE
    // product (specificity 1) and nothing else in the catalogue comes close.
    // A wide gap to the runner-up means the words are unambiguous even though
    // one is misspelt.
    //
    // Gated on specificity on purpose. "4 batteries" also has a wide gap, and
    // must NOT be promoted — it names one token of a three-token product, so
    // the client has not said which battery they mean. Uniqueness plus
    // vagueness is still vagueness.
    const gap = runnerUp === undefined ? 1 : best.score - runnerUp.score
    const unambiguous = best.score >= 0.7 && gap >= 0.2 && best.specificity >= 0.9

    if ((best.score >= strongAt || unambiguous) && !contested) {
      return {
        ...line,
        confidence: 'strong',
        productId: best.item.id,
        productName: best.item.name,
        candidates: scored.slice(1, 3).map((s) => s.item),
      }
    }

    return {
      ...line,
      confidence: 'unsure',
      productName: best.item.name,
      candidates: scored.slice(0, 3).map((s) => s.item),
    }
  })
}

/**
 * How well one line matches one catalogue name.
 *
 * Token-aware rather than whole-string, because word ORDER varies constantly —
 * "FX9 Sony" and "Sony FX9" are the same request — and because a client
 * usually types a fragment of the catalogue name rather than all of it.
 *
 * Each line token takes the best score it can find among the catalogue
 * tokens, so a typo costs a little and a missing word costs nothing.
 */
function scoreAgainst(lineText: string, catalogueKey: string): { score: number; specificity: number } {
  if (lineText === catalogueKey) return { score: 1, specificity: 1 }

  // Spacing differences are not real differences — see compact().
  if (compact(lineText) === compact(catalogueKey)) return { score: 1, specificity: 1 }

  const lineTokens = lineText.split(' ').filter(Boolean)
  const catTokens = catalogueKey.split(' ').filter(Boolean)
  if (lineTokens.length === 0 || catTokens.length === 0) return { score: 0, specificity: 0 }

  let total = 0
  for (const lt of lineTokens) {
    let best = 0
    for (const ct of catTokens) {
      // A short token needs to be near-perfect; "c3" and "c5" are different
      // products and are one edit apart.
      const s = lt.length <= 3 ? (lt === ct ? 1 : 0) : similarity(lt, ct)
      if (s > best) best = s
    }
    total += best
  }

  const coverage = total / lineTokens.length

  // How much of the catalogue name the client actually named. "battery"
  // against "v-mount battery" is a fragment; "sachdeva tripod" against
  // "sachtler tripod" is the whole thing, misspelt. That difference decides
  // whether a near-miss may be auto-applied — see matchKitList.
  const specificity = Math.min(1, lineTokens.length / catTokens.length)
  return { score: coverage * (0.75 + 0.25 * specificity), specificity }
}
