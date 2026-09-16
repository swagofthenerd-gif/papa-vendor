import { useState } from 'react'
import { Icon } from '@papa/icons'
import { buildParchiEscPos } from '@papa/core'
import { SectionHead } from '../components/Shell.tsx'
import { STR } from '../strings.ts'
import { printThermal } from '../print/thermal.ts'
import { thermalPrintSaid } from '../print/print-said.ts'
import {
  canPrintOverBluetooth,
  choosePrinter,
  chosenPrinter,
  pairedPrinters,
  type PairedPrinter,
} from '../print/bt-printer.ts'
import type { DemoStore } from './store.ts'

/**
 * Settings → Printer (W12): which till printer this phone prints on.
 *
 * A house has ONE printer and pairs it once, in Android's own Bluetooth
 * settings, by someone who can read the PIN off the sticker. This row does
 * the three things that are left: pick it from the paired devices, remember
 * the choice (`app_settings`, beside the payment line), and feed a test line
 * so the hardware is proven before a real parchi is needed at the gate —
 * ASSUMPTION #thermal-58mm has been waiting for exactly that.
 *
 * IN A BROWSER IT SAYS SO. thermal.ts's whole design is that a missing
 * transport is stated rather than faked, so here it is stated: no printer
 * connected, the parchi stays on screen, the bytes are still built. A picker
 * that listed nothing would read as a broken printer instead of an absent
 * one.
 */
export function PrinterRow({ store }: { store: DemoStore }) {
  const [chosen, setChosen] = useState(() => chosenPrinter(store.db))
  const [devices, setDevices] = useState<PairedPrinter[] | null>(null)
  const [looking, setLooking] = useState(false)
  const [said, setSaid] = useState<string | null>(null)

  const look = () => {
    setLooking(true)
    setSaid(null)
    void pairedPrinters()
      .then((found) => setDevices(found))
      .catch((e: unknown) => {
        // A refusal here is the permission dialog being declined, or the
        // radio being off — the same vocabulary a failed print speaks, so
        // it goes through the same translator.
        setDevices([])
        setSaid(thermalPrintSaid({ ok: false, reason: e instanceof Error ? e.message : String(e) }))
      })
      .finally(() => setLooking(false))
  }

  const pick = (device: PairedPrinter) => {
    choosePrinter(store.db, device)
    setChosen({ mac: device.mac, name: device.name })
    setDevices(null)
    setSaid(null)
  }

  const forget = () => {
    choosePrinter(store.db, null)
    setChosen(null)
    setDevices(null)
    setSaid(null)
  }

  /**
   * The test line, built by the ONE ESC/POS builder.
   *
   * Not hand-rolled bytes: escpos.ts is the single home for the stream
   * (docs/principles.md #4), so a test that passes here is a test of the
   * same code path a real parchi takes — the init sequence, the letterhead,
   * the 32-column wrap and the cut. No QR: a printer that ignores `GS ( k`
   * would fail the test while text printing perfectly, which would be the
   * wrong answer to "does my printer work".
   */
  const test = () => {
    const bytes = buildParchiEscPos(
      {
        title: store.seed.houseName,
        subtitle: STR.networkPrinterTestWidth,
        lines: [STR.networkPrinterTestBody],
        qrText: null,
      },
      { width: 32 },
    )
    setSaid(null)
    void printThermal(bytes, 'printer-test.bin').then((r) => {
      setSaid(r.ok && r.reason !== 'dev_download' ? STR.networkPrinterTested : thermalPrintSaid(r))
    })
  }

  if (!canPrintOverBluetooth()) {
    return (
      <section className="section">
        <SectionHead icon="receipt" title={STR.networkPrinterHeading} sub={STR.networkPrinterSub} />
        <p className="tags-hint">{STR.networkPrinterBrowserHint}</p>
      </section>
    )
  }

  return (
    <section className="section">
      <SectionHead
        icon="receipt"
        title={STR.networkPrinterHeading}
        sub={chosen ? STR.networkPrinterChosen(chosen.name) : STR.networkPrinterNoneChosen}
      />

      {said ? (
        <div className="notice notice-warn" role="status">
          <Icon name="warning" size={18} />
          <div><strong>{said}</strong></div>
        </div>
      ) : null}

      {devices === null ? (
        <div className="session-actions">
          <button className="btn btn-outline btn-block" onClick={look} disabled={looking}>
            <Icon name="bolt" size={18} />{' '}
            {looking ? STR.networkPrinterLooking : STR.networkPrinterChoose}
          </button>
          {chosen ? (
            <>
              <button className="btn btn-outline btn-block" onClick={test}>
                <Icon name="receipt" size={18} /> {STR.networkPrinterTest}
              </button>
              <button className="btn btn-ghost btn-block" onClick={forget}>
                <Icon name="x" size={18} /> {STR.networkPrinterForget}
              </button>
            </>
          ) : null}
        </div>
      ) : (
        <>
          <p className="field-label">{STR.networkPrinterPaired}</p>
          {devices.length === 0 ? (
            <p className="tags-hint">{STR.networkPrinterNonePaired}</p>
          ) : (
            <ul className="line-list partner-list">
              {devices.map((device) => (
                <li key={device.mac}>
                  <button
                    className={`line line-tap pressable${chosen?.mac === device.mac ? ' is-picked' : ''}`}
                    aria-pressed={chosen?.mac === device.mac}
                    onClick={() => pick(device)}
                  >
                    <span className="line-name">{device.name}</span>
                    <span className="line-note code">{device.mac}</span>
                    <span className="line-code"><Icon name="receipt" size={16} /></span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button className="btn btn-ghost btn-block" onClick={() => setDevices(null)}>
            {STR.commonClose}
          </button>
        </>
      )}
    </section>
  )
}
