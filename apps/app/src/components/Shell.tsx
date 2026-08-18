import type { ReactNode } from 'react'
import { Icon, type AnyIconName } from '@papa/icons'
import { go, type View } from '../nav.ts'

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
 * today's work, what we own, what a client asked for, and the labels.
 */

interface Tab {
  view: View
  label: string
  icon: AnyIconName
  /** Which route names light this tab up, including its detail pages. */
  matches: View['name'][]
}

const TABS: Tab[] = [
  { view: { name: 'jobs' }, label: 'Today', icon: 'home', matches: ['jobs', 'session'] },
  { view: { name: 'gear' }, label: 'Gear', icon: 'box', matches: ['gear', 'asset'] },
  { view: { name: 'enquiry' }, label: 'Kit list', icon: 'chat', matches: ['enquiry'] },
  { view: { name: 'settings' }, label: 'Labels', icon: 'ticket', matches: ['settings', 'import'] },
]

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
        <div className="topbar-main">
          <h1 className="topbar-title">{title}</h1>
          {subtitle ? <p className="topbar-sub">{subtitle}</p> : null}
        </div>
        {action}
      </header>

      <main className="app-main view">{children}</main>

      <nav className="bottom-nav" aria-label="Main">
        {TABS.map((tab) => {
          const active = tab.matches.includes(view.name)
          return (
            <button
              key={tab.label}
              className={`nav-tab${active ? ' is-active' : ''}`}
              aria-current={active ? 'page' : undefined}
              onClick={() => go(tab.view)}
            >
              <Icon name={tab.icon} size={22} />
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
}: {
  icon?: AnyIconName
  title: ReactNode
  sub?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="section-head">
      <div>
        <h2>
          {icon ? <Icon name={icon} size={16} className="h-ico" /> : null}
          {title}
        </h2>
        {sub ? <div className="section-sub">{sub}</div> : null}
      </div>
      {action}
    </div>
  )
}
