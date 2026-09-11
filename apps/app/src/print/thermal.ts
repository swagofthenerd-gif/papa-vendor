/**
 * The thermal printer seam.
 *
 * The parchi's bytes are built in @papa/core (escpos.ts — pure, golden-
 * tested). WHERE they go is a transport question this module owns: a
 * `ThermalPrinter` is anything that takes bytes and says whether they
 * printed. The Android build registers a Bluetooth SPP transport here
 * (the Capacitor wave — out of scope now, documented in docs/production-
 * readiness.md); the browser has none, so `thermalPrinter()` is null and
 * the screen says so honestly instead of pretending a print happened.
 *
 * DEV ONLY: in a Vite dev build with no transport, the bytes are offered
 * as a `.bin` download so the stream can be inspected (or piped to a
 * printer from a laptop with `cat parchi.bin > /dev/rfcomm0`). Never in
 * production — a download in a WebView is a dead end, not a print.
 */

export interface ThermalPrintResult {
  ok: boolean
  /** Why not, when not — a short machine word the screen translates. */
  reason?: string
}

export interface ThermalPrinter {
  print(bytes: Uint8Array): Promise<ThermalPrintResult>
}

let registered: ThermalPrinter | null = null

/** The Android build calls this once with its Bluetooth transport. */
export function registerThermalPrinter(printer: ThermalPrinter | null): void {
  registered = printer
}

/** The transport in play, or null — the honest "no printer connected". */
export function thermalPrinter(): ThermalPrinter | null {
  return registered
}

/** True in a Vite dev build only (import.meta.env.DEV is false in `vite build`). */
function isDev(): boolean {
  try {
    return Boolean((import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV)
  } catch {
    return false
  }
}

/**
 * Print, or say why not: the registered transport when there is one; in
 * dev with none, the `.bin` download; otherwise `no_printer`.
 */
export async function printThermal(bytes: Uint8Array, filename = 'parchi.bin'): Promise<ThermalPrintResult> {
  const printer = thermalPrinter()
  if (printer) {
    try {
      return await printer.print(bytes)
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }
  if (isDev() && typeof document !== 'undefined' && typeof URL !== 'undefined' && 'createObjectURL' in URL) {
    const blob = new Blob([bytes], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return { ok: true, reason: 'dev_download' }
  }
  return { ok: false, reason: 'no_printer' }
}
