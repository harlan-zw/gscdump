import type { PeriodWindows } from './page-stats'
import type { GscdumpContext, PageStats, PageStatsInput, Period, SiteSummary } from './shared/protocol'
import type { RowsRead, SitesRead, StatsSource } from './source'
import { periodToDateRange } from '@gscdump/sdk/period'
import { matchSite } from './account'
import { addDays, dashboardPageUrl, pagePathOf, parseQueryRows, periodWindows, summariseDaily } from './page-stats'
import { PERIODS } from './shared/protocol'
import { hostOf } from './source'

/** A Site's coverage moves once a day; one read per five minutes is fresh enough. */
const SITES_TTL_MS = 5 * 60_000
/** Page stats come from the same daily record. Revisiting a page reuses the read. */
const STATS_TTL_MS = 5 * 60_000
const TOP_QUERIES = 25

export interface PageStatsReaderOptions {
  /** The Site to read: a Site ID, a Site URL, or its host. It wins over every other choice. */
  site?: string
  /**
   * Choose the Site from the host of the page in view. The browser extension
   * sets this: the tab's host names the Site. A dev server's host names none.
   */
  siteFromPage?: boolean
}

export interface GscdumpReader {
  /**
   * The Site the panel reads. `preferredSiteId` is the panel's own pick.
   * `pageUrl` is the page in view, which picks the Site when `siteFromPage` is set.
   */
  context: (preferredSiteId?: string | null, pageUrl?: string | null) => Promise<GscdumpContext>
  pageStats: (input: PageStatsInput) => Promise<PageStats>
}

interface Cached<T> {
  at: number
  value: Promise<T>
}

function periodDays(period: Period): number {
  return PERIODS.find(option => option.value === period)?.days ?? 28
}

/** Site choice when the page's host names the Site. */
function contextForPage(sites: SiteSummary[], pageUrl: string, preferredSiteId: string | null): GscdumpContext {
  const host = hostOf(pageUrl) ?? pageUrl
  const matches = sites.filter(site => site.host === host)
  if (matches.length === 0)
    return { _tag: 'NoSiteForPage', host }
  const pick = matches.find(site => site.siteId === preferredSiteId) ?? (matches.length === 1 ? matches[0] : undefined)
  return pick
    ? { _tag: 'Ready', site: pick, sites: matches, configured: false }
    : { _tag: 'SiteRequired', sites: matches, target: host }
}

