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
import { analyticsEndpointSchemas, analyticsRoutes } from '@gscdump/contracts/analytics'
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
      return request<WhoamiResponse>(analyticsRoutes.whoami, {}, analyticsEndpointSchemas.analyticsWhoami.response)
    },
    listSites() {
      return request<SiteListItem[]>(analyticsRoutes.sites, {}, analyticsEndpointSchemas.analyticsSites.response)
    },
    getSourceInfo(siteId: string, options?: SourceInfoOptions) {
      return request<SourceInfoResponse>(analyticsRoutes.site.sourceInfo(siteId), { query: sourceInfoQuery(options) }, analyticsEndpointSchemas.analyticsSourceInfo.response)
    },
    getAnalysisSources(siteId: string, tables?: string[] | string | AnalysisSourcesOptions, options?: SearchTypeOptions & SourceRangeOptions) {
      return request<AnalysisSourcesResponse>(analyticsRoutes.site.analysisSources(siteId), { query: tablesQuery(tables, options) }, analyticsEndpointSchemas.analyticsAnalysisSources.response)
    },
    analyze<T = unknown>(siteId: string, params: unknown) {
      return request<T>(analyticsRoutes.site.analyze(siteId), { method: 'POST', body: withDefaultSearchType(params), dedupe: true })
    },
    queryRows<T = Record<string, unknown>>(siteId: string, state: unknown) {
      return request<GscRowQueryResponse<T>>(analyticsRoutes.site.rows(siteId), { method: 'POST', body: withDefaultSearchType(state), dedupe: true }, analyticsEndpointSchemas.analyticsRows.response)
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
