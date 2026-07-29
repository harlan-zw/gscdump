import type {
  AnalysisSourcesResponse,
  BackfillRange,
  BackfillResponse,
  BulkFileResolutionRequest,
  BulkFileResolutionResponse,
  CountriesResponse,
  IndexingDiagnostics,
  IndexingDiagnosticsParams,
  IndexingInspectRateLimited,
  IndexingInspectRequest,
  IndexingInspectResponse,
  IndexingUrlsResponse,
  IndexingUrlStatus,
  InspectionHistoryResponse,
  InspectionIndex,
  QueryDimSourceResponse,
  RollupEnvelope,
  SearchAppearanceResponse,
  SiteListItem,
  SourceInfoOptions,
  SourceInfoResponse,
  WhoamiResponse,
} from '@gscdump/contracts'
import type { AnalysisSourcesOptions, SearchTypeOptions, SourceRangeOptions } from './hosted-query'
import type { HostedClientOptions, HostedFetch, HostedFetchOptions, HostedHeaders } from './request'
import { analyticsEndpoints } from '@gscdump/contracts/analytics'
import {
  indexingDiagnosticsQuery,
  indexingUrlsQuery,
  sourceInfoQuery,
  tablesQuery,
  withDefaultSearchType,
} from './hosted-query'
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

/** Hosted analytics transport exposed by `@gscdump/sdk`. */
export interface AnalyticsClient {
  whoami: () => Promise<WhoamiResponse>
  listSites: () => Promise<SiteListItem[]>
  getBulkSources: (params: BulkFileResolutionRequest) => Promise<BulkFileResolutionResponse>
  getSourceInfo: (siteId: string, options?: SourceInfoOptions) => Promise<SourceInfoResponse>
  getAnalysisSources: (siteId: string, tables?: string[] | string | AnalysisSourcesOptions, options?: SearchTypeOptions & SourceRangeOptions) => Promise<AnalysisSourcesResponse>
  getQueryDimSource: (siteId: string) => Promise<QueryDimSourceResponse>
  analyze: <T = unknown>(siteId: string, params: unknown) => Promise<T>
  getRollup: <T = unknown>(siteId: string, rollupId: string, params?: { start?: string, end?: string }) => Promise<RollupEnvelope<T>>
  requestBackfill: (siteId: string, range: BackfillRange) => Promise<BackfillResponse>
  getInspections: (siteId: string) => Promise<InspectionIndex>
  getInspectionHistory: (siteId: string, hash: string) => Promise<InspectionHistoryResponse>
  getIndexingUrls: (siteId: string, params?: { limit?: number, offset?: number, status?: IndexingUrlStatus, issue?: string, search?: string }) => Promise<IndexingUrlsResponse>
  getIndexingDiagnostics: (siteId: string, params?: IndexingDiagnosticsParams) => Promise<IndexingDiagnostics>
  requestIndexingInspect: (siteId: string, body: IndexingInspectRequest) => Promise<IndexingInspectResponse | IndexingInspectRateLimited>
  getCountries: (siteId: string, range: { start: string, end: string }) => Promise<CountriesResponse>
  getSearchAppearance: (siteId: string, range: { start: string, end: string }) => Promise<SearchAppearanceResponse>
}