export function createPageStatsReader(options: PageStatsReaderOptions, source: StatsSource, now: () => number): GscdumpReader {
  let sitesCache: Cached<SitesRead> | null = null
  const stats = new Map<string, Cached<PageStats>>()

  function readSites(): Promise<SitesRead> {
    if (sitesCache && now() - sitesCache.at < SITES_TTL_MS)
      return sitesCache.value
    const value = source.sites()
    sitesCache = { at: now(), value }
    // A failed or blocked read is not cached: the next call retries, so a fixed
    // credential, a fresh login, or a new Site shows up without a restart.
    void value.then((result) => {
      if (result._tag === 'Blocked' && sitesCache?.value === value)
        sitesCache = null
    }, () => {
      if (sitesCache?.value === value)
        sitesCache = null
    })
    return value
  }

  async function context(preferredSiteId?: string | null, pageUrl?: string | null): Promise<GscdumpContext> {
    const read = await readSites()
    if (read._tag === 'Blocked')
      return read.context
    const sites = read.sites
    if (sites.length === 0)
      return { _tag: 'NoSites' }
    if (options.site) {
      const match = matchSite(sites, options.site)
      if (match._tag === 'Found')
        return { _tag: 'Ready', site: match.site, sites, configured: true }
      // The option names no single Site, so the panel's pick decides.
      const picked = preferredSiteId ? sites.find(site => site.siteId === preferredSiteId) : undefined
      return picked
        ? { _tag: 'Ready', site: picked, sites, configured: false }
        : { _tag: 'SiteRequired', sites, target: options.site }
    }
    if (options.siteFromPage && pageUrl)
      return contextForPage(sites, pageUrl, preferredSiteId ?? null)
    const preferred = preferredSiteId ? sites.find(site => site.siteId === preferredSiteId) : undefined
    if (preferred)
      return { _tag: 'Ready', site: preferred, sites, configured: false }
    const match = matchSite(sites, null)
    return match._tag === 'Found'
      ? { _tag: 'Ready', site: match.site, sites, configured: false }
      : { _tag: 'SiteRequired', sites, target: null }
  }

  /**
   * The Site a page read uses. With `siteFromPage`, a typed path carries no
   * host, so the panel's Site ID decides, then a full URL's host.
   */
  async function siteForPage(input: PageStatsInput): Promise<GscdumpContext> {
    if (!options.siteFromPage)
      return context(input.siteId)
    const read = await readSites()
    if (read._tag === 'Blocked')
      return read.context
    const chosen = input.siteId ? read.sites.find(site => site.siteId === input.siteId) : undefined
    if (chosen)
      return { _tag: 'Ready', site: chosen, sites: read.sites, configured: false }
    return /^https?:\/\//i.test(input.page)
      ? contextForPage(read.sites, input.page, null)
      : { _tag: 'SiteRequired', sites: read.sites, target: null }
  }

  /** The first read that is not `Ok`, or both rows. */
  function firstFailure(daily: RowsRead, queries: RowsRead): Exclude<RowsRead, { _tag: 'Ok' }> | null {
    if (daily._tag !== 'Ok')
      return daily
    return queries._tag !== 'Ok' ? queries : null
  }

  async function readPage(site: SiteSummary, path: string, period: Period, windows: PeriodWindows, retried: boolean): Promise<PageStats> {
    const span = { start: windows.previous?.start ?? windows.current.start, end: windows.current.end }
    const [daily, queries] = await Promise.all([
      source.dailyRows(site.siteId, path, span),
      source.queryRows(site.siteId, path, windows.current, TOP_QUERIES),
    ])
    const failure = firstFailure(daily, queries)
    if (!failure && daily._tag === 'Ok' && queries._tag === 'Ok') {
      return {
        _tag: 'Ok',
        siteId: site.siteId,
        path,
        period,
        window: windows.current,
        previousWindow: windows.previous,
        ...summariseDaily(daily.rows, windows),
        queries: parseQueryRows(queries.rows),
        dashboardUrl: dashboardPageUrl(source.dashboardOrigin, site, path),
      }
    }
    switch (failure?._tag) {
      case 'Refused': {
        const refusal = failure.refusal
        // The record can lag the Site's newest synced day. Read up to the day
        // before the first missing day once, rather than show nothing.
        if (refusal.reason === 'range_not_synced' && !retried && refusal.missingStart > windows.current.start) {
          const shifted = periodWindows(periodDays(period), { oldestDate: site.oldestDate, newestDate: addDays(refusal.missingStart, -1) })
          if (shifted)
            return readPage(site, path, period, shifted, true)
        }
        return refusal.reason === 'record_not_ready'
          ? { _tag: 'NoData', siteId: site.siteId, message: 'gscdump has not prepared this Site\'s record for reads yet. Try again in a few minutes.' }
          : { _tag: 'NoData', siteId: site.siteId, message: `The Site's record does not hold ${refusal.missingStart} to ${refusal.missingEnd} yet.` }
      }
      case 'RateLimited':
        return { _tag: 'RateLimited' }
      case 'Unauthorized':
        // The login or credential stopped working; read the Sites again next time.
        sitesCache = null
        return { _tag: 'SiteUnavailable', context: failure.context }
      case 'Failed':
        return { _tag: 'Failed', message: failure.message, requestId: failure.requestId }
      default:
        return { _tag: 'Failed', message: 'The read returned no rows and no error.', requestId: null }
    }
  }

  async function pageStats(input: PageStatsInput): Promise<PageStats> {
    const path = pagePathOf(input.page)
    if (!path)
      return { _tag: 'InvalidPage', page: input.page }
    const period = input.period ?? '28d'
    const resolved = await siteForPage(input)
    if (resolved._tag !== 'Ready')
      return { _tag: 'SiteUnavailable', context: resolved }
    const site = resolved.site
    const key = `${site.siteId}|${period}|${path}`
    const hit = stats.get(key)
    if (hit && now() - hit.at < STATS_TTL_MS)
      return hit.value
    // End where the gscdump.com dashboard ends: before the days Google has not
    // finalized, and never past the last day the record holds.
    const stableEnd = periodToDateRange(period, { now: new Date(now()) }).end
    const newestDate = site.newestDate && site.newestDate > stableEnd ? stableEnd : site.newestDate
    const windows = periodWindows(periodDays(period), { oldestDate: site.oldestDate, newestDate })
    if (!windows)
      return { _tag: 'NoData', siteId: site.siteId, message: 'The Site\'s record holds no days yet. gscdump is still syncing it.' }
    const value = readPage(site, path, period, windows, false)
    stats.set(key, { at: now(), value })
    // Only a full answer is reused. A refusal or a failure reads again next time.
    void value.then((result) => {
      if (result._tag !== 'Ok' && stats.get(key)?.value === value)
        stats.delete(key)
    }, () => {
      if (stats.get(key)?.value === value)
        stats.delete(key)
    })
    return value
  }

  return { context, pageStats }
}
