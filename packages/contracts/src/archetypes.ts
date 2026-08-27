import type { GscSearchType } from './search-types'
import type { BuilderStateWire, Dimension, Metric } from './types'

export type QueryArchetype
  = | 'site-daily-timeseries'
    | 'entity-daily-timeseries'
    | 'entity-daily-sparkline'
    | 'top-n-breakdown'
    | 'single-row-lookup'
    | 'multi-series-stacked-daily'
    | 'two-dimension-detail'
    | 'arbitrary-sql'
    | 'aux-cloud-only'

export type ArchetypeExecutionClass = 'r2-sql' | 'r2-sql-resolved' | 'duckdb' | 'cloud-only'

export const ARCHETYPE_EXECUTION_CLASS: Record<QueryArchetype, ArchetypeExecutionClass> = {
  'site-daily-timeseries': 'r2-sql',
  'entity-daily-timeseries': 'r2-sql-resolved',
  'entity-daily-sparkline': 'r2-sql-resolved',
  'top-n-breakdown': 'r2-sql-resolved',
  'single-row-lookup': 'r2-sql',
  'multi-series-stacked-daily': 'r2-sql',
  'two-dimension-detail': 'r2-sql',
  'arbitrary-sql': 'duckdb',
  'aux-cloud-only': 'cloud-only',
}

export interface DateRange {
  start: string
  end: string
}

export interface ArchetypeFacet {
  column: Dimension
  op: 'eq' | 'regex' | 'notRegex'
  value: string
}

export interface ArchetypeQueryBase {
  archetype: QueryArchetype
  siteId: string
  searchType: GscSearchType
  range: DateRange
  compareRange?: DateRange
  facets?: readonly ArchetypeFacet[]
}

export interface SiteDailyTimeseriesQuery extends ArchetypeQueryBase {
  archetype: 'site-daily-timeseries'
  metrics: readonly Metric[]
}

export interface EntityDailyTimeseriesQuery extends ArchetypeQueryBase {
  archetype: 'entity-daily-timeseries'
  entity: { dimension: Extract<Dimension, 'page' | 'query' | 'queryCanonical'>, value: string }
  metrics: readonly Metric[]
}

export interface EntityDailySparklineQuery extends ArchetypeQueryBase {
  archetype: 'entity-daily-sparkline'
  dimension: Extract<Dimension, 'page' | 'query' | 'queryCanonical'>
  entities: readonly string[]
  metric: Metric
}

export interface TopNBreakdownQuery extends ArchetypeQueryBase {
  archetype: 'top-n-breakdown'
  dimension: Dimension
  metrics: readonly Metric[]
  orderBy: { metric: Metric, dir: 'asc' | 'desc' }
  limit: number
  offset?: number
  includeTotal?: boolean
  movers?: 'improving' | 'declining' | 'new' | 'lost'
}

export interface SingleRowLookupQuery extends ArchetypeQueryBase {
  archetype: 'single-row-lookup'
  match: Partial<Record<Dimension, string>>
  metrics: readonly Metric[]
}

export interface MultiSeriesStackedDailyQuery extends ArchetypeQueryBase {
  archetype: 'multi-series-stacked-daily'
  seriesDimension: Dimension
  metric: Metric
}

export interface TwoDimensionDetailQuery extends ArchetypeQueryBase {
  archetype: 'two-dimension-detail'
  metrics: readonly Metric[]
  filter?: { page?: string, query?: string }
  orderBy?: { metric: Metric, dir: 'asc' | 'desc' }
  limit?: number
}

export interface ArbitrarySqlQuery extends ArchetypeQueryBase {
  archetype: 'arbitrary-sql'
  sql: string
  params?: readonly unknown[]
}

export interface AuxCloudOnlyQuery {
  archetype: 'aux-cloud-only'
  siteId: string
  dataset: 'canonicals' | 'sitemaps' | 'indexing'
  params?: Record<string, unknown>
}

export type ArchetypeQuery
  = | SiteDailyTimeseriesQuery
    | EntityDailyTimeseriesQuery
    | EntityDailySparklineQuery
    | TopNBreakdownQuery
    | SingleRowLookupQuery
    | MultiSeriesStackedDailyQuery
    | TwoDimensionDetailQuery
    | ArbitrarySqlQuery
    | AuxCloudOnlyQuery

/** Date window accepted by the portable archetype constructors. */
export interface WireDateRange {
  start: string
  end: string
}

const ARCHETYPE_METRICS: readonly Metric[] = ['clicks', 'impressions', 'ctr', 'position']

function archetypeRange(range: WireDateRange): DateRange {
  return { start: range.start, end: range.end }
}

/** Portable constructors for the canonical hosted/browser archetype wire shapes. */
export function siteDailyTimeseries(
  siteId: string,
  range: WireDateRange,
  options: { searchType?: GscSearchType, compareRange?: WireDateRange, metrics?: readonly Metric[] } = {},
): SiteDailyTimeseriesQuery {
  return {
    archetype: 'site-daily-timeseries',
    siteId,
    searchType: options.searchType ?? 'web',
    range: archetypeRange(range),
    ...(options.compareRange ? { compareRange: archetypeRange(options.compareRange) } : {}),
    metrics: options.metrics ?? ARCHETYPE_METRICS,
  }
}

export function entityDailyTimeseries(
  siteId: string,
  range: WireDateRange,
  entity: EntityDailyTimeseriesQuery['entity'],
  options: { searchType?: GscSearchType, compareRange?: WireDateRange, metrics?: readonly Metric[] } = {},
): EntityDailyTimeseriesQuery {
  return {
    archetype: 'entity-daily-timeseries',
    siteId,
    searchType: options.searchType ?? 'web',
    range: archetypeRange(range),
    ...(options.compareRange ? { compareRange: archetypeRange(options.compareRange) } : {}),
    entity,
    metrics: options.metrics ?? ARCHETYPE_METRICS,
  }
}