export function createAnalyticsClient(options: AnalyticsClientOptions = {}): AnalyticsClient {
  const { request, shouldValidate } = createHostedRequester(options, { apiBase: '' })

  return {
    whoami() {
      const endpoint = analyticsEndpoints.whoami
      return request<WhoamiResponse>(endpoint.path, { method: endpoint.method }, endpoint.response)
    },
    listSites() {
      const endpoint = analyticsEndpoints.listSites
      return request<SiteListItem[]>(endpoint.path, { method: endpoint.method }, endpoint.response)
    },
    getBulkSources(params: BulkFileResolutionRequest) {
      const endpoint = analyticsEndpoints.getBulkSources
      const { siteIds, tables, ...options } = params
      const query = tablesQuery(tables, options)
      if (siteIds?.length)
        query.siteIds = [...new Set(siteIds.filter(Boolean))].join(',')
      return request<BulkFileResolutionResponse>(endpoint.path, { method: endpoint.method, query }, endpoint.response)
    },
    getSourceInfo(siteId: string, options?: SourceInfoOptions) {
      const endpoint = analyticsEndpoints.getSourceInfo
      return request<SourceInfoResponse>(endpoint.path(siteId), { method: endpoint.method, query: sourceInfoQuery(options) }, endpoint.response)
    },
    getAnalysisSources(siteId: string, tables?: string[] | string | AnalysisSourcesOptions, options?: SearchTypeOptions & SourceRangeOptions) {
      const endpoint = analyticsEndpoints.getAnalysisSources
      return request<AnalysisSourcesResponse>(endpoint.path(siteId), { method: endpoint.method, query: tablesQuery(tables, options) }, endpoint.response)
    },
    getQueryDimSource(siteId: string) {
      const endpoint = analyticsEndpoints.getQueryDimSource
      return request<QueryDimSourceResponse>(endpoint.path(siteId), { method: endpoint.method }, endpoint.response)
    },
    analyze<T = unknown>(siteId: string, params: unknown) {
      const endpoint = analyticsEndpoints.analyze
      return request<T>(endpoint.path(siteId), { method: endpoint.method, body: withDefaultSearchType(params), dedupe: true })
    },
    getRollup<T = unknown>(siteId: string, rollupId: string, params?: { start?: string, end?: string }) {
      const endpoint = analyticsEndpoints.getRollup
      return request<RollupEnvelope<T>>(endpoint.path(siteId, rollupId), { method: endpoint.method, query: params }, endpoint.response)
    },
    requestBackfill(siteId: string, range: BackfillRange) {
      const endpoint = analyticsEndpoints.requestBackfill
      const body = shouldValidate('request') ? endpoint.body.parse(range) : range
      return request<BackfillResponse>(endpoint.path(siteId), { method: endpoint.method, body }, endpoint.response)
    },
    getInspections(siteId: string) {
      const endpoint = analyticsEndpoints.getInspections
      return request<InspectionIndex>(endpoint.path(siteId), { method: endpoint.method }, endpoint.response)
    },
    getInspectionHistory(siteId: string, hash: string) {
      const endpoint = analyticsEndpoints.getInspectionHistory
      return request<InspectionHistoryResponse>(endpoint.path(siteId, hash), { method: endpoint.method }, endpoint.response)
    },
    getIndexingUrls(siteId: string, params = {}) {
      const endpoint = analyticsEndpoints.getIndexingUrls
      return request<IndexingUrlsResponse>(endpoint.path(siteId), { method: endpoint.method, query: indexingUrlsQuery(params) }, endpoint.response)
    },
    getIndexingDiagnostics(siteId: string, params: IndexingDiagnosticsParams = {}) {
      const endpoint = analyticsEndpoints.getIndexingDiagnostics
      const parsed = shouldValidate('request') ? endpoint.query.parse(params) : params
      return request<IndexingDiagnostics>(endpoint.path(siteId), { method: endpoint.method, query: indexingDiagnosticsQuery(parsed) }, endpoint.response)
    },
    requestIndexingInspect(siteId: string, body: IndexingInspectRequest) {
      const endpoint = analyticsEndpoints.requestIndexingInspect
      const parsed = shouldValidate('request') ? endpoint.body.parse(body) : body
      return request<IndexingInspectResponse | IndexingInspectRateLimited>(endpoint.path(siteId), { method: endpoint.method, body: parsed }, endpoint.response)
    },
    getCountries(siteId: string, range: { start: string, end: string }) {
      const endpoint = analyticsEndpoints.getCountries
      return request<CountriesResponse>(endpoint.path(siteId), { method: endpoint.method, query: range }, endpoint.response)
    },
    getSearchAppearance(siteId: string, range: { start: string, end: string }) {
      const endpoint = analyticsEndpoints.getSearchAppearance
      return request<SearchAppearanceResponse>(endpoint.path(siteId), { method: endpoint.method, query: range }, endpoint.response)
    },
  }
}
