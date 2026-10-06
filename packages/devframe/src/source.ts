// The seam between page stats and where they come from. The devframe reads
// the public v1 API with a server-held credential; the browser extension reads
// the dashboard's routes with the gscdump.com login cookie. The reader in
// `reader.ts` owns everything else: Site choice, windows, retries, and caching.

import type { RecordReadRefusal } from '@gscdump/contracts'
import type { BlockedContext, DateWindow, SiteSummary } from './shared/protocol'

export type SitesRead
  = | { _tag: 'Ok', sites: SiteSummary[] }
    | { _tag: 'Blocked', context: BlockedContext }

export type RowsRead
  = | { _tag: 'Ok', rows: Record<string, unknown>[] }
    /** The record cannot serve the window. `range_not_synced` names the days it lacks. */
    | { _tag: 'Refused', refusal: RecordReadRefusal }
    | { _tag: 'RateLimited' }
    /** The credential or login stopped working. `context` is the step that fixes it. */
    | { _tag: 'Unauthorized', context: BlockedContext }
    | { _tag: 'Failed', message: string, requestId: string | null }

export interface StatsSource {
  /** The credential holder's Sites. */
  sites: () => Promise<SitesRead>
  /** One page's daily rows in `window`: `date`, `clicks`, `impressions`, `ctr`, `position`. */
  dailyRows: (siteId: string, path: string, window: DateWindow) => Promise<RowsRead>
  /** One page's queries in `window`, most clicks first. */
  queryRows: (siteId: string, path: string, window: DateWindow, limit: number) => Promise<RowsRead>
  /** The gscdump.com origin whose dashboard shows these Sites. */
  dashboardOrigin: string
}

/**
 * The host a Site or a page lives on. `sc-domain:example.com`,
 * `https://example.com/blog` and `example.com` are all `example.com`.
 */
export function hostOf(value: string): string | null {
  const text = value.trim()
  if (text.startsWith('sc-domain:'))
    return text.slice('sc-domain:'.length).toLowerCase().replace(/\.$/, '') || null
  const url = URL.parse(/^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  return url?.hostname ? url.hostname.toLowerCase() : null
}
