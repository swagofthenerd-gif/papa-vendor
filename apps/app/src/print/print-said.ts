import { STR } from '../strings.ts'
import type { ThermalPrintResult } from './thermal.ts'

/**
 * What a print attempt SAID, in one place.
 *
 * The transport answers with a short machine word (`no_printer`,
 * `no_printer_chosen`, `bluetooth_off`, `permission_denied`,
 * `no_bluetooth`, `dev_download`) and every print surface has to turn that
 * into a sentence. This is the one home for that mapping (docs/principles.md
 * #4) — the handover screen had the only copy while `no_printer` was the
 * only refusal, and W12 added four more.
 *
 * A word this does not recognise is shown VERBATIM inside
 * `networkThermalFailed` rather than flattened to "printing failed": the
 * unrecognised reasons are the ones a cheap printer invents, and the person
 * standing at the till is better served by a strange sentence than by no
 * information at all.
 *
 * Plain .ts, not .tsx, so a Node test can call it.
 */
export function thermalPrintSaid(result: ThermalPrintResult): string {
  if (result.ok) {
    return result.reason === 'dev_download' ? STR.networkThermalSaved : STR.networkThermalSent
  }
  switch (result.reason) {
    case 'no_printer':
      return STR.networkThermalNoPrinter
    case 'no_printer_chosen':
      return STR.networkThermalNoPrinterChosen
    case 'bluetooth_off':
      return STR.networkThermalBluetoothOff
    case 'permission_denied':
      return STR.networkThermalPermissionDenied
    case 'no_bluetooth':
      return STR.networkThermalNoBluetooth
    default:
      return STR.networkThermalFailed(result.reason ?? '')
  }
}
