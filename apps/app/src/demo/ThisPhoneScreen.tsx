import { useState } from 'react'
import { Icon } from '@papa/icons'
import { Shell, SectionHead } from '../components/Shell.tsx'
import { HoldToFinish } from '../components/HoldToFinish.tsx'
import { go } from '../nav.ts'
import { useSyncTick } from '../sync-tick.ts'
import type { DemoStore } from './store.ts'
import { STR } from '../strings.ts'

/**
 * Settings → This phone (W9): who it is, who it talks to, what is waiting.
 *
 * Four sections on an enrolled phone — the device, the people who may pick
 * it up (tap a name to hand it over: the same PIN switch the gate runs),
 * the sync detail (last heard, cursor, queue depth, the last complaint,
 * and a "sync now" that kicks the loop without waiting on it), and the
 * "needs attention" cards: one card per op the server itself refused,
 * wearing the server's own words, with the count of ops parked behind it.
 * Dismissing a card and signing out are destructive and live behind a
 * hold. In demo mode the screen says so and offers the Enrol door.
 */
export function ThisPhoneScreen({ store }: { store: DemoStore }) {
  const [tick, setTick] = useState(0)
  const syncTick = useSyncTick()
  const [said, setSaid] = useState<string | null>(null)
  const [switching, setSwitching] = useState<string | null>(null)
  const [pin, setPin] = useState('')
  void tick; void syncTick
  const refresh = () => setTick((t) => t + 1)

  const session = store.session()
  const view = store.syncView()
  const cards = store.attentionCards()

  const handOver = async (userId: string) => {
    const r = await store.pinSwitch(userId, pin)
    setPin('')
    if (r.ok) { setSwitching(null); setSaid(r.verifiedBy === 'echo' ? STR.pipeGateCheckedOffline : null) }
    else if (r.reason === 'wrong_pin') setSaid(STR.pipeGateWrongPin)
    else if (r.reason === 'locked_out') setSaid(STR.pipeGateLockedOut)
    else if (r.reason === 'offline_unknown') setSaid(STR.pipeGateOfflineUnknown(store.members().find((m) => m.id === userId)?.name ?? ''))
    else setSaid(r.message)
    refresh()
  }

  const signOut = async () => {
    const r = await store.signOut()
    if (r.ok) { setSaid(STR.pipeSignedOut); refresh(); setTimeout(() => go({ name: 'jobs' }), 900); return }
    if (r.reason === 'unsent') setSaid(STR.pipeSignOutUnsent(r.pending))
    else if (r.reason === 'offline') setSaid(STR.pipeSignOutOffline)
    else setSaid(STR.pipeSignOutRefused(r.message))
  }

  return (
    <Shell
      view={{ name: 'phone' }}
      title={STR.pipePhoneTitle}
      subtitle={STR.pipePhoneSubtitle}
      action={
        <button className="icon-btn" onClick={() => history.back()} aria-label={STR.commonClose}>
          <Icon name="x" size={22} />
        </button>
      }
    >
      {said ? (
        <div className="notice notice-warn" role="status">
          <Icon name="warning" size={18} />
          <div><strong>{said}</strong></div>
        </div>
      ) : null}

      {!session ? (
        <section className="section">
          <SectionHead icon="signal-off" title={STR.pipeDemoMode} sub={STR.pipeDemoModeHint} />
          <button className="btn btn-primary btn-block" onClick={() => go({ name: 'enrol' })}>
            <Icon name="scan" size={18} /> {STR.pipeEnrolTitle}
          </button>
        </section>
      ) : (
        <>
          <section className="section">
            <SectionHead icon="sliders" title={STR.pipeDeviceHeading} />
            <p className="section-sub code">{STR.pipeDeviceLine(store.deviceLabel(), session.deviceId)}</p>
            <p className="section-sub code">{STR.pipeServerLine(session.serverUrl ?? '')}</p>
            {session.expiresAt ? (
              <p className="section-sub">{STR.pipeSessionUntil(dateLabel(session.expiresAt))}</p>
            ) : null}
            <p className="tags-hint">{STR.pipeTokenInMemory}</p>
          </section>

          <section className="section">
            <SectionHead icon="user" title={STR.pipePeopleHeading} sub={STR.pipePeopleSub} />
            <ul className="line-list partner-list">
              {store.members().filter((m) => m.role !== 'driver').map((m) => (
                <li key={m.id}>
                  <button
                    className={`line line-tap pressable${m.current ? ' is-picked' : ''}`}
                    aria-pressed={m.current}
                    onClick={() => { setSwitching(m.current ? null : m.id); setPin(''); setSaid(null) }}
                  >
                    <span className="line-name">{m.name}</span>
                    <span className="line-note">
                      {m.role} · {m.hasPin ? STR.pipeHasPin : STR.pipeNoPin}{m.current ? ` · ${STR.pipeHoldingNow}` : ''}
                    </span>
                    <span className="line-code"><Icon name="user" size={16} /></span>
                  </button>
                  {switching === m.id ? (
                    <form className="pin-inline" onSubmit={(e) => { e.preventDefault(); void handOver(m.id) }}>
                      {m.hasPin ? (
                        <input
                          className="sheet-search code" value={pin} autoFocus
                          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                          placeholder={STR.pipePinPlaceholder} inputMode="numeric" type="password"
                          maxLength={6} autoComplete="off" aria-label={STR.pipePinPlaceholder}
                        />
                      ) : null}
                      <button className="btn btn-primary" type="submit" disabled={m.hasPin && pin.length < 4}>
                        {STR.pipeGateUnlock}
                      </button>
                    </form>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>

          <section className="section">
            <SectionHead
              icon="cloud-queue"
              title={STR.pipeSyncHeading}
              action={
                <button className="btn btn-sm btn-outline" onClick={() => { store.kickSync(); refresh() }}>
                  <Icon name="cloud-queue" size={16} /> {view?.running ? STR.pipeSyncing : STR.pipeSyncNow}
                </button>
              }
            />
            {view ? (
              <>
                <p className="section-sub">
                  {view.lastPullAt ? STR.pipeSyncLastPull(dateLabel(new Date(view.lastPullAt).toISOString())) : STR.pipeSyncNever}
                </p>
                <p className="section-sub code">{STR.pipeSyncCursor(view.cursor)}</p>
                <p className="section-sub">{view.pending > 0 ? STR.pipeSyncQueue(view.pending) : STR.pipeSyncQueueEmpty}</p>
                {view.lastError ? <p className="section-sub">{STR.pipeSyncLastError(view.lastError)}</p> : null}
                {view.sessionDead ? (
                  <div className="notice notice-warn" role="alert">
                    <Icon name="warning" size={18} />
                    <div><strong>{STR.pipeSessionDead}</strong></div>
                  </div>
                ) : null}
              </>
            ) : null}
          </section>

          <section className="section">
            <SectionHead
              icon="warning"
              title={STR.pipeAttentionHeading}
              sub={cards.length === 0 ? STR.pipeAttentionNone : STR.pipeAttentionSub(cards.length)}
            />
            {cards.length > 0 ? (
              <ul className="line-list">
                {cards.map((c) => (
                  <li key={c.rootId} className="attention-card">
                    <div className="line line-stack">
                      <span className="line-name">{STR.pipeOpName(c.op)}</span>
                      <span className="line-note">{c.message || c.code}{c.blocked > 0 ? ` · ${STR.pipeAttentionBehind(c.blocked)}` : ''}</span>
                    </div>
                    <HoldToFinish
                      label={STR.pipeAttentionDismiss}
                      onFinish={() => { store.dismissCard(c.rootId); setSaid(STR.pipeAttentionDismissed); refresh() }}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </section>

          <section className="section">
            <HoldToFinish label={STR.pipeSignOut} onFinish={() => { void signOut() }} />
          </section>
        </>
      )}
    </Shell>
  )
}

function dateLabel(iso: string): string {
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return iso
  return new Date(ms).toLocaleString()
}
