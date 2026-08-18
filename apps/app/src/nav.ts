/**
 * Routing.
 *
 * A hand-rolled hash router, matching the marketplace. Hash rather than
 * history because the scanner ships inside a Capacitor WebView loading from
 * `file://`, where path-based routing needs a server that is not there.
 *
 * Route by ROLE AND INTENT, never by screen width. `isMobile` conflates three
 * orthogonal things — viewport, input modality, and job — and a manager on a
 * phone wants the console in a phone layout, not the scanner.
 */

export type View =
  | { name: 'jobs' }                             // scanner home: today's jobs
  | { name: 'scan'; jobId: string; mode: ScanMode }
  | { name: 'session'; sessionId: string }       // the reconciliation card
  | { name: 'asset'; assetId: string }
  | { name: 'gear'; query?: string }             // search-first inventory
  | { name: 'enquiry' }                          // the pasted kit list
  | { name: 'settings' }

export type ScanMode = 'out' | 'in'

export function parseHash(hash: string): View {
  const raw = hash.replace(/^#\/?/, '')
  const [path, query] = raw.split('?')
  const parts = path.split('/').filter(Boolean)
  const params = new URLSearchParams(query ?? '')

  switch (parts[0]) {
    case undefined:
    case '':
      return { name: 'jobs' }
    case 'scan':
      if (!parts[1]) return { name: 'jobs' }
      return {
        name: 'scan',
        jobId: parts[1],
        mode: params.get('mode') === 'in' ? 'in' : 'out',
      }
    case 'session':
      return parts[1] ? { name: 'session', sessionId: parts[1] } : { name: 'jobs' }
    case 'asset':
      return parts[1] ? { name: 'asset', assetId: parts[1] } : { name: 'jobs' }
    case 'gear': {
      // The key is omitted rather than set to undefined when there is no
      // query, so a parsed view compares equal to the literal that produced
      // it. `{query: undefined}` and `{}` behave the same everywhere except
      // in a comparison, which is exactly where a routing bug hides.
      const q = params.get('q')
      return q ? { name: 'gear', query: q } : { name: 'gear' }
    }
    case 'enquiry':
      return { name: 'enquiry' }
    case 'settings':
      return { name: 'settings' }
    default:
      return { name: 'jobs' }
  }
}

export function viewToHash(view: View): string {
  switch (view.name) {
    case 'jobs':
      return '#/'
    case 'scan':
      return `#/scan/${view.jobId}?mode=${view.mode}`
    case 'session':
      return `#/session/${view.sessionId}`
    case 'asset':
      return `#/asset/${view.assetId}`
    case 'gear':
      return view.query ? `#/gear?q=${encodeURIComponent(view.query)}` : '#/gear'
    case 'enquiry':
      return '#/enquiry'
    case 'settings':
      return '#/settings'
  }
}

export const go = (view: View): void => {
  window.location.hash = viewToHash(view)
}
