import type { ReactNode } from 'react'
import { Icon, type AnyIconName } from '@papa/icons'
import { go, type View } from '../nav.ts'
import { STR } from '../strings.ts'

/**
 * The app chrome — a top bar and a bottom tab bar, matching the marketplace.
 *
 * NOT ON THE SCAN SCREEN. The scan screen takes the whole viewport: chrome
 * there would eat the camera's share of the height and put a navigation target
 * under a gloved thumb that is meant to be holding a case. Everything else in
 * the app is a desk surface and keeps the bar.
 *
 * Four destinations, because five is where a tab bar starts being read as a
 * menu rather than as a place. They are the four things a rental house does:
 * today's work, what we own, what a client asked for, and the money.
 */

interface Tab {
  view: View
  label: string
  icon: AnyIconName
  /** Which route names light this tab up, including its detail pages. */
  matches: View['name'][]
}

const TABS: Tab[] = [
  // Today · Gear · Desk · Khata — the day's work, what we own, what a
  // client asked for, and the money. Settings and the import are not
  // places the day happens in; they open from the gear glyph in the top
  // bar (SettingsButton) and light no tab.
  { view: { name: 'jobs' }, label: STR.commonTabToday, icon: 'home', matches: ['jobs', 'session', 'scan'] },
  { view: { name: 'gear' }, label: STR.commonTabGear, icon: 'box', matches: ['gear', 'asset', 'ginti', 'closed'] },
  { view: { name: 'desk' }, label: STR.commonTabDesk, icon: 'chat', matches: ['desk', 'calendar', 'booking'] },
  { view: { name: 'owed' }, label: STR.commonTabKhata, icon: 'scroll', matches: ['owed', 'customer', 'hisaab'] },
]

/** The settings door every tab's top bar carries — one glyph, one place. */
export function SettingsButton() {
  return (
    <button
      className="icon-btn"
      onClick={() => go({ name: 'settings' })}
      aria-label={STR.commonOpenSettingsAria}
    >
      <Icon name="sliders" size={22} />
    </button>
  )
}

export function Shell({
  view,
  title,
  subtitle,
  action,
  children,
}: {
  view: View
  title: string
  subtitle?: ReactNode
  /** Optional control in the top bar, right-aligned. */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="app-shell">
      <header className="topbar">
        {/* The family mark — the marketplace's cine-camera, worn small.
            Decorative: the title beside it names the screen, and the
            document title already carries the product name. */}
        <span className="brand-mark" aria-hidden="true">
          <Icon name="camera" size={20} />
        </span>
        <div className="topbar-main">
          <h1 className="topbar-title">{title}</h1>
          {subtitle ? <p className="topbar-sub">{subtitle}</p> : null}
        </div>
        {action}
      </header>

      <main className="app-main view">{children}</main>

      <nav className="bottom-nav" aria-label={STR.commonNavMainAria}>
        {TABS.map((tab) => {
          const active = tab.matches.includes(view.name)
          return (
            <button
              key={tab.label}
              className={`nav-tab${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => go(tab.view)}
            >
              {/* The capsule the accent tint lives in when the tab is
                  active — see .nav-ico in app.css. */}
              <span className="nav-ico">
                <Icon name={tab.icon} size={22} />
              </span>
              <span>{tab.label}</span>
            </button>
          )
        })}
      </nav>
    </div>
  )
}

/**
 * One shape for every section header, so they cannot drift apart the way the
 * marketplace's did — there, two headers ended up as the only ones on the page
 * with no icon, and the subtitle landed in a different place depending on
 * whether the title had been wrapped in a div.
 */
export function SectionHead({
  icon,
  title,
  sub,
  action,
  stamp = false,
}: {
  icon?: AnyIconName
  title: ReactNode
  sub?: ReactNode
  action?: ReactNode
  /** Render the title as a rubber stamp — ONLY for a heading that
   *  demands a person act (the handover's did-not-come-back list).
   *  See .stamp in app.css. */
  stamp?: boolean
}) {
  return (
    <div className="section-head">
      <div>
        <h2 className={stamp ? 'stamp' : undefined}>
          {icon ? <Icon name={icon} size={16} className="h-ico" /> : null}
          {title}
        </h2>
        {sub ? <div className="section-sub">{sub}</div> : null}
      </div>
      {action}
    </div>
  )
}
