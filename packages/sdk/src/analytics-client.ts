import type {
  AnalyticsClient,
  AnalysisSourcesResponse,
  BackfillRange,
  BackfillResponse,
  GscRowQueryResponse,
  IndexingDiagnostics,
  IndexingUrlStatus,
  IndexingUrlsResponse,
  InspectionHistoryResponse,
  InspectionIndex,
  RollupEnvelope,
  SiteListItem,
  SitemapChangesResponse,
  SitemapHistoryResponse,
  SitemapIndex,
  SourceInfoResponse,
  WhoamiResponse,
} from '@gscdump/contracts'
import { analyticsRoutes, partnerEndpointSchemas } from '@gscdump/contracts'
import { ofetch } from 'ofetch'
import type { ZodTypeAny } from 'zod'
import { toPartnerError } from './errors'
import type { PartnerFetch, PartnerFetchOptions, PartnerHeaders } from './client'

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

function tablesQuery(tables: string[] | string | undefined): Record<string, string> | undefined {
  if (!tables)
    return undefined
  return { tables: Array.isArray(tables) ? tables.join(',') : tables }
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
    getSourceInfo(siteId: string) {
      return request<SourceInfoResponse>(analyticsRoutes.site.sourceInfo(siteId), {}, partnerEndpointSchemas.analyticsSourceInfo.response)
    },
    getAnalysisSources(siteId: string, tables?: string[] | string) {
      return request<AnalysisSourcesResponse>(analyticsRoutes.site.analysisSources(siteId), { query: tablesQuery(tables) }, partnerEndpointSchemas.analyticsAnalysisSources.response)
    },
    analyze<T = unknown>(siteId: string, params: unknown) {
      return request<T>(analyticsRoutes.site.analyze(siteId), { method: 'POST', body: params })
    },
    queryRows<T = Record<string, unknown>>(siteId: string, state: unknown) {
      return request<GscRowQueryResponse<T>>(analyticsRoutes.site.rows(siteId), { method: 'POST', body: state }, partnerEndpointSchemas.analyticsRows.response)
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
  }
}
