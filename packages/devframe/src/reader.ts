import type { GscdumpV1Client } from '@gscdump/sdk/v1'
import type { GscdumpCredential } from './credential'
import type { PeriodWindows } from './page-stats'
import type { DateWindow, GscdumpContext, PageStats, PageStatsInput, Period, SiteSummary } from './shared/protocol'
import { parseRecordReadRefusal } from '@gscdump/contracts'
import { createGscdumpV1Client, isGscdumpV1Error } from '@gscdump/sdk/v1'
import { matchSite, readAccount } from './account'
import { bearerOf, dashboardOrigin, resolveCredential } from './credential'
import { addDays, dashboardPageUrl, pagePathOf, parseQueryRows, periodWindows, summariseDaily } from './page-stats'
import { PERIODS } from './shared/protocol'

/** A Site's coverage moves once a day; one read per five minutes is fresh enough. */
const ACCOUNT_TTL_MS = 5 * 60_000
/** Page stats come from the same daily record. Revisiting a page reuses the read. */
const STATS_TTL_MS = 5 * 60_000
const TOP_QUERIES = 25

export interface GscdumpReaderOptions {
  /** The Site to read: a Site ID, a Site URL, or its host. Optional when the credential holds one Site. */
  site?: string
  /** A gscdump user API key. Defaults to `GSCDUMP_API_KEY`, then the CLI's Hosted login. */
  apiKey?: string
  /** Defaults to `GSCDUMP_API_ROOT`, then `https://gscdump.com/api`. */
  apiRoot?: string
}

export interface GscdumpReaderDeps {
  fetch: typeof fetch
  env: Record<string, string | undefined>
  readCliAuthentication: () => Promise<unknown>
  now: () => number
}

export interface GscdumpReader {
  /** The Site the panel reads. `preferredSiteId` is the panel's own pick, used when no `site` option is set. */
  context: (preferredSiteId?: string | null) => Promise<GscdumpContext>
  pageStats: (input: PageStatsInput) => Promise<PageStats>
}

interface Cached<T> {
  at: number
  value: Promise<T>
}

type Session
  = | { _tag: 'Ready', credential: GscdumpCredential, client: GscdumpV1Client, sites: SiteSummary[] }
    | { _tag: 'Blocked', context: Exclude<GscdumpContext, { _tag: 'Ready' | 'SiteRequired' }> }

interface RowsBody {
  dimensions: ['date' | 'query']
  filter: { _filters: { dimension: string, operator: string, expression: string, expression2?: string }[] }
  orderBy: { column: 'date' | 'clicks', dir: 'asc' | 'desc' }
  rowLimit: number
}

function rowsBody(dimension: 'date' | 'query', path: string, window: DateWindow): RowsBody {
  return {
    dimensions: [dimension],
    filter: {
      _filters: [
        { dimension: 'date', operator: 'between', expression: window.start, expression2: window.end },
        { dimension: 'page', operator: 'equals', expression: path },
      ],
    },
    orderBy: dimension === 'date' ? { column: 'date', dir: 'asc' } : { column: 'clicks', dir: 'desc' },
    rowLimit: dimension === 'date' ? 400 : TOP_QUERIES,
  }
}

function periodDays(period: Period): number {
  return PERIODS.find(option => option.value === period)?.days ?? 28
}

