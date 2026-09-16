import { Capacitor, registerPlugin } from '@capacitor/core'
import { getSetting, setSetting } from '../demo/khata.ts'
import type { SqlDriver } from '@papa/core'
import { registerThermalPrinter, type ThermalPrintResult, type ThermalPrinter } from './thermal.ts'

/**
 * The Bluetooth transport behind `ThermalPrinter` (W12).
 *
 * thermal.ts owns the SEAM — "a ThermalPrinter is anything that takes bytes
 * and says whether they printed" — and @papa/core's escpos.ts owns the
 * BYTES. This module owns neither: it is the wire between them on Android,
 * and it is the whole of what the browser does not have.
 *
 * WHY AN ASYNC PLUGIN HERE AND A SYNCHRONOUS BRIDGE FOR THE DATABASE. The
 * database had to be `@JavascriptInterface` because SqlDriver is
 * synchronous and a scan may not await (CONTRIBUTING principle 1). Printing
 * is nowhere near the scan path: the desk is standing at a till, the bytes
 * are already built, and a Bluetooth connect genuinely takes seconds. So
 * this is an ordinary Capacitor plugin — async by construction, and it gets
 * Capacitor's permission plumbing for nothing.
 *
 * THE CHOSEN PRINTER IS A SETTING, NOT A SCAN. A house has one till printer
 * and pairs it once; asking which device to use on every parchi would be a
 * dialog between a person and a queue of customers. The MAC lives in
 * `app_settings` like the payment line does, and Settings → Printer is where
 * it is chosen and tested.
 */

/** One paired device, as the Settings picker shows it. */
export interface PairedPrinter {
  name: string
  mac: string
}

interface PapaPrintPlugin {
  list(): Promise<{ devices: PairedPrinter[] }>
  print(options: { mac: string; bytes: string }): Promise<{ ok: boolean; bytes: number }>
}

const PapaPrint = registerPlugin<PapaPrintPlugin>('PapaPrint')

/** The remembered printer's MAC, and the name to show beside it. */
const PRINTER_MAC_KEY = 'printer_mac'
const PRINTER_NAME_KEY = 'printer_name'

export interface ChosenPrinter {
  mac: string
  name: string
}

export function chosenPrinter(db: SqlDriver): ChosenPrinter | null {
  const mac = getSetting(db, PRINTER_MAC_KEY)
  if (!mac) return null
  return { mac, name: getSetting(db, PRINTER_NAME_KEY) ?? mac }
}

export function choosePrinter(db: SqlDriver, printer: ChosenPrinter | null): void {
  setSetting(db, PRINTER_MAC_KEY, printer?.mac ?? null)
  setSetting(db, PRINTER_NAME_KEY, printer?.name ?? null)
}

/** True where a Bluetooth printer can exist at all. The browser: never. */
export function canPrintOverBluetooth(): boolean {
  return Capacitor.isNativePlatform()
}

/**
 * The paired devices.
 *
 * Paired, not scanned: a till printer is paired once in Android's own
 * Bluetooth settings, by someone who can see the PIN sticker on it. A
 * discovery scan inside this app would be a second, worse pairing flow.
 */
export async function pairedPrinters(): Promise<PairedPrinter[]> {
  const answer = await PapaPrint.list()
  return answer.devices ?? []
}

/**
 * Base64, without a FileReader.
 *
 * `btoa` takes a string of code points 0–255, which is exactly what a byte
 * array maps to one for one. Chunked because `String.fromCharCode(...bytes)`
 * on a spread of several thousand elements is a stack overflow on some
 * engines, and a parchi with a QR code is several thousand bytes.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let at = 0; at < bytes.length; at += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  }
  return btoa(binary)
}

/**
 * The transport, bound to whichever printer the desk chose.
 *
 * Reads the setting at PRINT TIME rather than at registration: the printer
 * can be chosen, changed or cleared while the app is open, and a transport
 * holding a stale MAC would print to a device that is no longer the one on
 * the counter. `no_printer_chosen` is the honest refusal when none is set —
 * the same shape thermal.ts already uses, so the screen translates it like
 * any other reason.
 */
export function bluetoothThermalPrinter(db: SqlDriver): ThermalPrinter {
  return {
    async print(bytes: Uint8Array): Promise<ThermalPrintResult> {
      const chosen = chosenPrinter(db)
      if (!chosen) return { ok: false, reason: 'no_printer_chosen' }
      try {
        const answer = await PapaPrint.print({ mac: chosen.mac, bytes: bytesToBase64(bytes) })
        return { ok: Boolean(answer.ok) }
      } catch (e) {
        // The plugin rejects with a short machine word (bluetooth_off,
        // permission_denied, no_bluetooth, bad_request) or, for anything it
        // did not expect, the exception's own message. Both are passed
        // through: the string table translates the words it knows and shows
        // the rest verbatim, which beats "printing failed" with no reason.
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    },
  }
}

/**
 * Register the transport on Android; leave the browser honestly printerless.
 *
 * Called once from the app's boot. In a browser `thermalPrinter()` stays
 * null and every print surface says "no printer connected" instead of
 * pretending — which is the behaviour thermal.ts was written for.
 */
export function installThermalPrinter(db: SqlDriver): void {
  if (!canPrintOverBluetooth()) return
  registerThermalPrinter(bluetoothThermalPrinter(db))
}
