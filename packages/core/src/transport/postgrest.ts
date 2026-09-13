import type { PullPayload } from '../pull.ts'
import { TransportError, type SubmitResult, type Transport } from '../sync.ts'

/**
 * The PostgREST transport — the first thing in this codebase that speaks
 * to the real server (W9).
 *
 * fetch only. No SDK, no client library, nothing that could become the data
 * layer (CONTRIBUTING, "Staying portable"): every call is `POST
 * ${baseUrl}/rpc/${name}` with a JSON body of named arguments, which is
 * what any gateway in front of Postgres can offer. Identity travels in ONE
 * header, `x-papa-session`, which the server's db-pre-request hook
 * (0016 auth_pre_request) turns into the papa.* context. Never a JWT: a
 * request carrying both would speak as the JWT (docs/auth-design.md, open
 * question 1).
 *
 * THE ERROR MAPPING IS THE CONTRACT. The flush loop (sync.ts) parks an op
 * only on a non-retryable error and backs off on a retryable one, and
 * getting that wrong is expensive in both directions. So:
 *
 *   - the network failed, the request timed out, the gateway answered 5xx
 *     with no Postgres code, 429, 408 → retryable; the op is innocent;
 *   - Postgres answered with an SQLSTATE → its CLASS decides: 08 (connection),
 *     53 (insufficient resources — 53300 is the DB's own rate limiter, which
 *     says "wait", not "never"), 57 (operator intervention), 58 (system),
 *     XX (internal) are retryable; everything else — 23P01 the collision,
 *     28000 the dead session, 42501 the role refusal, P0001 a raised rule —
 *     is a verdict, and resending will not change it;
 *   - the SQLSTATE rides on the error as `code`, the server's message as
 *     `message`, and a `client_seq` named in the details or the message as
 *     `clientSeq`, so the loop can park exactly the op the server refused.
 */

export interface PostgrestTransportOptions {
  /** e.g. http://localhost:3050 — no trailing slash needed. */
  baseUrl: string
  /** Supabase-style gateways want an apikey header; plain PostgREST does not. */
  anonKey?: string
  /** The device session token, or null before enrolment. Read per request,
   *  so a switch or a sign-out is seen by the very next call. */
  sessionToken: () => string | null
  fetch?: typeof fetch
  /** Per request. Long enough for a 2000-row first sync over 3G. */
  timeoutMs?: number
}

/** PostgREST's error body, when it sends one. */
export interface PostgrestErrorBody {
  code?: string
  message?: string
  details?: string | null
  hint?: string | null
}

/** SQLSTATE classes that mean "the server had a moment", not "no". */
const RETRYABLE_SQLSTATE_CLASSES = new Set(['08', '53', '57', '58', 'XX'])

export class PostgrestTransport implements Transport {
  private readonly baseUrl: string
  private readonly anonKey: string | undefined
  private readonly sessionToken: () => string | null
  private readonly fetchImpl: typeof fetch
  private readonly timeoutMs: number

  constructor(opts: PostgrestTransportOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.anonKey = opts.anonKey
    this.sessionToken = opts.sessionToken
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.timeoutMs = opts.timeoutMs ?? 20_000
  }

  /** Call one RPC by name with named arguments. */
  async rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json',
    }
    if (this.anonKey) headers.apikey = this.anonKey
    const token = this.sessionToken()
    if (token) headers['x-papa-session'] = token

    const controller = typeof AbortController === 'function' ? new AbortController() : null
    const timer = controller ? setTimeout(() => controller.abort(), this.timeoutMs) : null

    let response: Response
    try {
      response = await this.fetchImpl(`${this.baseUrl}/rpc/${name}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(args),
        signal: controller?.signal,
      })
    } catch (err) {
      if (timer) clearTimeout(timer)
      const aborted = err instanceof Error && err.name === 'AbortError'
      throw new TransportError(
        aborted ? `timeout after ${this.timeoutMs}ms` : (err instanceof Error ? err.message : String(err)),
        aborted ? 'timeout' : 'network',
        true,
      )
    }
    if (timer) clearTimeout(timer)

    const text = await response.text()
    if (response.ok) {
      // A void function answers 204 with an empty body; `null` is the honest
      // value for "nothing was returned".
      return (text.length === 0 ? null : JSON.parse(text)) as T
    }
    throw errorFrom(response.status, text)
  }

  submitScanBatch(deviceId: string, ops: unknown[]): Promise<SubmitResult[]> {
    return this.rpc<SubmitResult[]>('submit_scan_batch', { p_device_id: deviceId, p_ops: ops })
  }

  pull(cursor: number, limit = 2000): Promise<PullPayload> {
    return this.rpc<PullPayload>('pull_changes', { p_since: cursor, p_limit: limit })
  }
}

/**
 * Turn a non-2xx answer into a TransportError. Exported so the error rule
 * can be tested without a socket.
 */
export function errorFrom(status: number, bodyText: string): TransportError {
  let body: PostgrestErrorBody = {}
  try {
    const parsed = JSON.parse(bodyText) as unknown
    if (parsed && typeof parsed === 'object') body = parsed as PostgrestErrorBody
  } catch {
    // Not JSON — a gateway page, an empty body. The status decides.
  }

  const code = typeof body.code === 'string' && body.code.length > 0 ? body.code : `http_${status}`
  const message = typeof body.message === 'string' && body.message.length > 0
    ? body.message
    : (bodyText.length > 0 ? bodyText.slice(0, 200) : `HTTP ${status}`)

  const retryable = isRetryable(status, body.code)
  const clientSeq = retryable ? null : clientSeqNamedIn(body)
  return new TransportError(message, code, retryable, clientSeq)
}

function isRetryable(status: number, sqlstate: string | undefined): boolean {
  if (typeof sqlstate === 'string' && /^[0-9A-Z]{5}$/.test(sqlstate)) {
    return RETRYABLE_SQLSTATE_CLASSES.has(sqlstate.slice(0, 2))
  }
  // PostgREST's own codes (PGRST…) and code-less answers: the status decides.
  return status >= 500 || status === 429 || status === 408
}

/**
 * The client_seq the server named, if it named one. Looked for in the
 * details first (where the DB layer puts structured hints), then the
 * message, as either JSON or the words `client_seq <n>`.
 */
function clientSeqNamedIn(body: PostgrestErrorBody): number | null {
  for (const field of [body.details, body.message, body.hint]) {
    if (typeof field !== 'string') continue
    try {
      const parsed = JSON.parse(field) as { client_seq?: unknown }
      if (typeof parsed.client_seq === 'number' && Number.isFinite(parsed.client_seq)) return parsed.client_seq
    } catch {
      // Not JSON.
    }
    const m = /client_seq\D{0,4}(\d+)/.exec(field)
    if (m) return Number(m[1])
  }
  return null
}
