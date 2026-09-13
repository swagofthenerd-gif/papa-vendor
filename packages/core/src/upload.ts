import type { SqlDriver } from './db/driver.ts'

/**
 * The upload seam (W9) — draining pending_uploads to wherever the bytes
 * live for real.
 *
 * WHERE is not decided here. A condition photo's storage key is opaque
 * (`photos/<sha>/…`, CONTRIBUTING: never a vendor-signed URL in the data);
 * turning a key into a place to PUT bytes is hosting-specific — an R2
 * signed URL from a worker, a Supabase Storage URL, a plain server. So the
 * URL provider is injected: `getUploadUrl(targetPath)` answers with a URL
 * and headers, and this class does the one thing every host shares — send
 * the bytes, and mark the evidence uploaded only when the host said 2xx.
 *
 * NEVER EVICT. A failed upload bumps `attempts` and stays `pending`; there
 * is no attempt ceiling and no 'failed' state, because the row IS the
 * evidence and a photo the host refused today is a photo the host takes
 * tomorrow. The capture side already refuses new photos when the cache is
 * full (photos.ts); this side only ever moves rows forward.
 *
 * `wifi_only` rows wait for `{ wifi: true }`. Default off in this market
 * (schema.ts explains); honoured when set.
 */

export interface UploadTarget {
  url: string
  headers?: Record<string, string>
  /** PUT is what a signed URL wants; POST for a plain endpoint. */
  method?: 'PUT' | 'POST'
}

export interface UploaderOptions {
  getUploadUrl: (targetPath: string, row: PendingUploadRow) => Promise<UploadTarget>
  fetch?: typeof fetch
  /** Bytes for a local_uri. The default decodes data: URIs, which is what
   *  the browser build stores; the Android build injects a file reader. */
  readBytes?: (localUri: string) => Promise<Uint8Array>
}

export interface PendingUploadRow {
  id: string
  local_uri: string
  target_path: string
  sha256: string | null
  bytes: number | null
  state: string
  attempts: number
  wifi_only: number
  created_at: number
}

export interface UploadReport {
  /** Rows tried this drain. */
  tried: number
  uploaded: number
  /** Rows that stay pending with one more attempt on them. */
  deferred: number
  /** wifi_only rows skipped because this is not wifi. */
  waitingForWifi: number
  errors: string[]
}

export class Uploader {
  private readonly db: SqlDriver
  private readonly getUploadUrl: UploaderOptions['getUploadUrl']
  private readonly fetchImpl: typeof fetch
  private readonly readBytes: (localUri: string) => Promise<Uint8Array>

  constructor(db: SqlDriver, opts: UploaderOptions) {
    this.db = db
    this.getUploadUrl = opts.getUploadUrl
    this.fetchImpl = opts.fetch ?? globalThis.fetch
    this.readBytes = opts.readBytes ?? decodeDataUri
  }

  pendingCount(): number {
    return this.db.get<{ n: number }>(
      `select count(*) as n from pending_uploads where state = 'pending'`,
    )?.n ?? 0
  }

  /** Send up to `limit` pending rows, oldest first. */
  async drain(limit = 10, opts: { wifi?: boolean } = {}): Promise<UploadReport> {
    const report: UploadReport = { tried: 0, uploaded: 0, deferred: 0, waitingForWifi: 0, errors: [] }
    const rows = this.db.all<PendingUploadRow>(
      `select * from pending_uploads where state = 'pending' order by created_at, id limit ?`,
      [limit],
    )
    for (const row of rows) {
      if (row.wifi_only === 1 && !opts.wifi) { report.waitingForWifi++; continue }
      report.tried++
      try {
        const target = await this.getUploadUrl(row.target_path, row)
        const bytes = await this.readBytes(row.local_uri)
        const response = await this.fetchImpl(target.url, {
          method: target.method ?? 'PUT',
          headers: target.headers ?? {},
          body: bytes as BodyInit,
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        this.markUploaded(row.id)
        report.uploaded++
      } catch (err) {
        this.db.exec(`update pending_uploads set attempts = attempts + 1 where id = ?`, [row.id])
        report.deferred++
        report.errors.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    return report
  }

  /**
   * The host has the bytes: the queue row is done and the evidence row
   * says uploaded. One transaction — a photo must never read as uploaded
   * while its queue row would send it again, nor the reverse.
   */
  private markUploaded(id: string): void {
    this.db.transaction(() => {
      this.db.exec(`update pending_uploads set state = 'uploaded' where id = ?`, [id])
      this.db.exec(`update condition_photos set uploaded = 1 where id = ?`, [id])
      this.db.exec(`update voice_notes set uploaded = 1 where id = ?`, [id])
    })
  }
}

/** data:<mime>;base64,<payload> → bytes. Anything else is not for this reader. */
export async function decodeDataUri(uri: string): Promise<Uint8Array> {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(uri)
  if (!m) throw new Error('not a data: URI; inject readBytes for file paths')
  const payload = m[3] ?? ''
  if (!m[2]) return new TextEncoder().encode(decodeURIComponent(payload))
  const bin = typeof atob === 'function' ? atob(payload) : Buffer.from(payload, 'base64').toString('binary')
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
