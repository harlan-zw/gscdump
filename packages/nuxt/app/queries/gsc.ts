import type { BackfillRange, GscdumpTopAssociationParams, IndexingInspectRequest, SourceInfoOptions } from '@gscdump/contracts'
import type { AnalysisParams } from '@gscdump/engine/analysis-types'
import { analyticsRoutes, partnerEndpointSchemas } from '@gscdump/contracts'
import { defineNuxtQueryGroup, defineNuxtRpcMutation, defineNuxtRpcQuery } from 'nuxt-use-query/rpc'
import { z } from 'zod'

const DEFAULT_SEARCH_TYPE = 'web'

type SearchType = NonNullable<SourceInfoOptions['searchType']>
interface DateRange { start: string, end: string }
interface AnalysisSourcesOptions {
  tables?: string[] | string
  searchType?: SearchType
  start?: string
  end?: string
  startDate?: string
  endDate?: string
}

function searchTypeQuery(searchType?: SearchType): Record<string, string> {
  return { searchType: searchType ?? DEFAULT_SEARCH_TYPE }
}

function dateRangeQuery(options: { start?: string, end?: string, startDate?: string, endDate?: string } | undefined): Record<string, string> {
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
    ...dateRangeQuery(options),
  }
}

function tablesQuery(
  tablesOrOptions: string[] | string | AnalysisSourcesOptions | undefined,
  options?: { searchType?: SearchType, start?: string, end?: string, startDate?: string, endDate?: string },
): Record<string, string> {
  const isOptions = !!tablesOrOptions && typeof tablesOrOptions === 'object' && !Array.isArray(tablesOrOptions)
  const source = isOptions ? tablesOrOptions : options
  const tables = isOptions ? tablesOrOptions.tables : tablesOrOptions
  const query = {
    ...searchTypeQuery(source?.searchType),
    ...dateRangeQuery(source),
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
    searchType: (value as { searchType?: SearchType }).searchType ?? DEFAULT_SEARCH_TYPE,
  } as T
}

export const gscQueries = defineNuxtQueryGroup('gsc', {
  whoami: () => defineNuxtRpcQuery({
    key: ['gsc', 'whoami'],
    path: analyticsRoutes.whoami,
    response: partnerEndpointSchemas.analyticsWhoami.response,
  }),
  sites: () => defineNuxtRpcQuery({
    key: ['gsc', 'sites'],
    path: analyticsRoutes.sites,
    response: partnerEndpointSchemas.analyticsSites.response,
  }),
  sourceInfo: (siteId: string, options?: SourceInfoOptions) => defineNuxtRpcQuery({
    key: ['gsc', 'source-info', siteId, options?.searchType ?? DEFAULT_SEARCH_TYPE, options?.start ?? options?.startDate ?? '', options?.end ?? options?.endDate ?? ''],
    path: analyticsRoutes.site.sourceInfo(siteId),
    query: sourceInfoQuery(options),
    response: partnerEndpointSchemas.analyticsSourceInfo.response,
  }),
  analysisSources: (
    siteId: string,
    tables?: string[] | string | AnalysisSourcesOptions,
    options?: { searchType?: SearchType, start?: string, end?: string, startDate?: string, endDate?: string },
  ) => defineNuxtRpcQuery({
    key: ['gsc', 'analysis-sources', siteId, JSON.stringify(tables ?? null), JSON.stringify(options ?? null)],
    path: analyticsRoutes.site.analysisSources(siteId),
    query: tablesQuery(tables, options),
    response: partnerEndpointSchemas.analyticsAnalysisSources.response,
  }),
  analyze: (siteId: string) => defineNuxtRpcMutation({
    body: z.custom<AnalysisParams>(value => !!value && typeof value === 'object' && !Array.isArray(value)),
    method: 'POST',
    path: analyticsRoutes.site.analyze(siteId),
    response: z.unknown(),
  }),
  backfill: (siteId: string) => defineNuxtRpcMutation({
    body: partnerEndpointSchemas.analyticsBackfill.body,
    method: 'POST',
    path: analyticsRoutes.site.backfill(siteId),
    response: partnerEndpointSchemas.analyticsBackfill.response,
  }),
  sitemaps: (siteId: string) => defineNuxtRpcQuery({
    key: ['gsc', 'sitemaps', siteId],
    path: analyticsRoutes.site.sitemaps(siteId),
    response: partnerEndpointSchemas.analyticsSitemaps.response,
  }),
  sitemapHistory: (siteId: string, hash: string) => defineNuxtRpcQuery({
    key: ['gsc', 'sitemap-history', siteId, hash],
    path: analyticsRoutes.site.sitemapHistory(siteId, hash),
    response: partnerEndpointSchemas.analyticsSitemapHistory.response,
  }),
  inspections: (siteId: string) => defineNuxtRpcQuery({
    key: ['gsc', 'inspections', siteId],
    path: analyticsRoutes.site.inspections(siteId),
    response: partnerEndpointSchemas.analyticsInspections.response,
  }),
  inspectionHistory: (siteId: string, hash: string) => defineNuxtRpcQuery({
    key: ['gsc', 'inspection-history', siteId, hash],
    path: analyticsRoutes.site.inspectionHistory(siteId, hash),
    response: partnerEndpointSchemas.analyticsInspectionHistory.response,
  }),
  indexingInspect: (siteId: string) => defineNuxtRpcMutation({
    body: partnerEndpointSchemas.analyticsIndexingInspect.body,
    method: 'POST',
    path: analyticsRoutes.site.indexingInspect(siteId),
    response: partnerEndpointSchemas.analyticsIndexingInspect.response,
  }),
  countries: (siteId: string, range: DateRange) => defineNuxtRpcQuery({
    key: ['gsc', 'countries', siteId, range.start, range.end],
    path: analyticsRoutes.site.countries(siteId),
    query: range,
    response: partnerEndpointSchemas.analyticsCountries.response,
  }),
  searchAppearance: (siteId: string, range: DateRange) => defineNuxtRpcQuery({
    key: ['gsc', 'search-appearance', siteId, range.start, range.end],
    path: analyticsRoutes.site.searchAppearance(siteId),
    query: range,
    response: partnerEndpointSchemas.analyticsSearchAppearance.response,
  }),
  rollup: (siteId: string, rollupId: string, range?: Partial<DateRange>) => defineNuxtRpcQuery({
    key: ['gsc', 'rollup', siteId, rollupId, range?.start ?? '', range?.end ?? ''],
    path: analyticsRoutes.site.rollup(siteId, rollupId),
    query: range,
    response: partnerEndpointSchemas.analyticsRollup.response,
  }),
  topAssociation: (siteId: string, query: GscdumpTopAssociationParams) => defineNuxtRpcQuery({
    key: ['gsc', 'top-association', siteId, query.type, query.identifier, query.startDate, query.endDate],
    path: `/api/__gsc/sites/${encodeURIComponent(siteId)}/data/top-association`,
    query,
    response: partnerEndpointSchemas.getTopAssociation.response,
  }),
  syncProgress: () => defineNuxtRpcQuery({
    key: ['gsc', 'sync-progress'],
    path: '/api/sync-progress',
    response: partnerEndpointSchemas.appSyncProgress.response,
  }),
})

export function withDefaultGscSearchType(params: AnalysisParams): AnalysisParams {
  return withDefaultSearchType(params)
}

export type GscIndexingInspectBody = IndexingInspectRequest
export type GscBackfillBody = BackfillRange