export function createGscdumpReader(options: GscdumpReaderOptions, deps: GscdumpReaderDeps): GscdumpReader {
  let session: Cached<Session> | null = null
  const stats = new Map<string, Cached<PageStats>>()

  async function loadSession(): Promise<Session> {
    const credential = await resolveCredential({
      apiKey: options.apiKey,
      apiRoot: options.apiRoot,
      env: deps.env,
      readCliAuthentication: deps.readCliAuthentication,
    })
    if (!credential)
      return { _tag: 'Blocked', context: { _tag: 'CredentialMissing' } }
    const account = await readAccount(credential, deps.fetch)
    if (account._tag === 'Rejected')
      return { _tag: 'Blocked', context: { _tag: 'CredentialRejected', source: credential.source } }
    if (account._tag === 'Unavailable')
      return { _tag: 'Blocked', context: { _tag: 'Unavailable', message: account.message } }
    if (account.sites.length === 0)
      return { _tag: 'Blocked', context: { _tag: 'NoSites' } }
    const client = createGscdumpV1Client({ apiRoot: credential.apiRoot, credential: bearerOf(credential), fetch: deps.fetch })
    return { _tag: 'Ready', credential, client, sites: account.sites }
  }

  function currentSession(): Promise<Session> {
    if (session && deps.now() - session.at < ACCOUNT_TTL_MS)
      return session.value
    const value = loadSession()
    session = { at: deps.now(), value }
    // A failed or blocked read is not cached: the next call retries, so a fixed
    // credential or a new Site shows up without a restart.
    void value.then((result) => {
      if (result._tag === 'Blocked' && session?.value === value)
        session = null
    }, () => {
      if (session?.value === value)
        session = null
    })
    return value
  }

  async function context(preferredSiteId?: string | null): Promise<GscdumpContext> {
    const current = await currentSession()
    if (current._tag === 'Blocked')
      return current.context
    if (options.site) {
      const match = matchSite(current.sites, options.site)
      return match._tag === 'Found'
        ? { _tag: 'Ready', site: match.site, sites: current.sites, configured: true }
        : { _tag: 'SiteRequired', sites: current.sites, target: options.site }
    }
    const preferred = preferredSiteId ? current.sites.find(site => site.siteId === preferredSiteId) : undefined
    if (preferred)
      return { _tag: 'Ready', site: preferred, sites: current.sites, configured: false }
    const match = matchSite(current.sites, null)
    return match._tag === 'Found'
      ? { _tag: 'Ready', site: match.site, sites: current.sites, configured: false }
      : { _tag: 'SiteRequired', sites: current.sites, target: null }
  }

  async function readRows(client: GscdumpV1Client, siteId: string, body: RowsBody): Promise<Record<string, unknown>[]> {
    const response = await client.queryAnalyticsRows({ params: { siteId }, body: body as never })
    return response.data.rows as Record<string, unknown>[]
  }

  async function readPage(current: Extract<Session, { _tag: 'Ready' }>, site: SiteSummary, path: string, period: Period, windows: PeriodWindows, retried: boolean): Promise<PageStats> {
    const span = { start: windows.previous?.start ?? windows.current.start, end: windows.current.end }
    const result = await Promise.all([
      readRows(current.client, site.siteId, rowsBody('date', path, span)),
      readRows(current.client, site.siteId, rowsBody('query', path, windows.current)),
    ]).catch((error: unknown) => error)
    if (Array.isArray(result)) {
      const [daily, queries] = result
      return {
        _tag: 'Ok',
        siteId: site.siteId,
        path,
        period,
        window: windows.current,
        previousWindow: windows.previous,
        ...summariseDaily(daily, windows),
        queries: parseQueryRows(queries),
        dashboardUrl: dashboardPageUrl(dashboardOrigin(current.credential.apiRoot), site, path),
      }
    }
    if (!isGscdumpV1Error(result))
      throw result
    const refusal = parseRecordReadRefusal(result.details)
    // The record can lag the Site's newest synced day. Read up to the day
    // before the first missing day once, rather than show nothing.
    if (refusal?.reason === 'range_not_synced' && !retried && refusal.missingStart > windows.current.start) {
      const shifted = periodWindows(periodDays(period), { oldestDate: site.oldestDate, newestDate: addDays(refusal.missingStart, -1) })
      if (shifted)
        return readPage(current, site, path, period, shifted, true)
    }
    if (refusal?.reason === 'record_not_ready')
      return { _tag: 'NoData', siteId: site.siteId, message: 'gscdump has not prepared this Site\'s record for reads yet. Try again in a few minutes.' }
    if (refusal?.reason === 'range_not_synced')
      return { _tag: 'NoData', siteId: site.siteId, message: `The Site's record does not hold ${refusal.missingStart} to ${refusal.missingEnd} yet.` }
    // The SDK already waited out `Retry-After` and retried before it gave up.
    if (result.code === 'rate_limited')
      return { _tag: 'RateLimited' }
    if (result.status === 401 || result.status === 403)
      return { _tag: 'SiteUnavailable', context: { _tag: 'CredentialRejected', source: current.credential.source } }
    return { _tag: 'Failed', message: result.message, requestId: result.requestId ?? null }
  }

  async function pageStats(input: PageStatsInput): Promise<PageStats> {
    const path = pagePathOf(input.page)
    if (!path)
      return { _tag: 'InvalidPage', page: input.page }
    const period = input.period ?? '28d'
    const resolved = await context(input.siteId)
    if (resolved._tag !== 'Ready')
      return { _tag: 'SiteUnavailable', context: resolved }
    const site = resolved.site
    const key = `${site.siteId}|${period}|${path}`
    const hit = stats.get(key)
    if (hit && deps.now() - hit.at < STATS_TTL_MS)
      return hit.value
    const current = await currentSession()
    if (current._tag !== 'Ready')
      return { _tag: 'SiteUnavailable', context: current.context }
    const windows = periodWindows(periodDays(period), site)
    if (!windows)
      return { _tag: 'NoData', siteId: site.siteId, message: 'The Site\'s record holds no days yet. gscdump is still syncing it.' }
    const value = readPage(current, site, path, period, windows, false)
    stats.set(key, { at: deps.now(), value })
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
