import type {
  AnalysisSourcesResponse,
  AnalyticsClient,
  BackfillRange,
  BackfillResponse,
  CountriesResponse,
  GscRowQueryResponse,
  IndexingDiagnostics,
  IndexingInspectRateLimited,
  IndexingInspectRequest,
  IndexingInspectResponse,
  IndexingUrlsResponse,
  IndexingUrlStatus,
  InspectionHistoryResponse,
  InspectionIndex,
  RollupEnvelope,
  SearchAppearanceResponse,
  SiteListItem,
  SitemapChangesResponse,
  SitemapHistoryResponse,
  SitemapIndex,
  SourceInfoOptions,
  SourceInfoResponse,
  WhoamiResponse,
} from '@gscdump/contracts'
import type { ZodTypeAny } from 'zod'
import type { PartnerFetch, PartnerFetchOptions, PartnerHeaders } from './client'
import { analyticsRoutes, partnerEndpointSchemas } from '@gscdump/contracts'
import { ofetch } from 'ofetch'
import { toPartnerError } from './errors'

export type AnalyticsFetch = PartnerFetch
export type AnalyticsHeaders = PartnerHeaders
export type AnalyticsFetchOptions = PartnerFetchOptions

export interface AnalyticsClientOptions {
  apiBase?: string
  fetch?: AnalyticsFetch
  headers?: AnalyticsHeaders
  validate?: boolean | 'request' | 'response'
}

const TRAILING_SLASH_RE = /\/+$/
const LEADING_SLASH_RE = /^\/+/
type GscSearchType = 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews'
interface AnalysisSourcesOptions {
  tables?: string[] | string
  searchType?: GscSearchType
  start?: string
  end?: string
  startDate?: string
  endDate?: string
}
const DEFAULT_SEARCH_TYPE: GscSearchType = 'web'

function trimApiBase(apiBase: string | undefined): string {
  return (apiBase ?? '').replace(TRAILING_SLASH_RE, '')
}

function buildPath(apiBase: string, path: string): string {
  if (!apiBase)
    return path.startsWith('/') ? path : `/${path}`
  return `${apiBase}/${path.replace(LEADING_SLASH_RE, '')}`
}

function mergeHeaders(base: HeadersInit | undefined, extra: HeadersInit | undefined): Headers {
  const headers = new Headers(base)
  if (extra) {
    for (const [key, value] of new Headers(extra).entries())
      headers.set(key, value)
  }
  return headers
}

async function resolveHeaders(options: AnalyticsClientOptions): Promise<HeadersInit | undefined> {
  return typeof options.headers === 'function'
    ? await options.headers()
    : options.headers
}

function shouldValidate(options: AnalyticsClientOptions, phase: 'request' | 'response'): boolean {
  return options.validate === true || options.validate === phase
}

function parseWith<T>(schema: ZodTypeAny | undefined, value: T): T {
  return schema ? schema.parse(value) as T : value
}

