import type { SqlDriver } from './db/driver.ts'
import { metaGet, metaSet } from './meta.ts'
import { TransportError } from './sync.ts'
import { PullApplier } from './pull.ts'

/**
 * Auth on the phone (W9) — the client half of docs/auth-design.md.
 *
 * One SMS per person per device, ever: `enrol` calls complete_enrolment with
 * the code the owner had sent, and the 32-byte session token the server
 * returns ONCE is kept in sync_meta as `session_token`. From then on every
 * request carries it (transport/postgrest.ts) and the server's pre-request
 * hook turns it into the papa.* context. SQLCipher at rest is the device-
 * driver wave's job; the browser demo build keeps the token in memory and
 * says so.
 *
 * THE SHARED PHONE. The device is the unit of custody, the PIN decides the
 * person: `pinSwitch` calls switch_session_user, which repoints the session
 * at another member after their PIN verifies SERVER-SIDE (the 5/min lockout
 * lives there). Offline, the phone cannot ask — so after every server-
 * verified PIN it keeps an ECHO, sha256(device id : user id : pin), and the
 * PIN gate checks that when the network is down. Advisory by design: the
 * server stamps every batch with the session's user when it finally
 * arrives, so a wrong echo can mislabel nothing the server accepts.
 * ASSUMPTION: the offline echo is enough of a gate for a warehouse phone.
 * See docs/assumptions.md#pin-echo
 *
 * SIGN OUT is refused while the outbox holds anything: a scan captured on
 * this phone exists nowhere else until the server has it, and signing out
 * would strand it (principle 3). Once the queue is empty, sign_out_device
 * revokes the session and the phone forgets the org's data — mirrors, map,
 * session — keeping only its own device id.
 */

export const SESSION_KEYS = {
  token: 'session_token',
  sessionId: 'session_id',
  orgId: 'session_org_id',
  userId: 'session_user_id',
  deviceId: 'device_id',
  deviceLabel: 'device_label',
  role: 'session_role',
  displayName: 'session_user_name',
  expiresAt: 'session_expires_at',
  serverUrl: 'server_url',
  lastUserId: 'last_user_id',
} as const

/** The server's auth_session_result (0016), as JSON. */
export interface AuthSessionResult {
  token: string | null
  session_id: string | null
  org_id: string | null
  user_id: string | null
  device_id: string | null
  role: string | null
  display_name: string | null
  expires_at: string | null
}

export interface RpcCaller {
  rpc<T>(name: string, args: Record<string, unknown>): Promise<T>
}

export interface Session {
  token: string
  orgId: string
  userId: string
  deviceId: string
  role: string
  displayName: string
  expiresAt: string | null
  serverUrl: string | null
}

/** The live session on this phone, or null. */
export function sessionOf(db: SqlDriver): Session | null {
  const token = metaGet(db, SESSION_KEYS.token)
  if (!token) return null
  return {
    token,
    orgId: metaGet(db, SESSION_KEYS.orgId) ?? '',
    userId: metaGet(db, SESSION_KEYS.userId) ?? '',
    deviceId: metaGet(db, SESSION_KEYS.deviceId) ?? '',
    role: metaGet(db, SESSION_KEYS.role) ?? '',
    displayName: metaGet(db, SESSION_KEYS.displayName) ?? '',
    expiresAt: metaGet(db, SESSION_KEYS.expiresAt) ?? null,
    serverUrl: metaGet(db, SESSION_KEYS.serverUrl) ?? null,
  }
}

/** The device's own id, minted once and kept for the life of the install. */
export function ensureDeviceId(db: SqlDriver, mint: () => string = () => crypto.randomUUID()): string {
  const existing = metaGet(db, SESSION_KEYS.deviceId)
  if (existing) return existing
  const id = mint()
  metaSet(db, SESSION_KEYS.deviceId, id)
  return id
}

export interface EnrolInput {
  phone: string
  code: string
  deviceId: string
  deviceLabel: string
  pin?: string | null
  orgSlug?: string | null
  /** Remembered so the transport can be rebuilt on the next open. */
  serverUrl?: string | null
}

export type EnrolResult =
  | { ok: true; session: Session }
  /** Wrong or expired code, or a phone nobody invited — one face, on purpose. */
  | { ok: false; reason: 'bad_code' }
  /** This phone belongs to two houses: ask which, resend with orgSlug. */
  | { ok: false; reason: 'ambiguous_org' }
  | { ok: false; reason: 'bad_pin' }
  | { ok: false; reason: 'offline' }
  | { ok: false; reason: 'refused'; message: string }