export function entityDailySparkline(
  siteId: string,
  range: WireDateRange,
  dimension: EntityDailySparklineQuery['dimension'],
  entities: readonly string[],
  options: { searchType?: GscSearchType, metric?: Metric } = {},
): EntityDailySparklineQuery {
  return {
    archetype: 'entity-daily-sparkline',
    siteId,
    searchType: options.searchType ?? 'web',
    range: archetypeRange(range),
    dimension,
    entities: [...entities],
    metric: options.metric ?? 'clicks',
  }
}

export interface TopNBreakdownOptions {
  searchType?: GscSearchType
  compareRange?: WireDateRange
  metrics?: readonly Metric[]
  orderBy?: TopNBreakdownQuery['orderBy']
  limit?: number
  offset?: number
  facets?: readonly ArchetypeFacet[]
  includeTotal?: boolean
  movers?: NonNullable<TopNBreakdownQuery['movers']>
}

export function topNBreakdown(
  siteId: string,
  range: WireDateRange,
  dimension: Dimension,
  options: TopNBreakdownOptions = {},
): TopNBreakdownQuery {
  return {
    archetype: 'top-n-breakdown',
    siteId,
    searchType: options.searchType ?? 'web',
    range: archetypeRange(range),
    ...(options.compareRange ? { compareRange: archetypeRange(options.compareRange) } : {}),
    dimension,
    metrics: options.metrics ?? ARCHETYPE_METRICS,
    orderBy: options.orderBy ?? { metric: 'clicks', dir: 'desc' },
    limit: options.limit ?? 50,
    ...(options.offset ? { offset: options.offset } : {}),
    ...(options.facets?.length ? { facets: options.facets } : {}),
    ...(options.includeTotal ? { includeTotal: true } : {}),
    ...(options.movers ? { movers: options.movers } : {}),
  }
}

export function singleRowLookup(
  siteId: string,
  range: WireDateRange,
  match: SingleRowLookupQuery['match'],
  options: { searchType?: GscSearchType, compareRange?: WireDateRange, metrics?: readonly Metric[] } = {},
): SingleRowLookupQuery {
  return {
    archetype: 'single-row-lookup',
    siteId,
    searchType: options.searchType ?? 'web',
    range: archetypeRange(range),
    ...(options.compareRange ? { compareRange: archetypeRange(options.compareRange) } : {}),
    match,
    metrics: options.metrics ?? ARCHETYPE_METRICS,
  }
}

export function multiSeriesStackedDaily(
  siteId: string,
  range: WireDateRange,
  seriesDimension: Dimension,
  options: { searchType?: GscSearchType, compareRange?: WireDateRange, metric?: Metric } = {},
): MultiSeriesStackedDailyQuery {
  return {
    archetype: 'multi-series-stacked-daily',
    siteId,
    searchType: options.searchType ?? 'web',
    range: archetypeRange(range),
    ...(options.compareRange ? { compareRange: archetypeRange(options.compareRange) } : {}),
    seriesDimension,
    metric: options.metric ?? 'clicks',
  }
}

export interface TwoDimensionDetailOptions {
  searchType?: GscSearchType
  compareRange?: WireDateRange
  metrics?: readonly Metric[]
  filter?: TwoDimensionDetailQuery['filter']
  orderBy?: TwoDimensionDetailQuery['orderBy']
  limit?: number
  facets?: readonly ArchetypeFacet[]
}

export function twoDimensionDetail(
  siteId: string,
  range: WireDateRange,
  options: TwoDimensionDetailOptions = {},
): TwoDimensionDetailQuery {
  return {
    archetype: 'two-dimension-detail',
    siteId,
    searchType: options.searchType ?? 'web',
    range: archetypeRange(range),
    ...(options.compareRange ? { compareRange: archetypeRange(options.compareRange) } : {}),
    metrics: options.metrics ?? ARCHETYPE_METRICS,
    ...(options.filter ? { filter: options.filter } : {}),
    ...(options.orderBy ? { orderBy: options.orderBy } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.facets?.length ? { facets: options.facets } : {}),
  }
}

export function arbitrarySql(
  siteId: string,
  range: WireDateRange,
  sql: string,
  options: { searchType?: GscSearchType, params?: readonly unknown[], cacheable?: boolean } = {},
): ArbitrarySqlQuery & { cacheable?: true } {
  return {
    archetype: 'arbitrary-sql',
    siteId,
    searchType: options.searchType ?? 'web',
    range: archetypeRange(range),
    sql,
    ...(options.params ? { params: options.params } : {}),
    ...(options.cacheable ? { cacheable: true as const } : {}),
  }
}

export type ArchetypeResultRow = Record<string, string | number | null>

export type ArchetypeResultSource = 'browser' | 'server-r2-sql' | 'server-duckdb' | 'cloud'

export interface ArchetypeResult<R extends ArchetypeResultRow = ArchetypeResultRow> {
  archetype: QueryArchetype
  rows: R[]
  source: ArchetypeResultSource
  meta?: {
    rowCount: number
    queryMs: number
    totalRows?: number
    compareRows?: R[]
    truncated?: boolean
  }
}

export interface ResolvedArchetypeQuery {
  query: ArchetypeQuery
  builder?: BuilderStateWire
  executionClass: ArchetypeExecutionClass
}