function isAnalysisSourcesOptions(value: unknown): value is AnalysisSourcesOptions {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function searchTypeQuery(searchType?: GscSearchType): Record<string, string> {
  return { searchType: searchType ?? DEFAULT_SEARCH_TYPE }
}

function dateRangeOptionsQuery(options: { start?: string, end?: string, startDate?: string, endDate?: string } | undefined): Record<string, string> {
  const query: Record<string, string> = {}
  const start = options?.start ?? options?.startDate
  const end = options?.end ?? options?.endDate
  if (start)
    query.start = start
  if (end)
    query.end = end
  return query
}

function sourceInfoQuery(options: SourceInfoOptions | undefined): Record<string, string> {
  return {
    ...searchTypeQuery(options?.searchType),
    ...dateRangeOptionsQuery(options),
  }
}

function tablesQuery(
  tablesOrOptions: string[] | string | AnalysisSourcesOptions | undefined,
  options?: { searchType?: GscSearchType, start?: string, end?: string, startDate?: string, endDate?: string },
): Record<string, string> {
  const tables = isAnalysisSourcesOptions(tablesOrOptions) ? tablesOrOptions.tables : tablesOrOptions
  const source = isAnalysisSourcesOptions(tablesOrOptions) ? tablesOrOptions : options
  const query = {
    ...searchTypeQuery(source?.searchType),
    ...dateRangeOptionsQuery(source),
  }
  if (tables)
    query.tables = Array.isArray(tables) ? tables.join(',') : tables
  return query
}

function withDefaultSearchType<T>(value: T): T {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return value
  return {
    ...(value as Record<string, unknown>),
    searchType: (value as { searchType?: GscSearchType }).searchType ?? DEFAULT_SEARCH_TYPE,
  } as T
}

function indexingUrlsQuery(params: { limit?: number, offset?: number, status?: IndexingUrlStatus, issue?: string, search?: string } = {}): Record<string, string | number> {
  const query: Record<string, string | number> = {}
  if (params.limit != null)
    query.limit = params.limit
  if (params.offset != null)
    query.offset = params.offset
  if (params.status)
    query.status = params.status
  if (params.issue)
    query.issue = params.issue
  if (params.search)
    query.search = params.search
  return query
}

export function createAnalyticsClient(options: AnalyticsClientOptions = {}): AnalyticsClient {
  const fetchImpl = options.fetch ?? (ofetch as AnalyticsFetch)
  const apiBase = trimApiBase(options.apiBase)

  async function request<T>(path: string, init: AnalyticsFetchOptions = {}, responseSchema?: ZodTypeAny): Promise<T> {
    const headers = mergeHeaders(await resolveHeaders(options), init.headers)
    try {
      const out = await fetchImpl<T>(buildPath(apiBase, path), {
        ...init,
        headers,
      })
      return shouldValidate(options, 'response') ? parseWith(responseSchema, out) : out
    }
    catch (error) {
      throw toPartnerError(error)
    }
  }

  return {
    whoami() {
      return request<WhoamiResponse>(analyticsRoutes.whoami, {}, partnerEndpointSchemas.analyticsWhoami.response)
    },
    listSites() {
      return request<SiteListItem[]>(analyticsRoutes.sites, {}, partnerEndpointSchemas.analyticsSites.response)
    },
    getSourceInfo(siteId: string, options?: SourceInfoOptions) {
      return request<SourceInfoResponse>(analyticsRoutes.site.sourceInfo(siteId), { query: sourceInfoQuery(options) }, partnerEndpointSchemas.analyticsSourceInfo.response)
    },
    getAnalysisSources(siteId: string, tables?: string[] | string | AnalysisSourcesOptions, options?: { searchType?: GscSearchType, start?: string, end?: string, startDate?: string, endDate?: string }) {
      return request<AnalysisSourcesResponse>(analyticsRoutes.site.analysisSources(siteId), { query: tablesQuery(tables, options) }, partnerEndpointSchemas.analyticsAnalysisSources.response)
    },
    analyze<T = unknown>(siteId: string, params: unknown) {
      return request<T>(analyticsRoutes.site.analyze(siteId), { method: 'POST', body: withDefaultSearchType(params) })
    },
    queryRows<T = Record<string, unknown>>(siteId: string, state: unknown) {
      return request<GscRowQueryResponse<T>>(analyticsRoutes.site.rows(siteId), { method: 'POST', body: withDefaultSearchType(state) }, partnerEndpointSchemas.analyticsRows.response)
    },
    getRollup<T = unknown>(siteId: string, rollupId: string, params?: { start?: string, end?: string }) {
      return request<RollupEnvelope<T>>(analyticsRoutes.site.rollup(siteId, rollupId), { query: params }, partnerEndpointSchemas.analyticsRollup.response)
    },
    requestBackfill(siteId: string, range: BackfillRange) {
      const body = shouldValidate(options, 'request') ? partnerEndpointSchemas.analyticsBackfill.body.parse(range) : range
      return request<BackfillResponse>(analyticsRoutes.site.backfill(siteId), { method: 'POST', body }, partnerEndpointSchemas.analyticsBackfill.response)
    },
    getSitemaps(siteId: string) {
      return request<SitemapIndex>(analyticsRoutes.site.sitemaps(siteId), {}, partnerEndpointSchemas.analyticsSitemaps.response)
    },
    getSitemapHistory(siteId: string, hash: string) {
      return request<SitemapHistoryResponse>(analyticsRoutes.site.sitemapHistory(siteId, hash), {}, partnerEndpointSchemas.analyticsSitemapHistory.response)
    },
    getSitemapChanges(siteId: string, params: { days?: number } = {}) {
      return request<SitemapChangesResponse>(analyticsRoutes.site.sitemapChanges(siteId), { query: params }, partnerEndpointSchemas.analyticsSitemapChanges.response)
    },
    getInspections(siteId: string) {
      return request<InspectionIndex>(analyticsRoutes.site.inspections(siteId), {}, partnerEndpointSchemas.analyticsInspections.response)
    },
    getInspectionHistory(siteId: string, hash: string) {
      return request<InspectionHistoryResponse>(analyticsRoutes.site.inspectionHistory(siteId, hash), {}, partnerEndpointSchemas.analyticsInspectionHistory.response)
    },
    getIndexingUrls(siteId: string, params = {}) {
      return request<IndexingUrlsResponse>(analyticsRoutes.site.indexingUrls(siteId), { query: indexingUrlsQuery(params) }, partnerEndpointSchemas.analyticsIndexingUrls.response)
    },
    getIndexingDiagnostics(siteId: string) {
      return request<IndexingDiagnostics>(analyticsRoutes.site.indexingDiagnostics(siteId), {}, partnerEndpointSchemas.analyticsIndexingDiagnostics.response)
    },
    requestIndexingInspect(siteId: string, body: IndexingInspectRequest) {
      const parsed = shouldValidate(options, 'request') ? partnerEndpointSchemas.analyticsIndexingInspect.body.parse(body) : body
      return request<IndexingInspectResponse | IndexingInspectRateLimited>(analyticsRoutes.site.indexingInspect(siteId), { method: 'POST', body: parsed }, partnerEndpointSchemas.analyticsIndexingInspect.response)
    },
    getCountries(siteId: string, range: { start: string, end: string }) {
      return request<CountriesResponse>(analyticsRoutes.site.countries(siteId), { query: range }, partnerEndpointSchemas.analyticsCountries.response)
    },
    getSearchAppearance(siteId: string, range: { start: string, end: string }) {
      return request<SearchAppearanceResponse>(analyticsRoutes.site.searchAppearance(siteId), { query: range }, partnerEndpointSchemas.analyticsSearchAppearance.response)
    },
  }
}