export async function enrol(db: SqlDriver, rpc: RpcCaller, input: EnrolInput): Promise<EnrolResult> {
  let res: AuthSessionResult
  try {
    res = await rpc.rpc<AuthSessionResult>('complete_enrolment', {
      p_phone: input.phone,
      p_code: input.code,
      p_device_id: input.deviceId,
      p_device_label: input.deviceLabel,
      p_pin: input.pin ?? null,
      p_org_slug: input.orgSlug ?? null,
    })
  } catch (err) {
    return enrolFailure(err)
  }
  if (!res || !res.token) return { ok: false, reason: 'bad_code' }

  const session: Session = {
    token: res.token,
    orgId: res.org_id ?? '',
    userId: res.user_id ?? '',
    deviceId: res.device_id ?? input.deviceId,
    role: res.role ?? '',
    displayName: res.display_name ?? '',
    expiresAt: res.expires_at,
    serverUrl: input.serverUrl ?? null,
  }
  db.transaction(() => {
    storeSession(db, session, res.session_id)
    metaSet(db, SESSION_KEYS.deviceLabel, input.deviceLabel)
    metaSet(db, SESSION_KEYS.lastUserId, session.userId)
    metaSet(db, 'session_dead', '')
  })
  if (input.pin) await rememberPinEcho(db, session.deviceId, session.userId, input.pin)
  return { ok: true, session }
}

function enrolFailure(err: unknown): EnrolResult {
  if (err instanceof TransportError) {
    if (err.retryable) return { ok: false, reason: 'offline' }
    if (err.code === '22023' && /more than one organisation/i.test(err.message)) {
      return { ok: false, reason: 'ambiguous_org' }
    }
    if (err.code === '22023' && /PIN/i.test(err.message)) return { ok: false, reason: 'bad_pin' }
    return { ok: false, reason: 'refused', message: err.message }
  }
  return { ok: false, reason: 'refused', message: err instanceof Error ? err.message : String(err) }
}

function storeSession(db: SqlDriver, s: Session, sessionId: string | null): void {
  metaSet(db, SESSION_KEYS.token, s.token)
  metaSet(db, SESSION_KEYS.sessionId, sessionId ?? '')
  metaSet(db, SESSION_KEYS.orgId, s.orgId)
  metaSet(db, SESSION_KEYS.userId, s.userId)
  metaSet(db, SESSION_KEYS.deviceId, s.deviceId)
  metaSet(db, SESSION_KEYS.role, s.role)
  metaSet(db, SESSION_KEYS.displayName, s.displayName)
  metaSet(db, SESSION_KEYS.expiresAt, s.expiresAt ?? '')
  if (s.serverUrl) metaSet(db, SESSION_KEYS.serverUrl, s.serverUrl)
}

export type PinSwitchResult =
  | { ok: true; userId: string; verifiedBy: 'server' | 'echo' }
  | { ok: false; reason: 'wrong_pin' }
  /** Offline and this person's PIN has never been verified on this phone. */
  | { ok: false; reason: 'offline_unknown' }
  | { ok: false; reason: 'locked_out' }
  | { ok: false; reason: 'refused'; message: string }

/**
 * Hand the phone to another member. Server first; the echo when the
 * server cannot be reached. A server-verified PIN refreshes the echo.
 */
export async function pinSwitch(
  db: SqlDriver,
  rpc: RpcCaller,
  userId: string,
  pin: string,
  opts: { online?: boolean } = {},
): Promise<PinSwitchResult> {
  const session = sessionOf(db)
  if (!session) return { ok: false, reason: 'refused', message: 'no session on this phone' }

  const finish = async (verifiedBy: 'server' | 'echo'): Promise<PinSwitchResult> => {
    const member = db.get<{ display_name: string; role: string }>(
      `select display_name, role from members where id = ?`, [userId],
    )
    db.transaction(() => {
      metaSet(db, SESSION_KEYS.userId, userId)
      metaSet(db, SESSION_KEYS.lastUserId, userId)
      if (member) {
        metaSet(db, SESSION_KEYS.displayName, member.display_name)
        metaSet(db, SESSION_KEYS.role, member.role)
      }
    })
    if (verifiedBy === 'server') await rememberPinEcho(db, session.deviceId, userId, pin)
    return { ok: true, userId, verifiedBy }
  }

  if (opts.online !== false) {
    try {
      const ok = await rpc.rpc<boolean>('switch_session_user', { p_user_id: userId, p_pin: pin })
      if (ok === true) return finish('server')
      return { ok: false, reason: 'wrong_pin' }
    } catch (err) {
      if (err instanceof TransportError && !err.retryable) {
        if (err.code === '53300') return { ok: false, reason: 'locked_out' }
        return { ok: false, reason: 'refused', message: err.message }
      }
      // Network: fall through to the echo.
    }
  }

  const echo = metaGet(db, echoKey(userId))
  if (!echo) return { ok: false, reason: 'offline_unknown' }
  return (await pinEcho(session.deviceId, userId, pin)) === echo
    ? finish('echo')
    : { ok: false, reason: 'wrong_pin' }
}

