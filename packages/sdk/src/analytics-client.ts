import type {
  AnalysisSourcesResponse,
  AnalyticsClient,
  BackfillRange,
  BackfillResponse,
  CountriesResponse,
  GscRowQueryResponse,
  IndexingDiagnostics,
  IndexingDiagnosticsParams,
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
import type { HostedClientOptions, HostedFetch, HostedFetchOptions, HostedHeaders } from './request'
import { analyticsEndpointSchemas, analyticsRoutes } from '@gscdump/contracts/analytics'
import { createHostedRequester } from './request'

export type AnalyticsFetch = HostedFetch
export type AnalyticsHeaders = HostedHeaders
export type AnalyticsFetchOptions = HostedFetchOptions

export interface AnalyticsClientOptions extends HostedClientOptions {
  apiBase?: string
  fetch?: AnalyticsFetch
  headers?: AnalyticsHeaders
  validate?: boolean | 'request' | 'response'
}

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

function indexingDiagnosticsQuery(params: IndexingDiagnosticsParams = {}): Record<string, string | number> {
  const query: Record<string, string | number> = {}
  if (params.sampleIssues) {
    query.sampleIssues = Array.isArray(params.sampleIssues)
      ? params.sampleIssues.join(',')
      : params.sampleIssues
  }
  if (params.sampleLimit != null)
    query.sampleLimit = params.sampleLimit
  return query
}

export function createAnalyticsClient(options: AnalyticsClientOptions = {}): AnalyticsClient {
  const { request, shouldValidate } = createHostedRequester(options, { apiBase: '' })

  return {
    whoami() {
      return request<WhoamiResponse>(analyticsRoutes.whoami, {}, analyticsEndpointSchemas.analyticsWhoami.response)
    },
    listSites() {
      return request<SiteListItem[]>(analyticsRoutes.sites, {}, analyticsEndpointSchemas.analyticsSites.response)
    },
    getSourceInfo(siteId: string, options?: SourceInfoOptions) {
      return request<SourceInfoResponse>(analyticsRoutes.site.sourceInfo(siteId), { query: sourceInfoQuery(options) }, analyticsEndpointSchemas.analyticsSourceInfo.response)
    },
    getAnalysisSources(siteId: string, tables?: string[] | string | AnalysisSourcesOptions, options?: { searchType?: GscSearchType, start?: string, end?: string, startDate?: string, endDate?: string }) {
      return request<AnalysisSourcesResponse>(analyticsRoutes.site.analysisSources(siteId), { query: tablesQuery(tables, options) }, analyticsEndpointSchemas.analyticsAnalysisSources.response)
    },
    analyze<T = unknown>(siteId: string, params: unknown) {
      return request<T>(analyticsRoutes.site.analyze(siteId), { method: 'POST', body: withDefaultSearchType(params) })
    },
    queryRows<T = Record<string, unknown>>(siteId: string, state: unknown) {
      return request<GscRowQueryResponse<T>>(analyticsRoutes.site.rows(siteId), { method: 'POST', body: withDefaultSearchType(state) }, analyticsEndpointSchemas.analyticsRows.response)
    },
    getRollup<T = unknown>(siteId: string, rollupId: string, params?: { start?: string, end?: string }) {
      return request<RollupEnvelope<T>>(analyticsRoutes.site.rollup(siteId, rollupId), { query: params }, analyticsEndpointSchemas.analyticsRollup.response)
    },
    requestBackfill(siteId: string, range: BackfillRange) {
      const body = shouldValidate('request') ? analyticsEndpointSchemas.analyticsBackfill.body.parse(range) : range
      return request<BackfillResponse>(analyticsRoutes.site.backfill(siteId), { method: 'POST', body }, analyticsEndpointSchemas.analyticsBackfill.response)
    },
    getSitemaps(siteId: string) {
      return request<SitemapIndex>(analyticsRoutes.site.sitemaps(siteId), {}, analyticsEndpointSchemas.analyticsSitemaps.response)
    },
    getSitemapHistory(siteId: string, hash: string) {
      return request<SitemapHistoryResponse>(analyticsRoutes.site.sitemapHistory(siteId, hash), {}, analyticsEndpointSchemas.analyticsSitemapHistory.response)
    },
    getSitemapChanges(siteId: string, params: { days?: number } = {}) {
      return request<SitemapChangesResponse>(analyticsRoutes.site.sitemapChanges(siteId), { query: params }, analyticsEndpointSchemas.analyticsSitemapChanges.response)
    },
    getInspections(siteId: string) {
      return request<InspectionIndex>(analyticsRoutes.site.inspections(siteId), {}, analyticsEndpointSchemas.analyticsInspections.response)
    },
    getInspectionHistory(siteId: string, hash: string) {
      return request<InspectionHistoryResponse>(analyticsRoutes.site.inspectionHistory(siteId, hash), {}, analyticsEndpointSchemas.analyticsInspectionHistory.response)
    },
    getIndexingUrls(siteId: string, params = {}) {
      return request<IndexingUrlsResponse>(analyticsRoutes.site.indexingUrls(siteId), { query: indexingUrlsQuery(params) }, analyticsEndpointSchemas.analyticsIndexingUrls.response)
    },
    getIndexingDiagnostics(siteId: string, params: IndexingDiagnosticsParams = {}) {
      const parsed = shouldValidate('request') ? analyticsEndpointSchemas.analyticsIndexingDiagnostics.query.parse(params) : params
      return request<IndexingDiagnostics>(analyticsRoutes.site.indexingDiagnostics(siteId), { query: indexingDiagnosticsQuery(parsed) }, analyticsEndpointSchemas.analyticsIndexingDiagnostics.response)
    },
    requestIndexingInspect(siteId: string, body: IndexingInspectRequest) {
      const parsed = shouldValidate('request') ? analyticsEndpointSchemas.analyticsIndexingInspect.body.parse(body) : body
      return request<IndexingInspectResponse | IndexingInspectRateLimited>(analyticsRoutes.site.indexingInspect(siteId), { method: 'POST', body: parsed }, analyticsEndpointSchemas.analyticsIndexingInspect.response)
    },
    getCountries(siteId: string, range: { start: string, end: string }) {
      return request<CountriesResponse>(analyticsRoutes.site.countries(siteId), { query: range }, analyticsEndpointSchemas.analyticsCountries.response)
    },
    getSearchAppearance(siteId: string, range: { start: string, end: string }) {
      return request<SearchAppearanceResponse>(analyticsRoutes.site.searchAppearance(siteId), { query: range }, analyticsEndpointSchemas.analyticsSearchAppearance.response)
    },
  }
}
