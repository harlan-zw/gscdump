import type { BuilderState, Dimension, GscSearchType, Metric } from './types'

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
  builder?: BuilderState
  executionClass: ArchetypeExecutionClass
}