export type SignOutResult =
  | { ok: true }
  /** The queue is not empty: signing out would strand what is in it. */
  | { ok: false; reason: 'unsent'; pending: number }
  | { ok: false; reason: 'offline' }
  | { ok: false; reason: 'refused'; message: string }

/**
 * Retire this phone's session and forget the org. Refused while anything
 * is queued; the server call must succeed (revocation is real, or it is
 * not a sign-out).
 */
export async function signOut(db: SqlDriver, rpc: RpcCaller): Promise<SignOutResult> {
  const pending = db.get<{ n: number }>(
    `select count(*) as n from outbox where state in ('pending', 'inflight')`,
  )?.n ?? 0
  if (pending > 0) return { ok: false, reason: 'unsent', pending }
  try {
    await rpc.rpc<null>('sign_out_device', {})
  } catch (err) {
    if (err instanceof TransportError && err.retryable) return { ok: false, reason: 'offline' }
    // A session the server already killed is signed out by any measure.
    if (!(err instanceof TransportError && (err.code === '28000' || err.code === '42501'))) {
      return { ok: false, reason: 'refused', message: err instanceof Error ? err.message : String(err) }
    }
  }
  forgetSession(db)
  return { ok: true }
}

/**
 * Wipe the org's data and the session, keeping the device's own id. The
 * outbox is untouched on purpose (resetMirrors' rule) — callers refuse
 * before this while it holds anything.
 */
export function forgetSession(db: SqlDriver): void {
  db.transaction(() => {
    new PullApplier(db).resetMirrors()
    db.exec(`delete from id_map`)
    db.exec(`delete from outbox where state = 'failed'`)
    db.exec(
      `delete from sync_meta where key in (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          or key like 'pin_echo:%'`,
      [
        SESSION_KEYS.token, SESSION_KEYS.sessionId, SESSION_KEYS.orgId, SESSION_KEYS.userId,
        SESSION_KEYS.role, SESSION_KEYS.displayName, SESSION_KEYS.expiresAt, SESSION_KEYS.lastUserId,
        'last_pull_at', 'last_flush_at', 'last_error', 'last_error_at', 'session_dead',
      ],
    )
  })
}

// ------------------------------------------------------------ the echo

const echoKey = (userId: string): string => `pin_echo:${userId}`

/** sha256 hex of device:user:pin — WebCrypto, available in Node and the WebView. */
export async function pinEcho(deviceId: string, userId: string, pin: string): Promise<string> {
  const bytes = new TextEncoder().encode(`${deviceId}:${userId}:${pin}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

export async function rememberPinEcho(db: SqlDriver, deviceId: string, userId: string, pin: string): Promise<void> {
  metaSet(db, echoKey(userId), await pinEcho(deviceId, userId, pin))
}

/** Whether the PIN gate can be answered offline for this person. */
export function hasPinEcho(db: SqlDriver, userId: string): boolean {
  return Boolean(metaGet(db, echoKey(userId)))
}

/**
 * Whether the gate should show on open: a session exists, and the person
 * who last held the phone has a PIN (shared-phone model). No PIN → the
 * phone opens as them.
 */
export function needsPinGate(db: SqlDriver): boolean {
  const session = sessionOf(db)
  if (!session) return false
  const last = metaGet(db, SESSION_KEYS.lastUserId) ?? session.userId
  const member = db.get<{ has_pin: number }>(`select has_pin from members where id = ?`, [last])
  return Number(member?.has_pin ?? 0) === 1
}
