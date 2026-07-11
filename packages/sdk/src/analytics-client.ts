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
    getSourceInfo(siteId: string, options?: SourceInfoOptions) {
      const endpoint = analyticsEndpoints.getSourceInfo
      return request<SourceInfoResponse>(endpoint.path(siteId), { method: endpoint.method, query: sourceInfoQuery(options) }, endpoint.response)
    },
    getAnalysisSources(siteId: string, tables?: string[] | string | AnalysisSourcesOptions, options?: SearchTypeOptions & SourceRangeOptions) {
      const endpoint = analyticsEndpoints.getAnalysisSources
      return request<AnalysisSourcesResponse>(endpoint.path(siteId), { method: endpoint.method, query: tablesQuery(tables, options) }, endpoint.response)
    },
    analyze<T = unknown>(siteId: string, params: unknown) {
      const endpoint = analyticsEndpoints.analyze
      return request<T>(endpoint.path(siteId), { method: endpoint.method, body: withDefaultSearchType(params), dedupe: true })
    },
    queryRows<T = Record<string, unknown>>(siteId: string, state: unknown) {
      const endpoint = analyticsEndpoints.queryRows
      return request<GscRowQueryResponse<T>>(endpoint.path(siteId), { method: endpoint.method, body: withDefaultSearchType(state), dedupe: true }, endpoint.response)
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
    getSitemaps(siteId: string) {
      const endpoint = analyticsEndpoints.getSitemaps
      return request<SitemapIndex>(endpoint.path(siteId), { method: endpoint.method }, endpoint.response)
    },
    getSitemapHistory(siteId: string, hash: string) {
      const endpoint = analyticsEndpoints.getSitemapHistory
      return request<SitemapHistoryResponse>(endpoint.path(siteId, hash), { method: endpoint.method }, endpoint.response)
    },
    getSitemapChanges(siteId: string, params: { days?: number } = {}) {
      const endpoint = analyticsEndpoints.getSitemapChanges
      return request<SitemapChangesResponse>(endpoint.path(siteId), { method: endpoint.method, query: params }, endpoint.response)
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
