// The contract the node side, the page script, and the panel share. Plain types
// and constants only: the panel and the page script bundle this file for the
// browser.

/** The devframe id. It prefixes every RPC name and becomes the mount path segment. */
export const DEVFRAME_ID = 'gscdump'

/** The in-page channel between the page script and the panel. */
export const PAGE_CHANNEL = 'gscdump:page'

export type Period = '7d' | '28d' | '3m'

export const PERIODS: readonly { value: Period, label: string, days: number }[] = [
  { value: '7d', label: 'Last 7 days', days: 7 },
  { value: '28d', label: 'Last 28 days', days: 28 },
  { value: '3m', label: 'Last 3 months', days: 90 },
]

export interface SiteSummary {
  siteId: string
  /** The Site as gscdump registered it, for example `example.com`. */
  siteUrl: string
  /** The exact host the Site covers, for example `example.com`. A page on another host is not on this Site. */
  host: string
  /** The first day the Hosted record holds, `YYYY-MM-DD`. */
  oldestDate: string | null
  /** The last day the Hosted record holds, `YYYY-MM-DD`. */
  newestDate: string | null
}

/**
 * What the panel can read, decided once per panel boot and again when the
 * page's host changes. Each tag names the next step the panel shows.
 */
export type GscdumpContext
  = | { _tag: 'Ready', site: SiteSummary, sites: SiteSummary[], configured: boolean }
    | { _tag: 'SiteRequired', sites: SiteSummary[], target: string | null }
    | { _tag: 'NoSiteForPage', host: string }
    | BlockedContext

/** A context that stops before any Site is chosen: no credential, no Sites, or no service. */
export type BlockedContext
  = | { _tag: 'NoSites' }
    | { _tag: 'CredentialMissing' }
    | { _tag: 'CredentialRejected', source: CredentialSource }
    | { _tag: 'SignedOut', signInUrl: string }
    | { _tag: 'Unavailable', message: string }

export type CredentialSource = 'option' | 'env' | 'cli-session'

export interface MetricTotals {
  clicks: number
  impressions: number
  ctr: number
  /** Impression-weighted average position. `null` when the page had no impressions. */
  position: number | null
}

export interface DailyPoint extends MetricTotals {
  date: string
}

export interface QueryRow extends MetricTotals {
  query: string
}

export interface DateWindow {
  start: string
  end: string
}

export interface PageStatsInput {
  /** A path such as `/blog/post`, or a full URL. Search Console stores pages by path. */
  page: string
  period?: Period
  /** Defaults to the Site the context resolved. */
  siteId?: string
}

export type PageStats
  = | {
    _tag: 'Ok'
    siteId: string
    path: string
    period: Period
    window: DateWindow
    /** `null` when the Hosted record does not hold the preceding window. */
    previousWindow: DateWindow | null
    totals: MetricTotals
    previousTotals: MetricTotals | null
    /** One point per day of `window`, ascending. Days without data are zero. */
    daily: DailyPoint[]
    /** One point per day of `previousWindow`, ascending. */
    previousDaily: DailyPoint[] | null
    /** The queries that earned the page impressions, most clicks first. */
    queries: QueryRow[]
    /** The page in the gscdump.com dashboard. */
    dashboardUrl: string
  }
  | { _tag: 'InvalidPage', page: string }
  | { _tag: 'SiteUnavailable', context: Exclude<GscdumpContext, { _tag: 'Ready' }> }
  | { _tag: 'NoData', siteId: string, message: string }
  | { _tag: 'RateLimited' }
  | { _tag: 'Failed', message: string, requestId: string | null }

/** What the page script shares with the panel: the page in view in the host app. */
export interface PageLocation {
  path: string
  href: string
  title: string
}

export interface PageChannelProtocol {
  sharedStates: {
    location: PageLocation
  }
}
